"""Giveaway financial and lifecycle safety against ALL local SQL migrations.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/giveaway_database_test.py
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
with tempfile.TemporaryDirectory(prefix='khub-bot-only-expiration-',dir='/tmp') as folder:
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
        ids=iter(range(98100,99000))
        def ingest(aid,kind,meat=0,items=None,actor=48889601,reservation=None):
            mid=str(next(ids))
            epoch=sql('select floor(extract(epoch from clock_timestamp()))::bigint;')
            received=sql(f'select to_timestamp({epoch});')
            payload={'id':mid,'sender_id':actor,'sender_name':'Bundle fixture','received_at':received,
                'command':{'type':kind,'auction_id':aid},'meat':meat,'items':items or [],
                'raw':{'id':mid,'fromid':str(actor),'fromname':'Bundle fixture','type':'normal','message':kind.upper()+' '+aid,'azunixtime':epoch}}
            if reservation: payload['command']['reservation_id']=reservation
            if kind in ('bid','buy','fill'):
                scan=json.loads(sql('select public.bot_begin_inbox_scan();'))['id']
                sql(f"select public.bot_stage_inbox_scan('{scan}',"+lit(json.dumps([payload]))+');')
            query='set role service_role;select public.bot_ingest_mail('+lit(json.dumps(payload))+');'
            return mid,sql(query),query
        def row(aid):return json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{aid}';"))
        sql(f"insert into khub_bot.administrators(user_id,note) values('{seller}','giveaway fixture');")
        def giveaway(escrow=False):
            return call("select public.create_giveaway_auction('seal tooth',1000,1,24,null,null,2,"+str(escrow).lower()+",'Meat Stack Mania');")
        call("select public.create_giveaway_auction('seal tooth',1000,1,24,null,null,2,false,'No');",buyer,error='Administrator')
        aid=giveaway()
        call(f"select public.place_bid('{aid}',11);",buyer,error='next minimum')
        call(f"select public.place_bid('{aid}',1);",buyer)
        sql(f"update public.auctions set end_time=clock_timestamp()+interval '30 seconds' where id='{aid}';")
        deadline=row(aid)['end_time']
        call(f"select public.place_bid('{aid}',11);",other)
        assert row(aid)['end_time']==deadline
        featured=json.loads(sql('set role anon;select public.read_featured_giveaway();'))
        assert featured['giveaway_title']=='Meat Stack Mania'
        assert json.loads(sql('set role service_role;select public.bot_claim_giveaway_announcement();'))['id']==aid
        assert sql('set role service_role;select public.bot_claim_giveaway_announcement();')==''
        escrow=giveaway(True)
        assert sql('set role service_role;select public.bot_claim_giveaway_announcement();')==''
        assert ingest(escrow,'list',items=[{'id':2,'quantity':1000}])[1]=='accepted'
        assert ingest(escrow,'bid',meat=11,actor=48889602)[1]!='accepted'
        assert row(escrow)['current_bid']==0
        assert ingest(escrow,'bid',meat=1,actor=48889602)[1]=='accepted'
        assert json.loads(sql('set role service_role;select public.bot_claim_giveaway_announcement();'))['id']==escrow
        sql(f"update public.auctions set end_time=clock_timestamp()+interval '30 seconds' where id='{escrow}';")
        deadline=row(escrow)['end_time']
        assert ingest(escrow,'bid',meat=11,actor=48889603)[1]=='accepted'
        assert row(escrow)['end_time']==deadline
        buyout=call("select public.create_giveaway_auction('seal tooth',1000,1,24,null,100,2,false,'Buyout test');")
        call(f"select public.purchase_auction('{buyout}');",buyer,error='next minimum')
        call(f"select public.place_bid('{buyout}',100);",buyer,error='next minimum')
        normal=call("select public.create_auction('seal tooth',1,1,24,null,null,2,false);")
        sql(f"update public.auctions set end_time=clock_timestamp()+interval '30 seconds' where id='{normal}';")
        deadline=row(normal)['end_time']
        call(f"select public.place_bid('{normal}',100);",buyer)
        assert row(normal)['end_time']>deadline
        print('PASS: admin creation, exact Direct and funded Escrow bids, fixed deadline, public feature, one claim after escrow activation')
    finally:
        if started:pg('-m','immediate','stop')
