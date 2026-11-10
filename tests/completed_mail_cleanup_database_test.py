"""Completed inbox cleanup approval, privacy and preservation guards.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/completed_mail_cleanup_database_test.py
"""
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-public-projection-',dir='/tmp') as folder:
    data=Path(folder)/'data'
    subprocess.run([str(BIN/'initdb'),'-D',str(data),'-A','trust','--no-locale','--encoding=UTF8'],check=True,capture_output=True)
    def pg(*args):
        return subprocess.run([str(BIN/'pg_ctl'),'-D',str(data),*args],check=True,capture_output=True)
    started=False
    try:
        pg('-l',str(Path(folder)/'postgres.log'),'-o',f"-F -h '' -k {folder}",'-w','start');started=True
        serial=0
        def sql(query,uid=None,error=None):
            global serial
            serial+=1
            path=Path(folder)/f'query-{serial}.sql'
            path.write_text((f"set request.jwt.claim.sub='{uid}';\n" if uid else '')+query)
            r=subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-f',str(path)],capture_output=True,text=True)
            if error:
                assert r.returncode and error.lower() in r.stderr.lower(),r.stderr
            else: assert r.returncode==0,r.stderr
            return r.stdout.strip()
        def lit(value): return "'"+value.replace("'","''")+"'"
        sql('''create role anon;create role authenticated;create role service_role bypassrls;
            create schema auth;
            create table auth.users(id uuid primary key,instance_id uuid,aud text,role text,email text unique,encrypted_password text,
                email_confirmed_at timestamptz,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}',
                is_super_admin boolean default false,created_at timestamptz,updated_at timestamptz,banned_until timestamptz,
                confirmation_token text,recovery_token text,email_change_token_current text,email_change_token_new text,email_change text,
                phone_change_token text,phone_change text,reauthentication_token text);
            create table auth.identities(id uuid primary key,provider_id text,user_id uuid references auth.users(id) on delete cascade,
                identity_data jsonb,provider text,created_at timestamptz,updated_at timestamptz);
            create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade);
            create table auth.mfa_amr_claims(id uuid primary key,session_id uuid references auth.sessions(id),authentication_method text,created_at timestamptz,updated_at timestamptz);
            create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
            grant usage on schema public,auth to anon,authenticated,service_role;
            grant execute on function auth.uid() to anon,authenticated;
        ''')
        sql("create schema storage; create table storage.buckets(id text primary key,public boolean); insert into storage.buckets values('creator-photos',false); create table storage.objects(bucket_id text,name text);")
        migrations=sorted([*ROOT.glob('supabase/migrations/*.sql'),*ROOT.glob('supabase/migrations/queue/*.sql')],key=lambda p:p.name)
        assert len({p.name for p in migrations})==len(migrations)
        
        read_probe="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','khub_bot') and p.prokind='f' and (p.proname like 'read_%' or p.proname in ('bot_tick','bot_finish_inbox_scan','finalize_auction','finalize_expired_auctions','bot_worker_status')) and p.proname<>'read_public_auction_live_batch';"""
        financial_probe="select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','khub_bot') and p.prokind='f' and p.proname ~ '^(bot_ingest|bot_claim|bot_ack|bot_prepare_buy_delivery|bot_dispatch_liabilities|bot_liabilities|finish_listing)';"
        for migration in migrations:
            if '252_completed_inbox' in migration.name or '253_remaining_mail' in migration.name: before_financial=sql(financial_probe)
            if '193_automatic' in migration.name: before_reads=sql(read_probe)
            sql(migration.read_text())
            if '252_completed_inbox' in migration.name or '253_remaining_mail' in migration.name: assert sql(financial_probe)==before_financial
            if '193_automatic' in migration.name:
                assert sql(read_probe)==before_reads, 'Relisting changed browsing, polling or finalization entry points'
        def receipt(mid,command='fill',result='accepted',gift=False):
            payload={'command':{'type':command},'raw':{'type':'normal'},'meat':100,'items':[{'id':2,'quantity':1}]}
            if gift:payload['raw']['gift_original']={}
            sql(f"insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result) values('{mid}',12345,now(),{lit(json.dumps(payload))},{lit(result)});")
        def delivery(mid,state='sent',kind='sale_item'):
            ident=str(uuid4())
            item='null' if kind=='notice' else '2'
            qty=0 if kind=='notice' else 1
            sql(f"insert into khub_bot.deliveries(id,dedupe_key,receipt_id,recipient_id,kind,meat,item_id,quantity,message,state) values('{ident}','fixture:{ident}','{mid}',12345,'{kind}',0,{item},{qty},'fixture','{state}');")
            return ident
        def approved(mid):return mid in json.loads(sql(f"set role service_role;select public.bot_mail_cleanup(array['{mid}']);"))
        def reject(mid):assert not approved(mid),mid
        receipt('1');delivery('1');assert approved('1')
        receipt('2','fund');delivery('2',kind='notice');assert approved('2')
        for i,state in enumerate(['pending','sending','unknown','cancelled'],10):
            receipt(str(i));delivery(str(i),state,'notice' if state=='cancelled' else 'sale_item');reject(str(i))
        receipt('20','fill','Wrong quantity');d=delivery('20','pending','refund');reject('20')
        sql(f"update khub_bot.deliveries set state='sent' where id='{d}';");assert approved('20')
        receipt('21');reject('21') # No evidence must not mean completion.
        receipt('22',gift=True);delivery('22');reject('22')
        receipt('23',result='processing');delivery('23');reject('23')
        receipt('24');delivery('24');sql("insert into khub_bot.mail_policy_reviews(receipt_id,reason) values('24','fixture');");reject('24')
        receipt('25');delivery('25');sql("insert into khub_bot.inbox_bid_mail(mail_id,payload,received_at) select mail_id,payload,received_at from khub_bot.receipts where mail_id='25';");reject('25')
        # Ordinary replies and seller payments both have to finish.
        receipt('26');delivery('26');d=delivery('26','unknown','notice');reject('26')
        sql(f"update khub_bot.deliveries set state='sent' where id='{d}';");assert approved('26')
        for mid,state in [('30','pending'),('31','done')]:
            receipt(mid,'credentials','account_rejected');delivery(mid,kind='notice')
            sql(f"insert into khub_bot.account_jobs(mail_id,kol_player_id,kol_name,user_id,username,login_email,action,state,temporary_password) values('{mid}',12345,'Fixture','{uuid4()}','Fixture{mid}','fixture{mid}@invalid.test','credentials','{state}',repeat('x',24));")
        reject('30');assert approved('31')
        receipt('32','register','account_ready');delivery('32',kind='notice');assert approved('32')
        receipt('40');source=delivery('40','cancelled','notice')
        target=delivery('40','pending');sql(f"update khub_bot.deliveries set receipt_id=null where id='{target}';")
        owner=str(uuid4());auction=str(uuid4());batch=str(uuid4())
        sql(f"set session_replication_role=replica;insert into auth.users(id,email) values('{owner}','cleanup@invalid.test');insert into public.profiles(id,khub_username) values('{owner}','Cleanup Fixture');")
        sql("insert into khub_bot.catalog(id,name,image,tradeable,is_current) values(2,'seal tooth','tooth.gif',true,true);")
        sql(f"insert into public.auctions(id,seller_id,seller_username,seller_kol_id,item,item_id,quantity,min_bid_meat,duration_hours,end_time,escrow_mode,status,auction_kind) values('{auction}','{owner}','Cleanup Fixture',12345,'seal tooth',2,100,100,24,now()+interval '1 day',true,'active','buy');")
        sql(f"insert into khub_bot.buy_orders(auction_id,delivery_mode,funding_required) values('{auction}','immediate',100);")
        sql(f"insert into khub_bot.buy_item_batches(id,auction_id,quantity,source_deliveries) values('{batch}','{auction}',1,'[]');insert into khub_bot.buy_item_batch_members(batch_id,source_id,delivery_id) values('{batch}','{source}','{target}');")
        reject('40')
        sql(f"update khub_bot.deliveries set state='unknown' where id='{target}';");reject('40')
        sql(f"update khub_bot.deliveries set state='sent' where id='{target}';");assert approved('40')
        assert sql(f"select status from public.auctions where id='{auction}';")=='active'
        # Linked fees still require verified movement, not a guessed cancellation.
        receipt('41');delivery('41')
        sql("insert into khub_bot.closet_transfers(dedupe_key,source,receipt_id,meat,state) values('cleanup-fee','sale_fee','41',1,'unknown');")
        reject('41');sql("update khub_bot.closet_transfers set state='moved' where receipt_id='41';");assert approved('41')
        receipt('42');held=delivery('42');sql(f"insert into khub_bot.delivery_preparation_reviews(delivery_id,error_code,reason) values('{held}','fixture','review');");reject('42')
        receipt('43','unknown','Unsupported funded command');delivery('43',kind='refund');assert approved('43')
        # Public callers cannot inspect private mail or approve deletion.
        sql("set role anon;select public.bot_mail_cleanup(array['1']);",error='permission denied')
        sql("set role authenticated;select public.bot_mail_cleanup(array['1']);",error='permission denied')
        assert sql('select count(*) from khub_bot.receipts;')=='20'
        # 253: synchronous account rejections have no account_jobs row.
        receipt('61','credentials','account_rejected');delivery('61',kind='notice');assert approved('61')
        # Completed legacy policy refunds can discard only known-unsent old plans.
        receipt('60','unknown','donation');refund=delivery('60','unknown','refund')
        sql(f"update khub_bot.deliveries set dedupe_key='policy-refund:60:1' where id='{refund}';")
        sql("insert into khub_bot.mail_policy_reviews(receipt_id,reason,refund_queued) values('60','old policy',true);")
        sql("insert into khub_bot.deliveries(dedupe_key,receipt_id,recipient_id,kind,message,state) values('donation-thanks:60:1','60',12345,'notice','obsolete','cancelled');")
        sql("insert into khub_bot.closet_transfers(dedupe_key,source,receipt_id,meat,state) values('old-donation','donation','60',1,'cancelled');")
        sql('select khub_bot.suppress_previous_donation_plans();')
        reject('60');sql(f"update khub_bot.deliveries set state='sent' where id='{refund}';")
        reject('60') # A partial refund is not full repayment.
        sql(f"update khub_bot.deliveries set meat=100 where id='{refund}';");assert approved('60')
        sql("insert into khub_bot.closet_transfers(dedupe_key,source,receipt_id,meat,state) values('unknown-policy-move','donation','60',1,'unknown');");reject('60')
        sql("update khub_bot.closet_transfers set state='moved' where dedupe_key='unknown-policy-move';");assert approved('60')
        # Raffle refund/advance messages do not depend on the raffle ending.
        receipt('62','raffle','raffle_refund');d=delivery('62','pending','refund');reject('62')
        sql(f"update khub_bot.deliveries set state='sent' where id='{d}';");assert approved('62')
        receipt('63','raffle_advance','raffle_advance');delivery('63');assert approved('63')
        rid=str(uuid4())
        sql(f"insert into public.mystery_raffles(id,creator_id,name,ticket_price,ends_at) values('{rid}','{owner}','Fixture raffle',100,now()+interval '1 day');insert into khub_bot.raffle_accounts(raffle_id,admin_player_id) values('{rid}',12345);")
        receipt('64','raffle','raffle_tickets');delivery('64',kind='notice')
        sql(f"insert into khub_bot.raffle_purchases(receipt_id,raffle_id,player_id,meat,first_ticket,last_ticket,received_at) values('64','{rid}',12345,100,1,1,now());")
        receipt('65','raffle_supply','raffle_supply');delivery('65',kind='notice')
        sql(f"insert into khub_bot.raffle_deposits(receipt_id,raffle_id,items,received_at) values('65','{rid}','[]',now());")
        reject('64');reject('65')
        sql(f"update public.mystery_raffles set state='settled' where id='{rid}';update khub_bot.raffle_accounts set settlement_queued=true where raffle_id='{rid}';")
        assert approved('64');assert approved('65')
        sql(f"insert into khub_bot.raffle_inventory(raffle_id,item_id,quantity) values('{rid}',2,1);");reject('64');reject('65')
        sql(f"update khub_bot.raffle_inventory set quantity=0 where raffle_id='{rid}';")
        pending=delivery('65','unknown');sql(f"update khub_bot.deliveries set receipt_id=null,dedupe_key='raffle:{rid}:return:2' where id='{pending}';")
        reject('64');reject('65');sql(f"update khub_bot.deliveries set state='sent' where id='{pending}';")
        assert approved('64');assert approved('65')
        # Exact fresh opened-envelope matching is mandatory, including operator returns.
        receipt('50','fill','Gift return queued by operator.',gift=True);d=delivery('50','unknown','refund')
        raw={'id':'50','fromid':'12345','type':'giftshop','message':'opened original'}
        sql("update khub_bot.receipts set payload=jsonb_set(payload,'{raw,gift_original}',"+lit(json.dumps(raw))+"::jsonb) where mail_id='50';")
        sql("insert into khub_bot.incoming_gifts(mail_id,wrapper_id,envelope,payload,opened_at) select '50',1167,'{}',payload,now() from khub_bot.receipts where mail_id='50';")
        def gift_ok(value=raw):return '50' in json.loads(sql("set role service_role;select public.bot_gift_mail_cleanup("+lit(json.dumps([value]))+');'))
        reject('50');assert not gift_ok()
        sql("insert into khub_bot.gift_verified_contents(mail_id,snapshot) values('50','{}');")
        assert not gift_ok();sql(f"update khub_bot.deliveries set state='sent' where id='{d}';");assert gift_ok()
        assert not gift_ok({**raw,'message':'changed envelope'})
        sql("insert into khub_bot.gift_mail_reviews(mail_id,raw,evidence) values('50','{}','fixture');");assert not gift_ok()
        sql("update khub_bot.gift_mail_reviews set resolved_at=now() where mail_id='50';");assert gift_ok()
        attempt=str(uuid4());sql(f"insert into khub_bot.gift_open_attempts(id,wrapper_id,before_state) values('{attempt}',1167,'{{}}');");assert not gift_ok()
        sql(f"update khub_bot.gift_open_attempts set state='isolated' where id='{attempt}';");assert not gift_ok()
        sql(f"update khub_bot.gift_open_attempts set state='verified',mail_id='50' where id='{attempt}';");assert gift_ok()
        sql("update khub_bot.incoming_gifts set legacy_donation=true where mail_id='50';");assert not gift_ok()
        sql("set role anon;select public.bot_gift_mail_cleanup('[]');",error='permission denied')
        sql("set role authenticated;select public.bot_gift_mail_cleanup('[]');",error='permission denied')
        sql("update khub_bot.receipts set received_at=now()-interval '1 day';")
        audit=sql((ROOT/'scripts/inbox-cleanup-audit.sql').read_text()) if (ROOT/'scripts/inbox-cleanup-audit.sql').exists() else ''
        if audit: assert 'M-1|' in audit
        print('PASS completed account/Buy/raffle/gift/policy cleanup; pending/unknown, partial-refund, changed-envelope, review, opening and inventory guards; privacy and unchanged financial definitions')
    finally:
        if started:pg('-m','immediate','-w','stop')
