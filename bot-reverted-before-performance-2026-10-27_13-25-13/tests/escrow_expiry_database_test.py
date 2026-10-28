"""Exercise unfunded escrow expiry against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/escrow_expiry_database_test.py
"""
import json
from concurrent.futures import ThreadPoolExecutor
import time
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-expiry-',dir='/tmp') as folder:
    data=Path(folder)/'data'
    subprocess.run([str(BIN/'initdb'),'-D',str(data),'-A','trust','--no-locale'],check=True,capture_output=True)
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
            create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
            grant usage on schema public,auth to anon,authenticated,service_role;
            grant execute on function auth.uid() to anon,authenticated;
        ''')
        migrations=sorted([*ROOT.glob('supabase/migrations/*.sql'),*ROOT.glob('supabase/migrations/queue/*.sql')],key=lambda p:p.name)
        assert len({p.name for p in migrations})==len(migrations)
        # Pre-batching upgrade fixture; receipt_time_database_test.py exercises 079.
        migrations=[p for p in migrations if p.name<'202610220079_']
        expiry_migration=next(path for path in migrations if path.name.startswith('202610220074_'))
        for migration in migrations:
            if migration!=expiry_migration: sql(migration.read_text())
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

        seller,_=account(89501,48889501,'Expiry Seller')
        buyer,_=account(89502,48889502,'Expiry Buyer')
        def seed(hours=25,status='pending_escrow',escrow=True,deposited=False,bid=False):
            ident=str(uuid4())
            sql(f"""insert into public.auctions(id,seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,
                item_id,seller_kol_id,escrow_mode,created_at,end_time,current_bid,status,item_escrowed_at)
                values('{ident}','{seller}','Expiry Seller','Expiry fixture',1,100,24,2,48889501,
                    {'true' if escrow else 'false'},clock_timestamp()-interval '{hours} hours',clock_timestamp()+interval '1 day',
                    {100 if bid else 0},'{status}',{'clock_timestamp()' if deposited else 'null'});""")
            if bid: sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{ident}','{buyer}','Expiry Buyer',100);")
            return ident
        expired=seed()
        boundary=seed(hours=24)
        fresh=seed(hours=23.99)
        active=seed(status='active',deposited=True)
        direct=seed(status='active',escrow=False)
        funded=seed(deposited=True)
        bid_draft=seed(bid=True)
        linked=seed()
        sql(f"select khub_bot.queue('expiry-support-history','{linked}',null,48889501,'notice',0,'[]','Existing notice.');")
        def assets():
            return sql("select jsonb_build_object('bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d),'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p));")
        before=assets()
        sql(expiry_migration.read_text())
        assert assets()==before
        assert sql(f"select count(*) from public.auctions where id in ('{expired}','{boundary}');")=='0'
        for ident in [fresh,active,direct,funded,bid_draft]: assert sql(f"select count(*) from public.auctions where id='{ident}';")=='1'
        assert sql(f"select status from public.auctions where id='{linked}';")=='cancelled'
        print('PASS: migration expires 24-hour drafts, preserves fresh/funded/active/direct/bid records, retains linked history and leaves all assets, profiles and bids untouched')
        for endpoint in ['select public.finalize_expired_auctions();','select public.bot_tick();']:
            old=seed()
            sql(endpoint)
            assert sql(f"select count(*) from public.auctions where id='{old}';")=='0'
        print('PASS: website finalization and normal bot ticks automatically remove expired drafts')
        def deposit(ident,mid):
            payload={'id':str(mid),'sender_id':48889501,'sender_name':'Expiry Seller','received_at':'2026-10-22T12:00:00Z',
                'command':{'type':'list','auction_id':ident},'meat':0,'items':[{'id':2,'quantity':1}],
                'raw':{'id':str(mid),'fromid':'48889501','fromname':'Expiry Seller','type':'normal','message':'LIST '+ident}}
            return sql('set role service_role; select public.bot_ingest_mail('+lit(json.dumps(payload))+');'),payload
        late=seed()
        result,payload=deposit(late,89510)
        assert result!='accepted',result
        assert sql(f"select count(*) from public.auctions where id='{late}';")=='0'
        assert sql("select count(*) from khub_bot.deliveries where receipt_id='89510' and kind='refund' and item_id=2 and quantity=1;")=='1'
        before_replay=assets()
        sql('set role service_role; select public.bot_ingest_mail('+lit(json.dumps(payload))+');')
        assert assets()==before_replay
        result,_=deposit(fresh,89511)
        assert result=='accepted',result
        assert sql(f"select status='active' and item_escrowed_at is not null and abs(extract(epoch from end_time-item_escrowed_at)-24*3600)<1 from public.auctions where id='{fresh}';")=='t'
        print('PASS: late deposits are returned exactly once even before a tick; timely deposits retain the full auction duration and activate normally')
        # Hold the actual shared lock in one connection while the competing
        # operation runs in another. Neither ordering can lose a deposit.
        def wait_locked():
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                if sql("select exists(select 1 from pg_locks where locktype='advisory' and objid=3888760 and granted and pid<>pg_backend_pid());")=='t': return
                time.sleep(0.01)
            raise AssertionError('Concurrent transaction never acquired the lock')
        timely_race=seed(hours=0)
        outcome,_=deposit(timely_race,89512)
        assert outcome=='accepted'
        # The accepted listing ages past 24h in a holding transaction while
        # cleanup competes for the same lock; its active state protects it.
        with ThreadPoolExecutor(max_workers=1) as executor:
            holding=executor.submit(sql,f"begin; select pg_advisory_xact_lock(3888760); update public.auctions set created_at=clock_timestamp()-interval '25 hours' where id='{timely_race}'; select pg_sleep(1); commit;")
            wait_locked()
            sql('select public.bot_tick();')
            holding.result()
        assert sql(f"select status from public.auctions where id='{timely_race}';")=='active'
        expired_race=seed()
        with ThreadPoolExecutor(max_workers=1) as executor:
            holding=executor.submit(sql,"begin; select khub_bot.expire_unfunded_escrow(); select pg_sleep(1); commit;")
            wait_locked()
            outcome,_=deposit(expired_race,89513)
            holding.result()
        assert outcome!='accepted'
        assert sql("select count(*) from khub_bot.deliveries where receipt_id='89513' and kind='refund' and item_id=2 and quantity=1;")=='1'
        print('PASS: concurrent cleanup/ingestion serialize through the shared lock, preserving active deposits and returning late assets once')
        for role in ['anon','authenticated','service_role']:
            sql(f'set role {role}; select khub_bot.expire_unfunded_escrow();',error='permission denied')
        sql("set role anon; select public.bot_ingest_mail('{}');",error='permission denied')
        print('PASS: private expiry helpers and service-only ingestion permissions preserved')
    finally:
        if started: pg('-m','fast','-w','stop')
