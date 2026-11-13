"""Raffle financial and lifecycle safety against ALL local SQL migrations.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/raffle_lifecycle_database_test.py
"""
import json
import hashlib
import hmac
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-raffle-full-',dir='/tmp') as folder:
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
            create schema storage;
            create table storage.buckets(id text primary key,public boolean);
            insert into storage.buckets values('creator-photos',false);
            create table storage.objects(bucket_id text,name text);
            alter table storage.objects enable row level security;
            create schema auth;
            create table auth.users(id uuid primary key,instance_id uuid,aud text,role text,email text unique,encrypted_password text,
                email_confirmed_at timestamptz,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}',
                is_super_admin boolean default false,created_at timestamptz,updated_at timestamptz,banned_until timestamptz,
                confirmation_token text,recovery_token text,email_change_token_current text,email_change_token_new text,email_change text,
                phone_change_token text,phone_change text,reauthentication_token text);
            create table auth.identities(id uuid primary key,provider_id text,user_id uuid references auth.users(id) on delete cascade,
                identity_data jsonb,provider text,created_at timestamptz,updated_at timestamptz);
            create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade);
            create table auth.mfa_amr_claims(session_id uuid,authentication_method text);
            create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
            grant usage on schema public,auth to anon,authenticated,service_role;
            grant execute on function auth.uid() to anon,authenticated;
        ''')
        migrations=sorted([*ROOT.glob('supabase/migrations/*.sql'),*ROOT.glob('supabase/migrations/queue/*.sql')],key=lambda p:p.name)
        assert len({p.name for p in migrations})==len(migrations)
        for migration in migrations:
            if migration.name.startswith('202610290144_'):
                upgrade_transfer=str(uuid4());upgrade_attempt=str(uuid4())
                sql("insert into khub_bot.closet_transfers(id,dedupe_key,source,meat,state,attempt,before_state) values('"+upgrade_transfer+"','soft-upgrade-fixture','sale_fee',700,'unknown','"+upgrade_attempt+"','{\"inventory\":\"9000\",\"closet\":\"1000\"}');")
                sql("insert into khub_bot.closet_recovery_attempts(attempt,transfer_id,legacy,before_state,state,deadline,reason) values('"+upgrade_attempt+"','"+upgrade_transfer+"',true,'{\"inventory\":\"9000\",\"closet\":\"1000\"}','review',clock_timestamp()-interval '1 hour','Historical attempt has no durable submission fence; elapsed time cannot authorize replay.');")
            if migration.name.startswith('202611050229_'):
                financial_query="select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','khub_bot') and p.prokind='f' and p.proname in ('place_bid','bot_ingest_mail','bot_tick','bot_claim_delivery','bot_ack_delivery','finish_listing','finish_buy_order','bot_liabilities');"
                before_background_reads=sql(financial_query)
            if migration.name.startswith('202611060234_'):
                for name,sig in [('bot_gift_intake_state_scoped','text[]'),('bot_claim_gift_open','jsonb')]:
                    definition=sql(f"select pg_get_functiondef('public.{name}({sig})'::regprocedure)")
                    sql(definition.replace(f'FUNCTION public.{name}(',f'FUNCTION khub_bot.before_234_{name}('))
            sql(migration.read_text())
            if migration.name.startswith('202611050229_'):
                assert sql(financial_query)==before_background_reads, 'Background-read migration changed financial functions'

            if migration.name=='202611040199_raffle_backend.sql':assert sql("select public.bot_worker_status()->>'raffleBackendVersion'")=='1'
            if migration.name.startswith('202610290144_'):
                assert sql("select state='watching' and soft_retry_window_started_at is not null and deadline>clock_timestamp() from khub_bot.closet_recovery_attempts where attempt='"+upgrade_attempt+"';")=='t'
                assert sql("select state from khub_bot.closet_transfers where id='"+upgrade_transfer+"';")=='unknown'
                assert sql("select count(*) from khub_bot.closet_soft_retries where transfer_id='"+upgrade_transfer+"';")=='0'
                sql("select public.bot_reconcile_closet_transfer('"+upgrade_transfer+"',true,'local upgrade fixture cleanup');")
                print('PASS: upgrade re-observes an old unchanged legacy review without submitting or immediately approving a retry')
        catalog_path=ROOT/'src/data/items.json'
        if not catalog_path.exists(): catalog_path=ROOT/'catalog/items.json'
        catalog=json.loads(catalog_path.read_text())
        # Website bundle contains tradeable items only. Add explicitly synthetic
        # non-tradeable rows to satisfy the full-snapshot importer in this test.
        catalog += [{'id':1900000+i,'name':f'Untradeable fixture {i}','image':'test.gif','tradeable':False}
            for i in range(max(0,10000-len(catalog)))]
        sql('select public.bot_replace_item_catalog('+lit(json.dumps(catalog))+",now(),repeat('a',64));")
        def account(mid,player,name):
            payload={'id':str(mid),'sender_id':player,'sender_name':name,'received_at':'2026-10-21T12:00:00Z',
                'command':{'type':'register'},'meat':0,'items':[],'raw':{'id':str(mid),'fromid':str(player),'fromname':name,'type':'normal','message':'REGISTER'}}
            job=json.loads(sql('select public.bot_prepare_account_mail('+lit(json.dumps(payload))+",'Kh9!FixturePassword');"))
            metadata=lit(json.dumps({'khub_account_job':str(mid)}))
            sql(f"insert into auth.users(id,email,encrypted_password,raw_app_meta_data,raw_user_meta_data) values('{job['user_id']}',{lit(job['login_email'])},'fixture-hash',{metadata},'{{}}');")
            sql(f"select public.bot_finish_account_job('{mid}');")
            sql(f"insert into auth.sessions values('{uuid4()}','{job['user_id']}');")
            return job['user_id'],payload

        from datetime import datetime,timezone
        seller,_=account(98001,48889601,'Bundle Seller')
        buyer,_=account(98002,48889602,'Bundle Buyer')
        other,_=account(98003,48889603,'Bundle Other')
        sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp();")
        def call(query,uid=seller,error=None):return sql('set role authenticated;'+query,uid,error)
        parts=[{'id':2,'quantity':3},{'id':364,'quantity':5}]
        def create(escrow=True,buyout='null',items=None):
            return call('select public.create_bundle_auction('+lit(json.dumps(parts if items is None else items))+f",100,24,{buyout},{str(escrow).lower()});")
        # All migrations are loaded, including the current real delivery/solvency code.
        sql(f"insert into khub_bot.administrators(user_id,note) values('{seller}','isolated raffle test');")
        call("select public.add_high_rollers_member('48889602')")
        if call("select public.read_my_high_rollers_invitation()",uid=buyer): call("select public.respond_high_rollers_invitation(true,'1')",uid=buyer)
        mid=100000
        def create_raffle(fair=False):
            rid=str(uuid4())
            call(f"select public.create_mystery_raffle('{rid}','Fixture raffle',100,now()+interval '1 day','[{{\"id\":2,\"quantity\":3,\"probability_bps\":10000}},{{\"id\":364,\"quantity\":5,\"probability_bps\":0}}]');")
            call(f"select public.activate_mystery_raffle('{rid}')")
            assert sql(f"select fair_required from khub_bot.raffle_accounts where raffle_id='{rid}'")=='t'
            # Preserve historical lifecycle fixtures; new-protocol tests below opt in.
            if not fair: sql(f"update khub_bot.raffle_accounts set fair_required=false where raffle_id='{rid}'")
            return rid
        def mail(rid,kind='raffle',meat=100,items=None,actor=48889602):
            global mid
            mid+=1
            received=sql("select date_trunc('second',clock_timestamp())")
            return dict(id=str(mid),sender_id=actor,sender_name='Fixture',received_at=received,command=dict(type=kind,raffle_id=rid),meat=meat,items=items or [],raw=dict(type='normal',azunixtime=str(int(datetime.fromisoformat(received).timestamp()))))
        def ingest(m):return sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(m))+');')
        def tick():sql('set role service_role;select public.bot_raffle_tick();')
        def restart():
            pg('-m','fast','-w','stop');pg('-l',str(Path(folder)/'postgres.log'),'-o',f"-F -h '' -k {folder}",'-w','start')
        def draw(rid,minutes=31):
            sql(f"update public.mystery_raffles set ends_at=clock_timestamp()-interval '{minutes} minutes' where id='{rid}';")
            scan=json.loads(sql('select public.bot_begin_inbox_scan()'))
            sql(f"select public.bot_stage_inbox_scan('{scan['id']}','[]');select public.bot_finish_inbox_scan('{scan['id']}');")
            work=json.loads(sql('set role service_role;select public.bot_raffle_draw_work();'))
            restart()
            assert json.loads(sql('select public.bot_raffle_draw_work()'))==work
            for entry in work:
                proc=subprocess.run(['node','--input-type=module','-e',"import {readFileSync} from 'node:fs';import {createRaffleDraw} from './bot/src/raffle-draw.mjs';console.log(JSON.stringify(createRaffleDraw(JSON.parse(readFileSync(0,'utf8')),n=>Buffer.alloc(n))));"],input=json.dumps(entry),text=True,capture_output=True,cwd=ROOT,check=True)
                result=json.loads(proc.stdout)
                sql(f"set role service_role;select public.bot_commit_raffle_draw('{entry['raffleId']}',{lit(json.dumps(result))});")
                # Lost commit response: another process's draw cannot overwrite it.
                sql(f"select public.bot_commit_raffle_draw('{entry['raffleId']}', '{{}}');")
            tick()
        def account_value(rid,key):return sql(f"select {key} from khub_bot.raffle_accounts where raffle_id='{rid}';")
        def advance(rid,amount,req=None,error=None,user=seller):
            req=req or str(uuid4())
            call(f"select public.request_raffle_advance('{rid}','{req}',{amount});",uid=user,error=error)
            return req
        def finish_deliveries(uncertain=False):
            # Real claims and ack RPCs; no transport or KoL is involved.
            for _ in range(100):
                d=json.loads(sql('set role service_role;select public.bot_claim_delivery_batch(5);') or 'null')
                if d is None: return
                sql(f"set role service_role;select public.bot_ack_delivery('{d['id']}','{d['attempt']}',{'false' if uncertain and d['kind']=='sale_item' else 'true'},'offline fixture acknowledgment');")
                if uncertain and d['kind']=='sale_item':return d
            raise AssertionError('delivery queue did not drain')
        rid=create_raffle()
        # Owner purchases refund every attachment once and never change ticket balances.
        for attachments in [[], [dict(id=2,quantity=2)]]:
            rejected=mail(rid,meat=100,items=attachments,actor=48889601)
            assert ingest(rejected)=='raffle_refund'
            assert ingest(rejected)=='duplicate'
            assert account_value(rid,'ticket_count')=='0'
            assert account_value(rid,'revenue')=='0'
            assert account_value(rid,'held_meat')=='0'
            assert sql(f"select count(*) from khub_bot.raffle_purchases where receipt_id='{rejected['id']}'")=='0'
            assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{rejected['id']}'")=='100'
            assert sql(f"select coalesce(sum(quantity),0) from khub_bot.deliveries where receipt_id='{rejected['id']}'")==str(2 if attachments else 0)
        # A different administrator is also excluded, while ordinary buyers remain eligible.
        sql(f"insert into khub_bot.administrators(user_id,note) values('{other}','temporary participation test');")
        admin_purchase=mail(rid,meat=200,actor=48889603)
        assert ingest(admin_purchase)=='raffle_refund'
        assert ingest(admin_purchase)=='duplicate'
        assert account_value(rid,'ticket_count')=='0'
        assert account_value(rid,'revenue')=='0'
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{admin_purchase['id']}'")=='200'
        changed={**admin_purchase,'meat':300}
        sql('select public.bot_ingest_mail('+lit(json.dumps(changed))+');',error='Receipt payload conflict')
        sql(f"delete from khub_bot.administrators where user_id='{other}';")
        print('PASS: host/admin purchase refunds are exact and idempotent without issuing tickets')
        unverified=mail(rid,'raffle_supply',0,[dict(id=2,quantity=100)],48889601)
        unverified['raw']={'type':'normal','gift_original':{'id':unverified['id']}}
        sql('select public.bot_ingest_mail('+lit(json.dumps(unverified))+');',error='Gift contents have not been verified')
        assert sql(f"select count(*) from khub_bot.receipts where mail_id='{unverified['id']}'")=='0'
        rejected_supply=mail(rid,'raffle_supply',10,[dict(id=2,quantity=2)],48889601)
        assert ingest(rejected_supply)=='raffle_refund';assert ingest(rejected_supply)=='duplicate'
        assert account_value(rid,'held_meat')=='0'
        assert sql(f"select count(*) from khub_bot.raffle_inventory where raffle_id='{rid}'")=='0'
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{rejected_supply['id']}'")=='10'
        assert sql(f"select sum(quantity) from khub_bot.deliveries where receipt_id='{rejected_supply['id']}'")=='2'
        assert 'prize items only' in sql(f"select message from khub_bot.deliveries where receipt_id='{rejected_supply['id']}' limit 1")
        assert sql("select count(*) from information_schema.columns where table_schema='khub_bot' and table_name='raffle_accounts' and column_name='contributions'")=='0'
        assert sql("select count(*) from information_schema.columns where table_schema='khub_bot' and table_name='raffle_deposits' and column_name='meat'")=='0'
        payment=mail(rid,meat=1000)
        assert ingest(payment)=='raffle_tickets'
        confirmation=sql(f"select message from khub_bot.deliveries where receipt_id='{payment['id']}'")
        offset=int(account_value(rid,'ticket_label_offset'))
        assert 999<=offset<=9998
        for text in ['Fixture raffle','10 ticket(s)',f'{offset+1} through {offset+10}','equal chance of winning']:assert text in confirmation
        history=json.loads(call(f"select public.read_my_raffle_tickets('{rid}')",uid=buyer))
        assert history['ticket_count']=='10'
        page=json.loads(call(f"select public.read_my_raffle_ticket_page('{rid}',0)",uid=buyer))
        assert page['ticket_count']=='10' and page['purchase_count']==1 and len(page['purchases'])==len(history['purchases'])
        for new,old in zip(page['purchases'],history['purchases']):
            assert {k:str(v) for k,v in new.items()}=={k:str(v) for k,v in old.items()}, (new,old)
        empty_page=json.loads(call(f"select public.read_my_raffle_ticket_page('{rid}',50)",uid=buyer))
        assert empty_page['purchases']==[] and empty_page['ticket_count']=='10'
        call(f"select public.read_my_raffle_ticket_page('{rid}',0)",uid=other,error='Raffle access required')
        assert sql("select has_function_privilege('anon','public.read_my_raffle_ticket_page(uuid,integer)','execute')")=='f'

        admin_history=json.loads(call(f"select public.read_admin_raffle_ticket_history('{rid}')"))
        assert len(admin_history)==1
        assert admin_history[0]['receipt_id']==payment['id']
        assert admin_history[0]['username']=='Bundle Buyer'
        assert admin_history[0]['player_id']=='48889602'
        assert admin_history[0]['ticket_count']=='10'
        assert admin_history[0]['meat']=='1000'
        assert admin_history[0]['received_at']
        assert json.loads(call(f"select public.read_admin_raffle_ticket_history('{rid}',50)"))==[]
        call(f"select public.read_admin_raffle_ticket_history('{rid}')",uid=buyer,error='Administrator required')
        call(f"select public.read_admin_raffle_ticket_history('{rid}',-1)",error='Invalid offset')
        assert json.loads(call(f"select public.read_raffle_management('{rid}')"))['ticket_count']=='10'
        assert sql("select has_function_privilege('anon','public.read_admin_raffle_ticket_history(uuid,integer)','execute')")=='f'
        print('PASS: admin purchase history includes buyer, time, quantities and exact totals; private access enforced')

        assert history['purchases'][0]['first_ticket']==str(offset+1)
        assert history['purchases'][0]['last_ticket']==str(offset+10)
        assert sql(f"select first_ticket=1 and last_ticket=10 from khub_bot.raffle_purchases where receipt_id='{payment['id']}'")=='t'
        sql(f"update khub_bot.raffle_accounts set ticket_label_offset=0 where raffle_id='{rid}'",error='immutable')
        for text in ['cryptographic','rejection sampling','RNG']:assert text not in confirmation

        restart();assert ingest(payment)=='duplicate'
        assert int(account_value(rid,'ticket_label_offset'))==offset
        assert json.loads(call(f"select public.read_my_raffle_tickets('{rid}')",uid=buyer))==history
        changed=dict(payment,meat=900)
        sql('select public.bot_ingest_mail('+lit(json.dumps(changed))+');',error='Receipt payload conflict')
        assert ingest(mail(rid,meat=101))=='raffle_refund'
        assert ingest(mail(rid,'raffle_supply',0,[dict(id=2,quantity=1),dict(id=364,quantity=9)],48889601))=='raffle_supply'
        deposit=mail(rid,'raffle_supply',0,[dict(id=2,quantity=1)],48889601)
        assert ingest(deposit)=='raffle_supply';assert ingest(deposit)=='duplicate'
        assert ingest(mail(rid,'raffle_supply',0,[dict(id=2,quantity=1)],48889602))=='raffle_refund'
        call(f"select public.read_raffle_management('{rid}')",uid=buyer,error='Administrator required')
        call(f"select public.request_raffle_advance('{rid}','{uuid4()}',1)",uid=buyer,error='Administrator required')
        advance(rid,1,error='Advance exceeds')
        mine=json.loads(call(f"select public.read_my_raffle_counts(array['{rid}']::uuid[])",uid=buyer))
        assert mine[rid]=='10'
        assert json.loads(call(f"select public.read_my_raffle_tickets('{rid}')",uid=other))['ticket_count']=='0'
        for name in ['read_raffle_management','read_my_raffle_tickets']:
            sql(f"set role anon; select public.{name}('{rid}');",error='permission denied')
        sql('set role authenticated;select * from khub_bot.raffle_advances;',error='permission denied')
        draw(rid)
        assert account_value(rid,'held_meat')=='1000'
        assert ingest(mail(rid))=='raffle_refund'
        advance(rid,1001,error='Advance exceeds')
        sql("""create function khub_bot.fail_fixture_advance() returns trigger language plpgsql as $$begin
        if new.dedupe_key like '%:advance:%' then raise exception 'injected queue failure'; end if;return new;end$$;
        create trigger fixture_advance_failure before insert on khub_bot.deliveries for each row execute function khub_bot.fail_fixture_advance();""")
        advance(rid,400,error='injected queue failure')
        assert account_value(rid,'held_meat')=='1000'
        assert account_value(rid,'advanced_meat')=='0'
        assert sql(f"select count(*) from khub_bot.raffle_advances where raffle_id='{rid}'")=='0'
        sql('drop trigger fixture_advance_failure on khub_bot.deliveries;drop function khub_bot.fail_fixture_advance();')
        request=advance(rid,400);restart();advance(rid,400,request)
        advance(rid,401,request,error='conflict')
        assert account_value(rid,'held_meat')=='600'
        assert account_value(rid,'advanced_meat')=='400'
        advance(rid,601,error='Advance exceeds')
        info=json.loads(call(f"select public.read_raffle_management('{rid}')"))
        assert info['available_advance']=='600'
        assert any(':delay:' in d['reference'] for d in info['deliveries'])
        assert not any(':prize:' in d['reference'] for d in info['deliveries'])
        finish_deliveries()
        # Missing prize supplied after drawing, excess returned after delivery.
        assert ingest(mail(rid,'raffle_supply',0,[dict(id=2,quantity=5)],48889601))=='raffle_supply'
        tick();restart();tick()
        assert sql(f"select count(*) from khub_bot.deliveries where dedupe_key like 'raffle:{rid}:prize:%'")=='1'
        before=json.loads(sql('select public.bot_liabilities()'))
        assert int(before['meat'])>=600
        uncertain=finish_deliveries(True)
        assert uncertain and uncertain['kind']=='sale_item'
        restart();tick()
        assert account_value(rid,'settlement_queued')=='f'
        assert account_value(rid,'held_meat')=='600'
        sql(f"set role service_role;select public.bot_reconcile_delivery('{uncertain['id']}',true,'offline fixture verified sent');")
        advance(rid,1,error='already verified')
        tick();assert account_value(rid,'held_meat')=='600'
        finish_deliveries();tick()
        assert account_value(rid,'held_meat')=='0', sql(f"select jsonb_agg(jsonb_build_object('key',dedupe_key,'state',state,'kind',kind)) from khub_bot.deliveries where dedupe_key like 'raffle:{rid}:%'")
        finish_deliveries();tick()
        assert sql(f"select state from public.mystery_raffles where id='{rid}'")=='settled'
        assert sql(f"select sum(meat) from khub_bot.deliveries where dedupe_key like 'raffle:{rid}:proceeds:%'")=='600'
        for suffix in [':prize:%',':return:%',':proceeds:%']:
            messages=sql(f"select string_agg(message,' ') from khub_bot.deliveries where dedupe_key like 'raffle:{rid}{suffix}'")
            assert 'Fixture raffle' in messages

        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like 'raffle:%:contribution:%'")=='0'
        assert sql(f"select sum(quantity) from khub_bot.deliveries where dedupe_key like 'raffle:{rid}:return:%'")=='13'
        # Concurrent requests cannot overcommit the same proceeds.
        import concurrent.futures
        rid=create_raffle();assert ingest(mail(rid,meat=1000))=='raffle_tickets';draw(rid)
        def competing_advance(_):
            query=f"set role authenticated;set request.jwt.claim.sub='{seller}';select public.request_raffle_advance('{rid}','{uuid4()}',700);"
            return subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',query],capture_output=True,text=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes=list(pool.map(competing_advance,range(2)))
        assert sum(r.returncode==0 for r in outcomes)==1
        assert account_value(rid,'advanced_meat')=='700'
        assert account_value(rid,'held_meat')=='300'
        # An uncertain advance remains committed and cannot fund a second advance.
        advance_delivery=json.loads(sql(f"select to_jsonb(d) from khub_bot.deliveries d where dedupe_key like 'raffle:{rid}:advance:%'"))
        sql(f"update khub_bot.deliveries set state='unknown',attempt=gen_random_uuid() where id='{advance_delivery['id']}'")
        restart();advance(rid,301,error='Advance exceeds')
        sql(f"select public.bot_reconcile_delivery('{advance_delivery['id']}',true,'offline advance verified sent');")
        assert ingest(mail(rid,'raffle_supply',0,[dict(id=2,quantity=3)],48889601))=='raffle_supply'
        tick();finish_deliveries();tick();finish_deliveries();tick();finish_deliveries();tick()
        assert account_value(rid,'held_meat')=='0'
        for cancel in [True,False]:
            rid=create_raffle()
            assert ingest(mail(rid,'raffle_supply',0,[dict(id=364,quantity=2)],48889601))=='raffle_supply'
            if cancel:
                assert ingest(mail(rid,meat=200))=='raffle_tickets'
                call(f"select public.cancel_mystery_raffle('{rid}')")
                call(f"select public.cancel_mystery_raffle('{rid}')",error='Only preview')
            else:draw(rid)
            tick();restart();tick();finish_deliveries();tick()
            assert account_value(rid,'held_meat')=='0', sql(f"select jsonb_agg(jsonb_build_object('key',dedupe_key,'state',state,'kind',kind)) from khub_bot.deliveries where dedupe_key like 'raffle:{rid}:%'")
            assert sql(f"select state from public.mystery_raffles where id='{rid}'")=='settled'
            if cancel:assert sql(f"select sum(meat) from khub_bot.deliveries where dedupe_key like 'raffle:{rid}:refund:%'")=='200'
        # Real opened-gift adapter -> durable verified proof -> raffle intake.
        gift_raffle=create_raffle()
        def verified_raffle_gift(kind,meat,items,actor,expected=None,inside=False,outside_note='Please process this'):
            raw=mail(gift_raffle,kind,meat,items,actor)
            source=dict(id=raw['id'],type='giftshop',fromid=str(actor),fromname='Fixture',azunixtime=str(int(datetime.now(timezone.utc).timestamp())),message=('RAFFLE' if kind=='raffle' else 'SUPPLY')+' '+sql(f"select raffle_number from public.mystery_raffles where id='{gift_raffle}'"))
            inside_note=source['message'] if inside else 'Enjoy!'
            if inside: source['message']=outside_note
            script="""import {readFileSync} from 'node:fs';import {giftEnvelope,openedGiftPayload} from './bot/src/incoming-gifts.mjs';
            const {source,meat,items,inside_note}=JSON.parse(readFileSync(0,'utf8'));
            const item=(id,n)=>`<table class="item" rel="id=${id}&n=${n}"><tr><td><img title="fixture"></td></tr></table>`;
            source.message+=item(1167,1);const envelope=giftEnvelope(source);
            const opened={...source,message:source.message+'<p>Inside Note:<p>'+inside_note+(meat?`<center>You gain ${meat} Meat</center>`:'')+items.map(i=>item(i.id,i.quantity)).join('')};
            console.log(JSON.stringify({envelope,payload:openedGiftPayload(envelope,opened)}));"""
            result=subprocess.run(['node','--input-type=module','-e',script],cwd=ROOT,input=json.dumps(dict(source=source,meat=meat,items=items,inside_note=inside_note)),capture_output=True,text=True,check=True)
            parsed=json.loads(result.stdout);payload=parsed['payload']
            sql('select public.bot_register_gift_mail('+lit(json.dumps([parsed['envelope']]))+');')
            held=json.loads(sql('select public.bot_liabilities()'))
            before=dict(meat=held['meat'],items=dict(held['items'],**{'1167':'1'}))
            attempt=json.loads(sql('select public.bot_claim_gift_open('+lit(json.dumps(before))+');'))['id']
            after=dict(meat=str(int(before['meat'])+meat),items=dict(before['items'],**{'1167':'0'}))
            for item in items:after['items'][str(item['id'])]=str(int(after['items'].get(str(item['id']),0))+item['quantity'])
            finish=f"select public.bot_finish_gift_open('{attempt}',{lit(json.dumps(payload))},{lit(json.dumps(after))});"
            sql(finish);sql(finish)
            protected=json.loads(sql('select public.bot_liabilities()'))
            isolation=json.loads(sql('select public.bot_isolate_raffle_intake('+lit(json.dumps(payload))+');'))
            assert isolation['state']=='isolated'
            assert json.loads(sql('select public.bot_liabilities()'))==protected, 'verified gifts must not reserve twice'
            assert ingest(payload)==(expected or ('raffle_tickets' if kind=='raffle' else 'raffle_supply'))
            assert json.loads(sql('select public.bot_liabilities()'))==protected
            restart();assert ingest(payload)=='duplicate'
            assert json.loads(sql('select public.bot_liabilities()'))==protected
            return payload
        for kind,intent,contents in [('raffle','raffle',[]),('raffle_supply','raffle_supply',[dict(id=2,quantity=1)])]:
            rejected=verified_raffle_gift(kind,100,contents,48889602,expected='Gift command is inside: '+intent,inside=True)
            assert sql(f"select count(*) from khub_bot.raffle_purchases where receipt_id='{rejected['id']}'")=='0'
            assert sql(f"select count(*) from khub_bot.raffle_deposits where receipt_id='{rejected['id']}'")=='0'
            assert int(sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{rejected['id']}' and kind='refund'"))==100
            assert 'outside message' in sql(f"select khub_bot.friendly_reason('Gift command is inside: {intent}')")
        verified_raffle_gift('raffle',100000000,[],48889602,inside=True,outside_note='')
        verified_raffle_gift('raffle',40000000,[],48889602)
        assert account_value(gift_raffle,'revenue')=='140000000'
        verified_raffle_gift('raffle_supply',0,[dict(id=364,quantity=2)],48889601)
        verified_raffle_gift('raffle_supply',10,[dict(id=2,quantity=7)],48889601,expected='raffle_refund')
        assert sql(f"select count(*) from khub_bot.raffle_inventory where raffle_id='{gift_raffle}' and item_id=2")=='0'
        assert account_value(gift_raffle,'held_meat')=='140000000'
        draw(gift_raffle,minutes=1)
        notice=sql(f"select message from khub_bot.deliveries where dedupe_key='raffle:{gift_raffle}:admin:notice'")
        for text in ['seal tooth','3','SUPPLY '+sql(f"select raffle_number from public.mystery_raffles where id='{gift_raffle}'"),'140,000,000','ADVANCE '+sql(f"select raffle_number from public.mystery_raffles where id='{gift_raffle}'")]:assert text in notice
        assert '\n\nSupply missing items: SUPPLY ' in notice
        assert '\n\nAvailable advance: 140,000,000 Meat\nRequest advance: ADVANCE ' in notice
        assert '3 × seal tooth' in notice
        assert 'Delivery target:' not in notice and '(item #' not in notice
        winner=sql(f"select message from khub_bot.deliveries where dedupe_key='raffle:{gift_raffle}:winner:notice'")
        assert 'seal tooth' in winner and '3' in winner
        for text in ['Congratulations!', 'Fixture raffle', 'being prepared', 'within 30 minutes', 'sooner']:assert text in winner
        assert 'delayed' not in winner.lower()
        assert sql(f"select count(*) from khub_bot.deliveries where dedupe_key='raffle:{gift_raffle}:delay:notice'")=='0'
        restart();tick()
        assert sql(f"select count(*) from khub_bot.deliveries where dedupe_key='raffle:{gift_raffle}:winner:notice'")=='1'
        sql(f"update public.mystery_raffles set ends_at=clock_timestamp()-interval '31 minutes' where id='{gift_raffle}'")
        tick();restart();tick()
        assert sql(f"select count(*) from khub_bot.deliveries where dedupe_key='raffle:{gift_raffle}:delay:notice'")=='1'
        assert 'passed our 30-minute delivery target' in sql(f"select message from khub_bot.deliveries where dedupe_key='raffle:{gift_raffle}:delay:notice'")
        def advance_mail(amount,actor=48889601,meat=0):
            m=mail(gift_raffle,'raffle_advance',meat,actor=actor);m['command']['amount']=str(amount);return m
        over=advance_mail(200000000)
        assert ingest(over)=='raffle_advance_rejected';assert ingest(over)=='duplicate'
        assert account_value(gift_raffle,'advanced_meat')=='0'
        assert '140,000,000 Meat' in sql(f"select message from khub_bot.deliveries where receipt_id='{over['id']}'")
        accepted=advance_mail(100000000)
        assert ingest(accepted)=='raffle_advance';restart();assert ingest(accepted)=='duplicate'
        assert account_value(gift_raffle,'advanced_meat')=='100000000'
        assert account_value(gift_raffle,'held_meat')=='40000000'
        pending_over=advance_mail(50000000)
        assert ingest(pending_over)=='raffle_advance_rejected'
        assert '40,000,000 Meat' in sql(f"select message from khub_bot.deliveries where receipt_id='{pending_over['id']}'")
        assert ingest(advance_mail(1,actor=48889603))=='raffle_refund'
        # Queued/uncertain advances stay committed, including for UI requests.
        ad=sql(f"select id from khub_bot.deliveries where receipt_id='{accepted['id']}' and kind='sale_meat'")
        sql(f"update khub_bot.deliveries set state='unknown',attempt=gen_random_uuid() where id='{ad}'")
        advance(gift_raffle,50000000,error='Available: 40000000')
        sql(f"select public.bot_reconcile_delivery('{ad}',true,'offline advance verified sent');")
        verified_raffle_gift('raffle_supply',0,[dict(id=2,quantity=3)],48889601)
        tick();finish_deliveries();tick();finish_deliveries();tick();finish_deliveries();tick()
        assert account_value(gift_raffle,'held_meat')=='0'
        assert sql(f"select count(*) from khub_bot.deliveries where dedupe_key='raffle:{gift_raffle}:winner:notice'")=='1'
        assert sql(f"select sum(meat) from khub_bot.deliveries where dedupe_key like 'raffle:{gift_raffle}:proceeds:%'")=='40000000'
        # Identical physical items are fungible: sum ALL obligations before every
        # send, and prove every reserve->queue transition conserves that sum.
        def auction_mail(aid,kind,meat=0,quantity=0,actor=48889601):
            m=mail(aid,kind,meat,[dict(id=2,quantity=quantity)] if quantity else [],actor)
            m['command']={'type':kind,'auction_id':aid};m['raw']={'type':'normal'}
            if kind=='fill':m['command']['reservation_id']=json.loads(call(f"select public.reserve_buy_quantity('{aid}',{quantity});"))['id']
            m['received_at']=sql("select date_trunc('second',clock_timestamp())")
            m['raw']['azunixtime']=int(datetime.fromisoformat(m['received_at']).timestamp())
            if kind in ('bid','buy','fill'):
                scan=json.loads(sql('select public.bot_begin_inbox_scan()'))['id']
                sql(f"select public.bot_stage_inbox_scan('{scan}',{lit(json.dumps([m]))});")
            return m
        escrow=call("select public.create_auction('seal tooth',5,100,24,null,null,2,true);")
        assert ingest(auction_mail(escrow,'list',quantity=5))=='accepted'
        assert ingest(auction_mail(escrow,'bid',500,actor=48889602))=='accepted'
        order=call("select public.create_buy_auction(2,10,100,24,'finished');",uid=buyer)
        funding=int(sql(f"select funding_required from khub_bot.buy_orders where auction_id='{order}'"))
        assert ingest(auction_mail(order,'fund',funding,actor=48889602))=='accepted'
        assert ingest(auction_mail(order,'fill',quantity=4))=='accepted'
        finish_deliveries()
        external_buy=sql(f"select to_jsonb(o) from khub_bot.buy_orders o where auction_id='{order}'")
        def liabilities():return json.loads(sql('select public.bot_liabilities()'))
        baseline=liabilities()
        assert int(baseline['items']['2'])==9  # escrow five + Buy held four
        physical={'meat':int(baseline['meat']),'items':{k:int(v) for k,v in baseline['items'].items()}}
        def totals():return {'meat':str(physical['meat']),'items':{k:str(v) for k,v in physical['items'].items()}}
        def check_solvent(shortage=None):
            snapshot=totals();held=liabilities()
            if shortage=='meat':snapshot['meat']=str(int(held['meat'])-1)
            if shortage=='item':snapshot['items']['2']=str(int(held['items']['2'])-1)
            proc=subprocess.run(['node','--input-type=module','-e',"import {readFileSync} from 'node:fs';import {assertSolvent} from './bot/src/protocol.mjs';const {snapshot,held}=JSON.parse(readFileSync(0,'utf8'));try{assertSolvent(snapshot,held);process.exit(0)}catch{process.exit(1)}"],input=json.dumps(dict(snapshot=snapshot,held=held)),cwd=ROOT,capture_output=True,text=True)
            assert (proc.returncode!=0)==bool(shortage)
        seen=set()
        def intake_physical(m):
            answer=ingest(m)
            if m['id'] not in seen:
                seen.add(m['id']);physical['meat']+=m['meat']
                for i in m['items']:physical['items'][str(i['id'])]=physical['items'].get(str(i['id']),0)+i['quantity']
            return answer
        first=create_raffle();second=create_raffle()
        intake_physical(mail(first,meat=1000))
        intake_physical(mail(first,'raffle_supply',0,[dict(id=2,quantity=1)],48889601))
        intake_physical(mail(second,'raffle_supply',0,[dict(id=2,quantity=4)],48889601))
        draw(first)
        assert sql(f"select count(*) from khub_bot.deliveries where dedupe_key like 'raffle:{first}:prize:%'")=='0', 'must not borrow another raffle or auction inventory'
        more=mail(first,'raffle_supply',0,[dict(id=2,quantity=4)],48889601)
        intake_physical(more);before_queue=liabilities();tick();assert liabilities()==before_queue
        assert intake_physical(more)=='duplicate';assert liabilities()==before_queue
        req=str(uuid4());bid=auction_mail(escrow,'bid',700,actor=48889603)
        def simultaneous(query):
            return subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',query],capture_output=True,text=True)
        jobs=[f"set role authenticated;set request.jwt.claim.sub='{seller}';select public.request_raffle_advance('{first}','{req}',600)",
              'set role service_role;select public.bot_ingest_mail('+lit(json.dumps(bid))+')']
        before_race=liabilities()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:race=list(pool.map(simultaneous,jobs))
        assert all(r.returncode==0 for r in race),[r.stderr for r in race]
        physical['meat']+=700
        assert int(liabilities()['meat'])==int(before_race['meat'])+700
        advance(first,600,req);assert ingest(bid)=='duplicate'
        invalid=mail(first,meat=3,items=[dict(id=2,quantity=1)])
        intake_physical(invalid);after_invalid=liabilities();assert intake_physical(invalid)=='duplicate';assert liabilities()==after_invalid
        check_solvent();check_solvent('meat');check_solvent('item')
        # A claim/ack only changes the actual assets of that envelope, never a
        # different owner's reserve. Repeated ticks/restarts cannot duplicate it.
        def send_exact():
            for _ in range(100):
                check_solvent()
                d=json.loads(sql('select public.bot_claim_delivery_batch(5)') or 'null')
                if d is None:return
                physical['meat']-=int(d['meat'])
                items=d.get('items') or ([dict(id=d['item_id'],quantity=d['quantity'])] if d.get('item_id') else [])
                for i in items:physical['items'][str(i['id'])]-=int(i['quantity'])
                sql(f"select public.bot_ack_delivery('{d['id']}','{d['attempt']}',true,'offline exact-balance send');")
                check_solvent()
            raise AssertionError('unexpected duplicate queue')
        send_exact();before_returns=liabilities();tick();assert liabilities()==before_returns
        restart();tick();assert liabilities()==before_returns
        send_exact();before_payout=liabilities();tick();assert liabilities()==before_payout
        send_exact();tick()
        assert sql(f"select state from public.mystery_raffles where id='{first}'")=='settled'
        assert sql(f"select quantity from khub_bot.raffle_inventory where raffle_id='{second}' and item_id=2")=='4'
        assert physical['items']['2']==13  # untouched escrow + Buy + second raffle
        assert int(liabilities()['items']['2'])==13
        assert sql(f"select held_quantity from khub_bot.buy_orders where auction_id='{order}'")=='4'
        assert sql(f"select to_jsonb(o) from khub_bot.buy_orders o where auction_id='{order}'")==external_buy
        assert sql(f"select current_bid from public.auctions where id='{escrow}'")=='700'
        # Exactly the protected external balances remain, with no raffle revenue
        # or refunded payment available to subsidize the other transactions.
        assert physical['meat']==int(liabilities()['meat'])
        assert sql("select (public.bot_worker_status()->>'raffleBackendVersion')::integer")=='3'
        canceled=create_raffle()
        intake_physical(mail(canceled,meat=200))
        intake_physical(mail(canceled,'raffle_supply',0,[dict(id=2,quantity=3)],48889601))
        before_cancel=liabilities();call(f"select public.cancel_mystery_raffle('{canceled}')");tick();assert liabilities()==before_cancel
        restart();tick();assert liabilities()==before_cancel
        send_exact();tick()
        assert physical['items']['2']==13
        assert physical['meat']==int(liabilities()['meat'])
        assert sql('select enabled from khub_bot.raffle_gate')=='t'
        call("select public.remove_high_rollers_member('48889602')")
        assert call('select public.can_view_raffles()',uid=buyer)=='t'
        sql(f"update public.profiles set kol_player_name='nISemonO' where id='{buyer}'")
        assert call('select public.can_view_raffles()',uid=buyer)=='t'
        rejected=mail(create_raffle(),meat=100)
        assert ingest(rejected)=='raffle_refund'
        assert ingest(rejected)=='duplicate'
        call("select public.add_high_rollers_member('nIsEmOnO')")
        call("select public.respond_high_rollers_invitation(true,'1')",uid=buyer)
        call("select public.add_high_rollers_member('48889602')")
        if call("select public.read_my_high_rollers_invitation()",uid=buyer): call("select public.respond_high_rollers_invitation(true,'1')",uid=buyer)
        club=json.loads(call("select public.read_high_rollers_members('NISE',0)"))
        assert club['total']==1 and club['members'][0]['player_id']=='48889602'
        assert len(json.loads(call("select public.read_high_rollers_members('889602',0)"))['members'])==1
        assert json.loads(call("select public.read_high_rollers_members('missing',0)"))['members']==[]
        call("select public.add_high_rollers_member('not registered')",error='registered kHub')
        for query in ["select public.add_high_rollers_member('48889603')", "select public.remove_high_rollers_member('48889602')", "select public.read_high_rollers_members('',0)"]:
            call(query,uid=buyer,error='Administrator required')
        assert call('select public.khub_is_administrator()',uid=buyer)=='f'
        call("select public.create_mystery_raffle(null,null,null,null,null)",uid=buyer,error='Administrator required')
        assert call('select public.can_view_raffles()',uid=seller)=='t'
        assert sql("set role anon;select public.can_view_raffles()")=='f'
        sql('set role authenticated;select * from khub_bot.high_rollers_members',uid=buyer,error='permission denied')
        assert sql(f"select count(*) from khub_bot.raffle_purchases where receipt_id='{rejected['id']}'")=='0'
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{rejected['id']}' and kind='refund'")=='100'
        # Membership follows numeric identity when the verified display name changes.
        sql(f"update public.profiles set kol_player_name='Club renamed player' where id='{buyer}'")
        assert call('select public.can_view_raffles()',uid=buyer)=='t'
        assert json.loads(call("select public.read_high_rollers_members('RENAMED',0)"))['members'][0]['player_id']=='48889602'
        assert json.loads(call("select public.read_high_rollers_members('nisemono',0)"))['members']==[]
        for query in ["select public.activate_mystery_raffle(null)", "select public.cancel_mystery_raffle(null)", "select public.read_raffle_management(null)"]:
            call(query,uid=buyer,error='Administrator required')
        assert call('select count(*) from public.mystery_raffle_prizes',uid=other)=='0'
        for signature in ['public.read_high_rollers_members(text,integer)','public.add_high_rollers_member(text)','public.remove_high_rollers_member(text)']:
            assert sql(f"select has_function_privilege('anon','{signature}','execute')")=='f'
        # Removing a member blocks both tables and refunds every attachment exactly.
        check_raffle=create_raffle()
        call("select public.remove_high_rollers_member('48889602')")
        assert call('select count(*) from public.mystery_raffles',uid=buyer)=='0'
        assert call('select count(*) from public.mystery_raffle_prizes',uid=buyer)=='0'
        removed_mail=mail(check_raffle,meat=200,items=[dict(id=2,quantity=3)])
        assert ingest(removed_mail)=='raffle_refund'
        assert ingest(removed_mail)=='duplicate'
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{removed_mail['id']}' and kind='refund'")=='200'
        assert sql(f"select sum(quantity) from khub_bot.deliveries where receipt_id='{removed_mail['id']}' and item_id=2")=='3'
        call("select public.add_high_rollers_member('48889602')")
        if call("select public.read_my_high_rollers_invitation()",uid=buyer): call("select public.respond_high_rollers_invitation(true,'1')",uid=buyer)
        print('PASS: club membership, username/ID search, removed tester access, restricted management and exact nonmember refunds')
        assert call('select public.can_view_raffles()',uid=buyer)=='t'
        assert int(call('select count(*) from public.mystery_raffles',uid=buyer))>0
        assert call('select count(*) from public.mystery_raffles',uid=other)=='0'
        for signature in ['public.bot_ingest_mail(jsonb)','public.bot_raffle_tick()','public.bot_commit_raffle_draw(uuid,jsonb)','public.bot_raffle_draw_work()','public.bot_liabilities()']:
            assert sql(f"select has_function_privilege('authenticated','{signature}','execute')")=='f'
            assert sql(f"select has_function_privilege('anon','{signature}','execute')")=='f'
            assert sql(f"select has_function_privilege('service_role','{signature}','execute')")=='t'

        # Numeric references resolve without changing original receipt/proof payloads.
        numbered=create_raffle()
        number=sql(f"select raffle_number from public.mystery_raffles where id='{numbered}'")
        assert int(number)>=1001
        assert sql(f"select khub_bot.resolve_raffle_id('{number}')")==numbered
        assert sql(f"select khub_bot.resolve_raffle_id('{numbered}')")==numbered
        sql(f"update public.mystery_raffles set raffle_number=999999 where id='{numbered}'",error='immutable')
        numeric_mail=mail(numbered,meat=200)
        numeric_mail['command']['raffle_id']=number
        assert sql('select public.bot_ingest_mail('+lit(json.dumps(numeric_mail))+');')=='raffle_tickets'
        assert sql('select public.bot_ingest_mail('+lit(json.dumps(numeric_mail))+');')=='duplicate'
        for ref in ['9999999999999999999','nonsense','0']:
            invalid=mail(numbered,meat=100)
            invalid['command']['raffle_id']=ref
            assert sql('select public.bot_ingest_mail('+lit(json.dumps(invalid))+');')=='raffle_refund'
        assert sql('select count(*)=count(distinct raffle_number) from public.mystery_raffles')=='t'
        from concurrent.futures import ThreadPoolExecutor
        def concurrent_number(_):
            query=f"insert into public.mystery_raffles(creator_id,name,ticket_price,ends_at,raffle_number) select creator_id,'Concurrent number fixture',100,now()+interval '1 day',1001 from public.mystery_raffles where id='{numbered}' returning raffle_number;"
            result=subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',query],capture_output=True,text=True,check=True)
            return int(result.stdout.strip())
        with ThreadPoolExecutor(max_workers=4) as pool:
            assigned=list(pool.map(concurrent_number,range(8)))
        assert len(set(assigned))==8 and min(assigned)>int(number)
        # Parser upgrade: old rejected ordinary KMail must not become a purchase.
        import copy
        replay=mail(numbered,meat=1234)
        replay['raw']={'type':'normal','message':'RAFFLE '+number}
        replay['command']={'type':'unknown'}
        ingest(replay)
        reparsed=copy.deepcopy(replay)
        reparsed['command']={'type':'raffle','raffle_id':number}
        original=sql(f"select payload from khub_bot.receipts where mail_id='{replay['id']}'")
        before_replay=liabilities()
        for state in ['pending','unknown','sent']:
            sql(f"update khub_bot.deliveries set state='{state}' where receipt_id='{replay['id']}'")
            assert ingest(reparsed)=='duplicate'
            handled=json.loads(sql('select public.bot_handled_mail('+lit(json.dumps([reparsed]))+');'))
            assert replay['id'] in handled
            assert sql(f"select payload from khub_bot.receipts where mail_id='{replay['id']}'")==original
            assert sql(f"select count(*) from khub_bot.raffle_purchases where receipt_id='{replay['id']}'")=='0'
        assert sql(f"select count(*) from khub_bot.deliveries where receipt_id='{replay['id']}'")=='1'
        for key,value in [('meat',999),('sender_id',48889603),('raw',{'type':'normal','message':'altered'})]:
            changed=copy.deepcopy(reparsed);changed[key]=value
            sql('select public.bot_ingest_mail('+lit(json.dumps(changed))+');',error='Receipt payload conflict')
        gift_replay=copy.deepcopy(reparsed);gift_replay['raw']['gift_original']={}
        sql('select public.bot_ingest_mail('+lit(json.dumps(gift_replay))+');',error='Gift contents have not been verified')
        print('PASS: parser-upgrade rejected replays preserve receipts and refunds; changed assets, sender, raw mail and unverified gifts remain blocked')
        # Analytics must stay private and count purchases once, independently of settlement.
        call("select public.read_admin_raffle_analytics()",uid=buyer,error='Administrator required')
        call(f"select public.read_admin_raffle_participants('{canceled}')",uid=buyer,error='Administrator required')
        assert sql("select has_function_privilege('anon','public.read_admin_raffle_analytics(integer)','execute')")=='f'
        analytics=json.loads(call('select public.read_admin_raffle_analytics()'))
        assert analytics['revenue']==sql('select coalesce(sum(meat),0)::text from khub_bot.raffle_purchases')
        assert analytics['tickets']==sql('select coalesce(sum(last_ticket-first_ticket+1),0)::text from khub_bot.raffle_purchases')
        assert analytics['participants']==int(sql('select count(distinct player_id) from khub_bot.raffle_purchases'))
        for person in analytics['people']:
            assert person['revenue']==sql(f"select sum(meat)::text from khub_bot.raffle_purchases where player_id={person['player_id']}")
        for current in analytics['current']:
            expected=json.loads(call(f"select public.read_admin_raffle_participants('{current['id']}')"))
            actual=[{k:v for k,v in row.items() if k!='sort_tickets'} for row in current['participants_page']]
            assert actual==expected
            assert len(actual)<=50

        assert len(json.loads(call(f"select public.read_admin_raffle_participants('{canceled}')")))==1
        # Snapshot only the selected outcome, freeze quantity and price, never reprice it.
        valued=create_raffle()
        sql(f"update public.mystery_raffles set ends_at=now()+interval '1 day' where id='{valued}';")
        sql("insert into khub_bot.market_prices(item_id,price_meat,observed_at,checked_at,available) values(2,123,now(),now(),true) on conflict(item_id) do update set price_meat=123,observed_at=now(),checked_at=now(),available=true;")
        sql(f"update public.mystery_raffles set selected_outcome=1 where id='{valued}';")
        assert sql(f"select price_meat from khub_bot.raffle_market_prices where raffle_id='{valued}'")=='123'
        sql('update khub_bot.market_prices set price_meat=999 where item_id=2;')
        assert sql(f"select price_meat from khub_bot.raffle_market_prices where raffle_id='{valued}'")=='123'
        assert json.loads(call('select public.read_admin_raffle_analytics()'))['unavailable']>=0
        print('PASS: admin-only raffle analytics, exact purchase totals and immutable selected-prize snapshot')
        # A reversible classification excludes tests from every analytics aggregate.
        before_test=json.loads(call('select public.read_admin_raffle_analytics()'))
        financial_before=sql("select jsonb_build_object('receipts',(select count(*) from khub_bot.receipts),'purchases',(select jsonb_agg(to_jsonb(p) order by receipt_id) from khub_bot.raffle_purchases p),'accounts',(select jsonb_agg(to_jsonb(a) order by raffle_id) from khub_bot.raffle_accounts a),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d))")
        sql("update public.mystery_raffles set is_test=true")
        hidden=json.loads(call('select public.read_admin_raffle_analytics()'))
        for key in ['revenue','tickets','refundable_revenue']: assert hidden[key]=='0'
        assert hidden['participants']==0 and hidden['unavailable']==0
        for key in ['people','current','past']: assert hidden[key]==[]
        for key in ['profit','prize_value']: assert hidden[key] is None
        assert json.loads(call(f"select public.read_admin_raffle_participants('{canceled}')"))
        financial_after=sql("select jsonb_build_object('receipts',(select count(*) from khub_bot.receipts),'purchases',(select jsonb_agg(to_jsonb(p) order by receipt_id) from khub_bot.raffle_purchases p),'accounts',(select jsonb_agg(to_jsonb(a) order by raffle_id) from khub_bot.raffle_accounts a),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d))")
        assert financial_after==financial_before
        sql("update public.mystery_raffles set is_test=false")
        assert json.loads(call('select public.read_admin_raffle_analytics()'))==before_test
        assert sql("select has_column_privilege('authenticated','public.mystery_raffles','is_test','UPDATE')")=='f'
        print('PASS: test flag excludes all analytics, preserves financial records, and reverses cleanly')

        # Ordinary failed intake reserves exact assets, survives restart, and
        # atomically hands protection to normal receipt/raffle obligations.
        isolated_raffle=create_raffle()
        stuck=mail(isolated_raffle,meat=300)
        stuck['raw']['message']='RAFFLE '+isolated_raffle
        before_hold=liabilities()
        assert json.loads(sql('select public.bot_isolate_raffle_intake('+lit(json.dumps(stuck))+');'))['state']=='isolated'
        assert int(liabilities()['meat'])==int(before_hold['meat'])+300
        assert json.loads(sql('select public.bot_isolate_raffle_intake('+lit(json.dumps(stuck))+');'))['state']=='isolated'
        assert int(liabilities()['meat'])==int(before_hold['meat'])+300
        assert json.loads(sql('select public.bot_raffle_draw_work()'))==[]
        restart()
        assert any(row['id']==stuck['id'] for row in json.loads(sql('select public.bot_pending_raffle_intake()')))
        changed=copy.deepcopy(stuck);changed['meat']=400
        sql('select public.bot_ingest_mail('+lit(json.dumps(changed))+');',error='Isolated payload conflict')
        protected=liabilities()
        assert ingest(stuck)=='raffle_tickets'
        assert liabilities()==protected
        assert json.loads(sql('select public.bot_isolate_raffle_intake('+lit(json.dumps(stuck))+');'))['state']=='committed'
        assert not any(row['id']==stuck['id'] for row in json.loads(sql('select public.bot_pending_raffle_intake()')))
        unverified=mail(isolated_raffle,meat=100)
        unverified['raw']={'type':'normal','gift_original':{}}
        sql('select public.bot_isolate_raffle_intake('+lit(json.dumps(unverified))+');',error='Gift contents have not been verified')
        print('PASS: isolated intake holds survive restart, block raffle generation, release atomically on commit and never double-count verified gifts')
        # Deadline eligibility follows KoL receipt time, not processing time.
        boundary=create_raffle()
        end=sql("select date_trunc('second',clock_timestamp())-interval '120 seconds'")
        sql(f"update public.mystery_raffles set ends_at='{end}' where id='{boundary}'")
        ontime=mail(boundary,meat=200);late=mail(boundary,meat=100)
        def stamp(payload,when):
            payload['received_at']=when
            payload['raw']['azunixtime']=str(int(datetime.fromisoformat(when).timestamp()))
        stamp(ontime,sql(f"select '{end}'::timestamptz-interval '1 second'"))
        stamp(late,end)
        assert json.loads(sql('select public.bot_raffle_draw_work()'))==[], 'old scans cannot authorize a new closing'
        scan=json.loads(sql('select public.bot_begin_inbox_scan()'))
        sql(f"select public.bot_stage_inbox_scan('{scan['id']}',{lit(json.dumps([ontime,late]))});")
        assert json.loads(sql('select public.bot_raffle_draw_work()'))==[]
        assert ingest(ontime)=='raffle_tickets'
        assert ingest(late)=='raffle_refund'
        assert account_value(boundary,'ticket_count')=='2'
        assert json.loads(sql('select public.bot_raffle_draw_work()'))==[], 'staged but unfinished scan must not authorize drawing'
        sql(f"select public.bot_finish_inbox_scan('{scan['id']}');")
        work=json.loads(sql('select public.bot_raffle_draw_work()'))
        assert any(row['raffleId']==boundary for row in work)
        selected=next(row for row in work if row['raffleId']==boundary)
        assert [p['receiptId'] for p in selected['purchases']]==[ontime['id']]
        assert ingest(ontime)=='duplicate'
        forged=create_raffle();bad=mail(forged,meat=100);bad['raw']['azunixtime']='1'
        sql('select public.bot_ingest_mail('+lit(json.dumps(bad))+');',error='Invalid KoL raffle timestamp')
        print('PASS: before-deadline mail accepted after closing; exact-deadline refund; draw waits for full scan and durable intake; forged timestamps rejected')
        # The public result projection exposes only winner identity and the
        # displayed winning label, while preserving the temporary tester gate.
        public_result=json.loads(call(f"select public.read_raffle_result('{gift_raffle}')",uid=buyer))
        assert set(public_result)=={'winner_name','profile_id','winning_ticket'}
        assert public_result['winner_name']
        assert public_result['winning_ticket']==sql(f"select ((draw_result->>'winningTicket')::numeric+ticket_label_offset)::text from khub_bot.raffle_accounts where raffle_id='{gift_raffle}'")
        call(f"select public.read_raffle_result('{gift_raffle}')",uid=other,error='Raffle access required')
        assert sql("select has_function_privilege('anon','public.read_raffle_result(uuid)','execute')")=='f'
        assert call(f"select public.read_raffle_result('{forged}')",uid=buyer)==''
        # New-protocol database checks. Historical round 42 is used only as a signed
        # offline fixture; production scheduling is separately tested below.
        fair=create_raffle(fair=True)
        assert ingest(mail(fair,meat=500))=='raffle_tickets'
        sql(f"update public.mystery_raffles set ends_at=clock_timestamp()-interval '31 minutes' where id='{fair}'")
        scan=json.loads(sql('select public.bot_begin_inbox_scan()'))
        sql(f"select public.bot_stage_inbox_scan('{scan['id']}','[]');select public.bot_finish_inbox_scan('{scan['id']}');")
        fair_work=json.loads(sql('set role service_role;select public.bot_raffle_draw_work()'))
        committed=next(row for row in fair_work if row['raffleId']==fair)
        assert committed['fairness']['commitmentHash']==hashlib.sha256(committed['fairness']['manifest'].encode()).hexdigest()
        frow=json.loads(sql(f"select to_jsonb(f) from khub_bot.raffle_fairness f where raffle_id='{fair}'"))
        assert sql(f"select to_timestamp(1692803367+(round-1)*3)>=committed_at+interval '120 seconds' from khub_bot.raffle_fairness where raffle_id='{fair}'")=='t'
        restart()
        assert next(row for row in json.loads(sql('select public.bot_raffle_draw_work()')) if row['raffleId']==fair)==committed
        sql(f"update khub_bot.raffle_fairness set round=round+1 where raffle_id='{fair}'",error='immutable')
        for change in ["draw_input='{}'",'ticket_count=ticket_count+1','ticket_label_offset=ticket_label_offset+1','fair_required=false']:
            sql(f"update khub_bot.raffle_accounts set {change} where raffle_id='{fair}'",error='immutable')
        sql(f"select public.bot_commit_raffle_draw('{fair}','{{}}')",error='Invalid fairness proof')
        summary=json.loads(call(f"select public.read_raffle_fairness_summary('{fair}')",uid=buyer))
        assert not {'manifest','ticketCount','prizes','draw_input','ticket_label_offset'} & summary.keys()
        assert summary['commitmentHash']==frow['commitment_hash'] and not summary['complete']
        for rpc in ['read_raffle_fairness_summary','read_raffle_fairness_proof']:
            call(f"select public.{rpc}('{fair}')",uid=other,error='Raffle access required')
            assert sql(f"select has_function_privilege('anon','public.{rpc}(uuid)','execute')")=='f'
        sql('set role authenticated;select * from khub_bot.raffle_fairness',uid=buyer,error='permission denied')
        # Simulate a historical commitment in this disposable database only. No
        # real wait, live raffle or production timestamp is changed by these tests.
        sql(f"delete from khub_bot.raffle_fairness where raffle_id='{fair}'")
        manifest=committed['fairness']['manifest'].split('\n');manifest[2]='42';manifest='\n'.join(manifest)
        commitment=hashlib.sha256(manifest.encode()).hexdigest()
        sql(f"insert into khub_bot.raffle_fairness(raffle_id,committed_at,round,manifest,commitment_hash) values('{fair}','2023-08-23T15:08:00Z',42,{lit(manifest)},'{commitment}')")
        committed['fairness'].update(round=42,manifest=manifest,commitmentHash=commitment)
        beacon={'round':42,'randomness':'8ada64bae5c6c0f5540a6a13af56e663240edfbd2c76ac6a8f27671eb7259ce3','signature':'95a9f9f5b231b7714de1553105d8ffdf3dcda24cfdb1e689319bccf79a9c8ce430a91b811fbfaf763900bc998b5d686a'}
        node_code="import{readFileSync}from'node:fs';import{createFairRaffleDraw}from'./bot/src/raffle-beacon.mjs';import{createRaffleDraw}from'./bot/src/raffle-draw.mjs';const x=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(createFairRaffleDraw(x.input,x.beacon,createRaffleDraw)));"
        result=json.loads(subprocess.run(['node','--input-type=module','-e',node_code],input=json.dumps(dict(input=committed,beacon=beacon)),text=True,capture_output=True,cwd=ROOT,check=True).stdout)
        bad_result={**result,'winningTicket':'99999'}
        sql(f"select public.bot_commit_raffle_draw('{fair}',{lit(json.dumps(bad_result))})",error='does not match beacon')
        command=f"set role service_role;select public.bot_commit_raffle_draw('{fair}',{lit(json.dumps(result))})"
        concurrent=[subprocess.Popen([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',command],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
        for client in concurrent:
            _,failure=client.communicate()
            assert client.returncode==0,failure
        assert json.loads(account_value(fair,'draw_result'))['method']=='khub-drand-quicknet-sha256-v1'
        sql(f"select public.bot_commit_raffle_draw('{fair}','{{}}')")
        proof=json.loads(call(f"select public.read_raffle_fairness_proof('{fair}')",uid=buyer))
        public_record=json.loads(sql(f"set role anon;select public.read_public_raffle_commitment('{fair}')"))
        assert set(public_record)=={'raffleId','method','commitmentHash','committedAt','round','chainHash','beaconAvailableAt','complete'}
        assert public_record['commitmentHash']==commitment
        assert public_record['round']==42
        assert public_record['complete'] is True

        assert set(proof)=={'method','raffleId','committedAt','round','manifest','commitmentHash','beacon','result','displayedWinningTicket','prizes'}
        assert 'purchases' not in json.dumps(proof) and 'playerId' not in json.dumps(proof) and 'receiptId' not in json.dumps(proof)
        verification="import{readFileSync}from'node:fs';import{verifyRaffleProof}from'./src/lib/raffleProof.js';console.log(JSON.stringify(await verifyRaffleProof(JSON.parse(readFileSync(0,'utf8')))));"
        verified=subprocess.run(['node','--input-type=module','-e',verification],input=json.dumps(proof),text=True,capture_output=True,cwd=ROOT)
        assert verified.returncode==0,verified.stderr
        assert json.loads(verified.stdout)['winningTicket']==proof['displayedWinningTicket']
        assert json.loads(call(f"select public.read_raffle_fairness_summary('{fair}')",uid=buyer))['complete']
        sql(f"update khub_bot.raffle_fairness set result='{{}}' where raffle_id='{fair}'",error='immutable')
        sql(f"update khub_bot.raffle_fairness set beacon='{{}}' where raffle_id='{fair}'",error='immutable')
        assert sql(f"select count(*) from khub_bot.deliveries where dedupe_key like 'raffle:{fair}:prize:%'")=='0', 'drawing alone must not send or queue unowned prizes'
        # Simulated delivery evidence, never a real send: uncertainty must still
        # block settlement under the new draw method, just as under legacy draws.
        assert ingest(mail(fair,'raffle_supply',0,[dict(id=2,quantity=3)],48889601))=='raffle_supply'
        for _ in range(5): tick()
        assert sql(f"select count(*) from khub_bot.deliveries where dedupe_key like 'raffle:{fair}:prize:%'")=='1'
        sql(f"update khub_bot.deliveries set state='unknown' where dedupe_key like 'raffle:{fair}:prize:%'")
        for _ in range(3): tick()
        assert sql(f"select state from public.mystery_raffles where id='{fair}'")=='fulfilling'
        assert account_value(fair,'held_meat')=='500'
        assert sql(f"select count(*) from khub_bot.deliveries where dedupe_key like 'raffle:{fair}:proceeds:%'")=='0'
        # Local fixture evidence only: mark this raffle's obligations verified.
        for _ in range(12):
            sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where dedupe_key like 'raffle:{fair}:%'")
            tick()
        assert sql(f"select state from public.mystery_raffles where id='{fair}'")=='settled'
        assert account_value(fair,'held_meat')=='0'
        assert json.loads(call(f"select public.read_raffle_fairness_proof('{fair}')",uid=buyer))==proof
        assert json.loads(sql(f"set role anon;select public.read_public_raffle_commitment('{fair}')"))==public_record
        assert sql(f"set role anon;select public.read_public_raffle_commitment('{forged}')")==''

        print('PASS: immutable pre-beacon commitment, restart, permissions, deterministic SQL/Node/browser verification of winner and prize, no private-ledger disclosure')
        # More than five pending rounds cannot starve later raffles.
        queued=[create_raffle(fair=True) for _ in range(6)]
        for pending_id in queued:
            assert ingest(mail(pending_id,meat=100))=='raffle_tickets'
            sql(f"update public.mystery_raffles set ends_at=clock_timestamp()-interval '31 minutes' where id='{pending_id}'")
        scan=json.loads(sql('select public.bot_begin_inbox_scan()'))
        sql(f"select public.bot_stage_inbox_scan('{scan['id']}','[]');select public.bot_finish_inbox_scan('{scan['id']}');")
        seen=set();commitments={}
        for _ in range(4):
            batch=json.loads(sql('select public.bot_raffle_draw_work()'))
            assert len(batch)<=5
            for entry in batch:
                if entry['raffleId'] in queued:
                    seen.add(entry['raffleId'])
                    previous=commitments.setdefault(entry['raffleId'],entry['fairness'])
                    assert previous==entry['fairness']
        assert seen==set(queued)
        print('PASS: pending beacon rounds rotate without starving later raffles or changing commitments')
        access=json.loads(call('select public.read_my_account_access()',uid=buyer))
        assert access['is_high_rollers_member'] and access['access_version']==1
        assert access['can_view_raffles'] and not access['is_admin'] and access['invitation_version'] is None
        admin_access=json.loads(call('select public.read_my_account_access()',uid=seller))
        assert admin_access['is_admin'] and admin_access['can_view_raffles']
        assert not json.loads(call('select public.read_my_account_access()',uid=seller))['is_high_rollers_member']
        history=json.loads(call('select public.read_my_raffle_history()',uid=buyer))
        assert len(history)<=50 and history
        for row in history:
            assert row['tickets']==sql(f"select sum(last_ticket-first_ticket+1)::text from khub_bot.raffle_purchases where raffle_id='{row['id']}' and player_id=48889602")
            assert row['ticket_price']==sql(f"select ticket_price from public.mystery_raffles where id='{row['id']}'")
            assert not {'player_id','receipt_id','revenue','ticket_count'} & row.keys()
        for viewer in [other,seller]:
            assert json.loads(call('select public.read_my_raffle_history()',uid=viewer))==[]
        assert sql("select has_function_privilege('anon','public.read_my_raffle_history(integer)','execute')")=='f'
        call("select public.remove_high_rollers_member('48889602')")
        assert json.loads(call('select public.read_my_raffle_history()',uid=buyer))
        print('PASS: self-only bounded raffle history and exact personal ticket totals for verified players')
        sql("update khub_bot.catalog set name='colored-light &quot;necklace&quot;' where id=2")
        assert sql('select name from khub_bot.catalog where id=2')=='colored-light "necklace"'
        sql(f"update public.auctions set item='colored-light &quot;necklace&quot;' where id='{escrow}'")
        assert sql(f"select item from public.auctions where id='{escrow}'")=='colored-light "necklace"'
        print('PASS: quotation entities normalize to plain catalog and auction names')
        # A real Direct lifecycle, using only the disposable database. The summary
        # must match the full reader across parties, unrelated viewers and feedback.
        direct=create(escrow=False)
        call(f"select public.place_bid('{direct}',100);",uid=buyer)
        sql(f"update public.auctions set created_at=clock_timestamp()-interval '1 day',end_time=clock_timestamp()-interval '1 minute' where id='{direct}';select public.finalize_auction('{direct}');")
        for viewer in [seller,buyer,other]:
            full=json.loads(call('select public.read_pending_trades()',uid=viewer))
            summary=json.loads(call('select public.read_pending_trade_summary()',uid=viewer))
            assert set(summary)=={'privacy_version','total'} and summary['privacy_version']==1
            assert summary['total']==full['total'], (summary,full)
            if viewer in [seller,buyer]: assert summary['total']>0
            else: assert summary['total']==0
        assert sql("select has_function_privilege('anon','public.read_pending_trade_summary()','execute')")=='f'
        call(f"select public.confirm_auction_trade('{direct}')",uid=buyer)
        assert json.loads(call('select public.read_pending_trade_summary()',uid=buyer))['total']==json.loads(call('select public.read_pending_trades()',uid=buyer))['total']
        # Compare warm plans on the same role/data; print measured local execution
        # times without a flaky timing assertion or a production capacity claim.
        import statistics
        timings={}
        for rpc in ['read_pending_trades','read_pending_trade_summary']:
            durations=[]
            for _ in range(5):
                plan=json.loads(call(f'explain (analyze,buffers,format json) select public.{rpc}()',uid=seller))
                durations.append(plan[0]['Execution Time'])
            timings[rpc]=statistics.median(durations)
        print('LOCAL pending-trade plan median execution milliseconds:',json.dumps(timings))
        print('PASS: pending summary matches full eligibility, reveals no cards, preserves feedback and financial definitions')
        # New worker scheduling: safety fields remain fresh and service-only.
        full_status=json.loads(sql('select public.bot_worker_status()'))
        safety=json.loads(sql('select public.bot_worker_safety()'))
        for key in ['attention','isolatedDeliveryAttention','closetAttention','mailPolicyAttention','accountRequestsPending','siteMaintenanceOwned','closetRecoveryReviewKey']:
            assert safety[key]==full_status[key],key
        assert safety['capabilityRevision']==231 and full_status['workerSchedulingVersion']==1
        for signature in ['bot_worker_safety()','bot_cycle_plan()','bot_raffle_tick_due()','bot_defer_raffle_draw(uuid,bigint,boolean)']:
            for role in ['anon','authenticated']:
                assert sql(f"select has_function_privilege('{role}','public.{signature}','execute')")=='f'
        # Make 110 separate purchases in one offline transaction. No game calls.
        call("select public.add_high_rollers_member('48889602')")
        if call("select public.read_my_high_rollers_invitation()",uid=buyer):call("select public.respond_high_rollers_invitation(true,'1')",uid=buyer)
        large=create_raffle()
        payments=[mail(large,meat=100) for _ in range(110)]
        results=sql('set role service_role;select public.bot_ingest_mail(value) from jsonb_array_elements('+lit(json.dumps(payments))+');').splitlines()
        assert results==['raffle_tickets']*110
        call(f"select public.cancel_mystery_raffle('{large}')")
        def queued_refunds():return int(sql(f"select count(*) from khub_bot.deliveries where dedupe_key like 'raffle:{large}:refund:%'"))
        before=liabilities()
        sql('select public.bot_raffle_tick_due()')
        assert queued_refunds()==50 and account_value(large,'held_meat')=='6000'
        assert liabilities()==before, 'partial refunds changed total liabilities'
        sql('begin;select public.bot_raffle_tick_due();rollback;')
        assert queued_refunds()==50 and account_value(large,'held_meat')=='6000'
        restart()
        sql('select public.bot_raffle_tick_due()')
        assert queued_refunds()==100 and account_value(large,'held_meat')=='1000'
        parallel=[subprocess.Popen([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c','set role service_role;select public.bot_raffle_tick_due();'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
        for client in parallel:
            _,failure=client.communicate()
            assert client.returncode==0,failure
        assert queued_refunds()==110 and account_value(large,'held_meat')=='0'
        assert liabilities()==before and account_value(large,'settlement_queued')=='t'
        sql('select public.bot_raffle_tick_due()')
        assert queued_refunds()==110
        assert sql(f"select state from public.mystery_raffles where id='{large}'")=='returning'
        # An idle waiting raffle does not rewrite its work timestamp repeatedly.
        sql(f"delete from khub_bot.raffle_work_wakeups where raffle_id='{large}';update khub_bot.raffle_accounts set next_work_at=clock_timestamp()+interval '1 minute' where raffle_id='{large}';")
        stamp=account_value(large,'last_work_at')
        sql('select public.bot_raffle_tick_due()')
        assert account_value(large,'last_work_at')==stamp
        # Verified delivery state changes wake finalization immediately.
        sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where dedupe_key like 'raffle:{large}:%';")
        assert sql(f"select exists(select 1 from khub_bot.raffle_work_wakeups where raffle_id='{large}')")=='t'
        sql('select public.bot_raffle_tick_due()')
        assert sql(f"select state from public.mystery_raffles where id='{large}'")=='settled'
        assert queued_refunds()==110
        # Beacon retry schedule persists, never changes the committed round/hash.
        deferred=queued[0]
        committed_before=sql(f"select commitment_hash||':'||round from khub_bot.raffle_fairness where raffle_id='{deferred}'")
        round_number=sql(f"select round from khub_bot.raffle_fairness where raffle_id='{deferred}'")
        sql(f"select public.bot_defer_raffle_draw('{deferred}',{round_number},true)")
        assert account_value(deferred,'draw_failures')=='1'
        sql(f"select public.bot_defer_raffle_draw('{deferred}',{int(round_number)+1},true)")
        assert account_value(deferred,'draw_failures')=='1'
        assert sql(f"select next_work_at>clock_timestamp() from khub_bot.raffle_accounts where raffle_id='{deferred}'")=='t'
        due_inputs=json.loads(sql('select public.bot_raffle_draw_work_due()'))
        assert all(entry['raffleId']!=deferred for entry in due_inputs)
        restart()
        assert account_value(deferred,'draw_failures')=='1'
        assert sql(f"select commitment_hash||':'||round from khub_bot.raffle_fairness where raffle_id='{deferred}'")==committed_before
        print('PASS: fresh safety equivalence, service-only scheduling, bounded refunds, exact partial liabilities, rollback, restart, wakeups and immutable deferred draw')
        gift_probe=json.loads(sql("""begin;
        insert into khub_bot.incoming_gifts(mail_id,wrapper_id,envelope,payload,opened_at)
        select (910000000+n)::text,1167,jsonb_build_object('id',(910000000+n)::text),jsonb_build_object('id',(910000000+n)::text,'fixture',repeat('x',2000)),clock_timestamp() from generate_series(1,300)n;
        insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result)
        select (910000000+n)::text,48889602,clock_timestamp(),'{}'::jsonb,'fixture' from generate_series(1,300)n;
        insert into khub_bot.incoming_gifts(mail_id,wrapper_id,envelope,payload)
        values('910001000',1167,'{"id":"910001000"}','{"id":"910001000"}'),('910001001',1167,'{"id":"910001001"}',null);
        insert into khub_bot.gift_mail_reviews(mail_id,raw,evidence)values('910001002','{"id":"910001002"}','offline fixture');
        with original as(select public.bot_gift_intake_state() v),scoped as(select public.bot_gift_intake_state_scoped(array['910000001']) v)
        select jsonb_build_object('old_bytes',length(original.v::text),'new_bytes',length(scoped.v::text),
        'observed',exists(select 1 from jsonb_array_elements(scoped.v->'mails') m where m->>'id'='910000001'),
        'historical_omitted',not exists(select 1 from jsonb_array_elements(scoped.v->'mails') m where m->>'id'='910000002'),
        'unposted',exists(select 1 from jsonb_array_elements(scoped.v->'mails') m where m->>'id'='910001000'),
        'unopened',exists(select 1 from jsonb_array_elements(scoped.v->'mails') m where m->>'id'='910001001'),
        'holds_equal',original.v->'isolated'=scoped.v->'isolated' and original.v->'attempt'=scoped.v->'attempt' and original.v->'review_mail'=scoped.v->'review_mail' and original.v->'reviews'=scoped.v->'reviews') from original,scoped;
        rollback;"""))
        assert all(gift_probe[key] for key in ['observed','historical_omitted','unposted','unopened','holds_equal']),gift_probe
        assert gift_probe['new_bytes']<gift_probe['old_bytes']/2,gift_probe
        for role in ['anon','authenticated']:
            assert sql(f"select has_function_privilege('{role}','public.bot_gift_intake_state_scoped(text[])','execute')")=='f'
        sql("select public.bot_gift_intake_state_scoped(array['bad-id'])",error='Invalid complete inbox IDs')
        print('PASS: scoped gifts omit posted history, preserve observed/unposted/unresolved state and global holds; payload bytes',json.dumps(gift_probe))
        # Larger posted history tests selection work, not only returned bytes.
        sql("""insert into khub_bot.incoming_gifts(mail_id,wrapper_id,envelope,payload,opened_at)
        select (920000000+n)::text,1167,jsonb_build_object('id',(920000000+n)::text),jsonb_build_object('id',(920000000+n)::text,'fixture',repeat('x',2000)),clock_timestamp() from generate_series(1,5000)n;
        insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result)
        select (920000000+n)::text,48889602,clock_timestamp(),'{}'::jsonb,'fixture' from generate_series(1,5000)n;""")
        for ids in ["array[]::text[]","array['920000001','920000002']"]:
            pair=json.loads(sql(f"select jsonb_build_object('old',khub_bot.before_234_bot_gift_intake_state_scoped({ids}),'new',public.bot_gift_intake_state_scoped({ids}))"))
            assert pair['old']==pair['new'],pair
        for rpc in ['khub_bot.before_234_bot_gift_intake_state_scoped','public.bot_gift_intake_state_scoped']:
            measurements=[]
            for _ in range(5):
                plan=json.loads(sql(f"explain(analyze,buffers,format json) select {rpc}(array['920000001'])"))[0]
                measurements.append([plan['Execution Time'],plan['Plan'].get('Shared Hit Blocks')])
            print(rpc,'5000 posted-gift fixture [ms,shared hits]:',measurements)
        # Posted gifts outside the observed inbox still belong in scoped state
        # when referenced by either side of an isolated attempt or open review.
        pair=json.loads(sql("""begin;
        insert into khub_bot.gift_open_attempts(wrapper_id,state,mail_id,before_state)
        values(1167,'isolated','920000001','{"requested_mail_id":"920000002"}');
        insert into khub_bot.gift_mail_reviews(mail_id,raw,evidence)
        values('920000003','{}','Offline review coverage fixture');
        update khub_bot.incoming_gifts set legacy_donation=true where mail_id='920000003';
        select jsonb_build_object('old',khub_bot.before_234_bot_gift_intake_state_scoped(array[]::text[]),
          'new',public.bot_gift_intake_state_scoped(array[]::text[]));
        rollback;"""))
        assert pair['old']==pair['new'],pair
        assert {'920000001','920000002','920000003'} <= {m['id'] for m in pair['new']['mails']}
        print('PASS: scoped state retains both isolated-attempt IDs and reviewed legacy evidence outside the observed inbox')
        # Per-raffle audience: a verified nonmember sees and buys public raffles,
        # while club-only raffles remain hidden and reject payment with a refund.
        call("select public.remove_high_rollers_member('48889602')")
        public_id=str(uuid4())
        prizes='[{"id":2,"quantity":3,"probability_bps":10000}]'
        call(f"select public.publish_mystery_raffle('{public_id}','Open raffle',100,now()+interval '1 day',{lit(prizes)}::jsonb,'public')")
        assert call(f"select audience from public.mystery_raffles where id='{public_id}'")=='public'
        assert call(f"select count(*) from public.mystery_raffles where id='{public_id}'",uid=buyer)=='1'
        assert call(f"select count(*) from public.mystery_raffle_prizes where raffle_id='{public_id}'",uid=buyer)=='1'
        assert call(f"select public.can_view_raffle('{public_id}')",uid=buyer)=='t'
        assert call(f"select public.read_raffle_fairness_summary('{public_id}')",uid=buyer)
        private_id=create_raffle()
        assert call(f"select count(*) from public.mystery_raffles where id='{private_id}'",uid=buyer)=='0'
        assert call(f"select public.can_view_raffle('{private_id}')",uid=buyer)=='f'
        call(f"select public.read_raffle_fairness_summary('{private_id}')",uid=buyer,error='Raffle access required')
        public_mail=mail(public_id,meat=100)
        assert ingest(public_mail)=='raffle_tickets'
        assert ingest(public_mail)=='duplicate'
        assert sql(f"select count(*) from khub_bot.raffle_purchases where receipt_id='{public_mail['id']}'")=='1'
        private_mail=mail(private_id,meat=100)
        assert ingest(private_mail)=='raffle_refund'
        assert sql(f"select count(*) from khub_bot.raffle_purchases where receipt_id='{private_mail['id']}'")=='0'
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{private_mail['id']}' and kind='refund'")=='100'
        print('PASS: public entry accepts verified nonmembers; club-only entry hides details and refunds payments')
        print('PASS: full-schema lifecycle and isolation: identical items, concurrent auction/raffle Meat, exact solvency, proof guards, retries, restarts, cancellation and schema permissions')
    finally:
        if started: pg('-m','immediate','-w','stop')
