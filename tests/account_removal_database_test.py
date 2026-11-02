"""Guarded BlakAcid removal and financial archive against all migrations.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/account_removal_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-account-removal-',dir='/tmp') as folder:
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
            sql(migration.read_text())
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
            if mid == 98001:
                job['user_id']='2f1159d1-af21-41fb-afd6-2c1a57510bed'
                job['login_email']=f"account-{job['user_id']}@login.khub.invalid"
                sql(f"update khub_bot.account_jobs set user_id='{job['user_id']}',login_email={lit(job['login_email'])} where mail_id='{mid}';")
            metadata=lit(json.dumps({'khub_account_job':str(mid)}))
            sql(f"insert into auth.users(id,email,encrypted_password,raw_app_meta_data,raw_user_meta_data) values('{job['user_id']}',{lit(job['login_email'])},'fixture-hash',{metadata},'{{}}');")
            sql(f"select public.bot_finish_account_job('{mid}');")
            sql(f"insert into auth.sessions values('{uuid4()}','{job['user_id']}');")
            return job['user_id'],payload

        target,_=account(98001,1455915,'BlakAcid')
        other,_=account(98002,48889602,'Other User')
        listing='328f8a5e-12c6-458e-8161-bdfcf3a1f987'
        notice='3f6065df-b6d2-4dc2-948c-c33982487e4b'
        refund='830b799d-8687-44b8-ae57-907d9634e277'
        sql("update khub_bot.deliveries set state='sent',sent_at=now();")
        sql(f"""insert into public.auctions(id,seller_id,seller_username,item,item_id,quantity,min_bid_meat,
            duration_hours,end_time,escrow_mode,seller_kol_id,auction_kind,status)
            values('{listing}','{target}','BlakAcid','seal tooth',2,1,200000000,24,
            now()+interval '1 day',true,1455915,'buy','cancelled');
            insert into khub_bot.buy_orders(auction_id,delivery_mode,funding_required,funded_meat,
                refunded_meat,refund_finalized,close_reason)
            values('{listing}','finished',205110000,205110000,205110000,true,'cancel');
            insert into khub_bot.deliveries(id,dedupe_key,auction_id,recipient_id,kind,meat,message,state,sent_at)
            values('{notice}','fixture-notice','{listing}',1455915,'notice',0,'Cancelled','sent',now()),
                  ('{refund}','fixture-refund','{listing}',1455915,'refund',205110000,'Refund','sent',now());
            insert into khub_bot.buy_order_events(auction_id,kind,delivery_id)
            values('{listing}','refund','{refund}');
            insert into khub_bot.buy_delivery_profiles values('{listing}',false,now());
            insert into public.site_activity(visitor_id,user_id) values('{uuid4()}','{target}');
            insert into khub_bot.verifications values('fixture-token','{target}',now()+interval '1 day');
        """)
        removal=next(ROOT.glob('supabase/migrations/**/202611020166_remove_blakacid_account.sql')).read_text()
        before_auction=sql(f"select to_jsonb(a) from public.auctions a where id='{listing}';")
        before_order=sql(f"select to_jsonb(o) from khub_bot.buy_orders o where auction_id='{listing}';")
        before_deliveries=sql(f"select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d where auction_id='{listing}';")
        sql(f"update khub_bot.deliveries set state='unknown' where id='{refund}';")
        sql(removal,error='Unsent or unresolved')
        assert sql(f"select count(*) from auth.users where id='{target}';")=='1'
        assert sql(f"select count(*) from khub_bot.account_removal_archives;")=='0'
        sql(f"update khub_bot.deliveries set state='sent' where id='{refund}';")
        sql(f"update khub_bot.buy_orders set refund_finalized=false where auction_id='{listing}';")
        sql(removal,error='fully refunded')
        sql(f"update khub_bot.buy_orders set refund_finalized=true where auction_id='{listing}';")
        # Unexpected dependent records abort everything, including the archive and detach.
        sql(f"insert into khub_bot.closet_transfers(dedupe_key,source,auction_id,meat) values('fixture-block','sale_fee','{listing}',1);")
        sql(removal,error='foreign key')
        assert sql(f"select count(*) from auth.users where id='{target}';")=='1'
        assert sql(f"select count(*) from khub_bot.account_removal_archives;")=='0'
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{listing}';")=='2'
        sql("delete from khub_bot.closet_transfers where dedupe_key='fixture-block';")
        sql(removal)
        for table in ['auth.users','auth.sessions','public.profiles']:
            column='user_id' if table=='auth.sessions' else 'id'
            assert sql(f"select count(*) from {table} where {column}='{target}';")=='0'
        assert sql(f"select count(*) from auth.users where id='{other}';")=='1'
        assert sql(f"select count(*) from public.auctions where id='{listing}';")=='0'
        assert sql(f"select count(*) from khub_bot.buy_orders where auction_id='{listing}';")=='0'
        assert sql(f"select count(*) from khub_bot.deliveries where id in ('{notice}','{refund}') and state='sent' and auction_id is null;")=='2'
        archived=json.loads(sql(f"select financial_records from khub_bot.account_removal_archives where user_id='{target}';"))
        assert archived['auction']==json.loads(before_auction)
        assert archived['buy_order']==json.loads(before_order)
        assert archived['deliveries']==json.loads(before_deliveries)
        assert len(archived['buy_order_events'])==1
        assert archived['delivery_profile']['needs_gift'] is False
        for role in ['anon','authenticated','service_role']:
            sql(f"set role {role};select * from khub_bot.account_removal_archives;",error='permission denied')
        sql(removal)
        sql("update khub_bot.account_jobs set created_at=now()-interval '10 minutes' where kol_player_id=1455915;")
        new_user,_=account(98003,1455915,'BlakAcid')
        assert new_user!=target
        assert sql(f"select kol_player_id from public.profiles where id='{new_user}';")=='1455915'
        print('PASS: pending deliveries and unclosed refunds blocked; unexpected FK rolls back; account removed; full financial audit preserved privately; rerun safe; fresh registration succeeds')
    finally:
        if started:pg('-m','immediate','-w','stop')
