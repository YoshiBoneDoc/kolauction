"""Barter isolation and review workflow against ALL local SQL migrations.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/bundle_auctions_database_test.py
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
            create table auth.mfa_amr_claims(id uuid primary key,session_id uuid references auth.sessions(id),authentication_method text,created_at timestamptz,updated_at timestamptz);
            create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
            grant usage on schema public,auth to anon,authenticated,service_role;
            grant execute on function auth.uid() to anon,authenticated;
        ''')
        migrations=sorted([*ROOT.glob('supabase/migrations/*.sql'),*ROOT.glob('supabase/migrations/queue/*.sql')],key=lambda p:p.name)
        assert len({p.name for p in migrations})==len(migrations)
        for migration in migrations:
            if '265_leaderboard_alt' in migration.name:
                sql("set session_replication_role=replica;insert into public.profiles(id,khub_username,kol_player_id,kol_player_name,kol_verified_at) values('00000000-0000-0000-0000-000000000099','FixtureAlt',99999999,'Anrath1',now());set session_replication_role=origin;")
            sql(migration.read_text())
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
        sql("insert into khub_bot.market_prices(item_id,price_meat,observed_at,checked_at,available) values(2,20000000,now(),now(),true),(364,1000000,now(),now(),true) on conflict(item_id) do update set price_meat=excluded.price_meat,observed_at=now(),checked_at=now(),available=true;")
        def create(q=2,minimum='null'):
            return call(f"select public.create_barter_auction(2,{q},{minimum},24,null,'{uuid4()}');")
        call(f"select public.create_barter_auction(2,1,null,24,null,'{uuid4()}');",error='40m')
        aid=create()
        assert sql(f"select count(*) from public.auctions where id='{aid}';")=='0'
        assert json.loads(call("select public.read_barter_auctions();"))['rows'][0]['id']==aid
        assert json.loads(call(f"select public.read_barter_detail('{aid}');"))['minimumValue'] is None
        def offer(who,meat,items=None,request=None):
            return call(f"select public.submit_barter_offer('{aid}',{meat},"+lit(json.dumps(items or []))+f",'{request or uuid4()}');",uid=who)
        token=str(uuid4())
        first=offer(buyer,100,[{'id':364,'quantity':2}],token)
        assert offer(buyer,100,[{'id':364,'quantity':2}],token)==first
        call(f"select public.submit_barter_offer('{aid}',200,'[]','{uuid4()}');",uid=buyer,error='already have a pending offer')
        assert json.loads(call(f"select public.read_barter_detail('{aid}');",uid=other))['offers']==[]
        assert json.loads(sql(f"set role anon; select public.read_barter_detail('{aid}');"))['offers']==[]
        reviewed=json.loads(call(f"select public.read_barter_detail('{aid}');"))['offers'][0]
        assert reviewed['value']==2000100
        assert reviewed['bidder'] is None and reviewed['bidderKolId'] is None
        assert reviewed['items'][0]['image'].startswith('https://images.kingdomofloathing.com/')
        sql(f"insert into khub_bot.administrators(user_id,note) values('{seller}','Local barter privacy fixture');")
        admin_offer=json.loads(call(f"select public.read_barter_detail('{aid}');"))['offers'][0]
        assert admin_offer['bidderKolId']==48889602 and admin_offer['bidder']
        sql(f"delete from khub_bot.administrators where user_id='{seller}';")
        call(f"select public.review_barter_offer('{first}','accepted');",uid=buyer,error='Only the host')
        assert reviewed['bidderLabel']=='Bidder 1'
        call(f"select public.review_barter_offer_changes('{first}','changes_requested','{{}}',true);")
        feedback=json.loads(call(f"select public.read_barter_detail('{aid}');",uid=buyer))
        assert feedback['offers'][0]['rejectedItems']==[]
        assert feedback['offers'][0]['raiseRequested'] is True
        notices=json.loads(call('select public.read_barter_pending();',uid=buyer))
        assert notices[0]['kind']=='changes_requested' and notices[0]['id']==aid
        assert json.loads(call('select public.read_barter_pending();',uid=other))==[]
        assert json.loads(call(f"select public.read_barter_detail('{aid}');"))['offers']==[]
        call(f"select public.withdraw_barter_offer('{first}');",uid=other,error='Only your pending')
        call(f"select public.withdraw_barter_offer('{first}');",uid=buyer)
        assert json.loads(call('select public.read_barter_pending();',uid=buyer))==[]
        assert feedback['history']==[]
        image_offer=offer(other,100,[{'id':364,'quantity':1}])
        call(f"select public.review_barter_offer('{image_offer}','accepted');")
        history=json.loads(call(f"select public.read_barter_detail('{aid}');",uid=buyer))['history']
        assert history[0]['items'][0]['image'].startswith('https://images.kingdomofloathing.com/')
        assert history[0]['bidder'] is None and history[0]['bidderLabel'].startswith('Bidder ')
        second=offer(buyer,300)
        latest=json.loads(call(f"select public.read_barter_detail('{aid}');",uid=buyer))['offers']
        assert len(latest)==1 and latest[0]['id']==second
        assert sql(f"select count(*) from khub_bot.barter_offers where auction_id='{aid}' and bidder_id='{buyer}';")=='2'
        assert json.loads(call('select public.read_barter_pending();',uid=buyer))==[]
        call(f"select public.review_barter_offer('{second}','accepted');")
        third=offer(other,100)
        call(f"select public.review_barter_offer('{third}','accepted');")
        detail=json.loads(call(f"select public.read_barter_detail('{aid}');"))
        assert detail['currentBid']==100 and len(detail['history'])==3
        assert detail['offers']==[]
        mine=json.loads(call(f"select public.read_barter_detail('{aid}');",uid=buyer))['history']
        assert next(o for o in mine if o['id']==second)['isOwn'] is True
        assert next(o for o in mine if o['id']==third)['isOwn'] is False
        anonymous=json.loads(sql(f"set role anon;select public.read_barter_detail('{aid}');"))['history']
        assert all(o['isOwn'] is False and o['bidder'] is None for o in anonymous)
        assert detail['history'][0]['bidder'] is None and detail['history'][0]['bidderLabel'].startswith('Bidder ')
        assert len(json.loads(call('select public.read_barter_pending();')))==0
        pending=offer(buyer,1000)
        assert json.loads(call('select public.read_barter_pending();'))[0]['count']==1
        call(f"select public.withdraw_barter_offer('{pending}');",uid=other,error='Only your pending')
        call(f"select public.withdraw_barter_offer('{pending}');",uid=buyer)
        assert json.loads(call('select public.read_barter_pending();'))==[]
        sql(f"update khub_bot.barter_auctions set end_time=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '1 day' where id='{aid}';")
        call(f"select public.submit_barter_offer('{aid}',100,'[]','{uuid4()}');",uid=buyer,error='closed')
        assert json.loads(call(f"select public.read_barter_detail('{aid}');"))['winningOffer']['bidderKolId']==48889603
        assert json.loads(call(f"select public.read_barter_detail('{aid}');",uid=buyer))['winningOffer'] is None
        assert not json.loads(call('select public.read_barter_auctions();'))['rows']
        aid=create(minimum='100')
        call(f"select public.submit_barter_offer('{aid}',100,'[]','{uuid4()}');",uid=buyer,error='exceed')
        call(f"select public.submit_barter_offer('{aid}',0,'[]','{uuid4()}');",uid=buyer,error='between')
        call(f"select public.submit_barter_offer('{aid}',1000,'[]','{uuid4()}');",error='own barter')
        sql("update khub_bot.market_prices set checked_at=now()-interval '27 hours',observed_at=now()-interval '27 hours' where item_id=2;")
        call(f"select public.create_barter_auction(2,2,null,24,null,'{uuid4()}');",error='fresh market')
        call("select * from khub_bot.barter_offers;",uid=buyer,error='permission denied')
        # Visibility, restriction and bounded sorted paging use the real public RPCs.
        sql("update khub_bot.market_prices set checked_at=now(),observed_at=now() where item_id=2;")
        call("select public.set_player_ignored(48889601,true);",uid=buyer)
        assert call(f"select public.read_barter_detail('{aid}');",uid=buyer)==''
        call(f"select public.submit_barter_offer('{aid}',1000,'[]','{uuid4()}');",uid=buyer,error='unavailable')
        call("select public.set_player_ignored(48889601,false);",uid=buyer)
        oid=offer(buyer,1000)
        call(f"select public.review_barter_offer('{oid}','rejected');")
        rejected_history=json.loads(call(f"select public.read_barter_detail('{aid}');",uid=buyer))['history']
        assert any(row['id']==oid and row['status']=='rejected' and row['isOwn'] and row['historyAt'] for row in rejected_history)
        for viewer in [seller,other]:
            assert not any(row['id']==oid for row in json.loads(call(f"select public.read_barter_detail('{aid}');",uid=viewer))['history'])
        assert not any(row['id']==oid for row in json.loads(sql(f"set role anon;select public.read_barter_detail('{aid}');"))['history'])
        call(f"select public.review_barter_offer('{oid}','accepted');",error='no longer reviewable')
        sql(f"update public.profiles set is_banned=true where id='{buyer}';")
        assert json.loads(call(f"select public.read_barter_detail('{aid}');",uid=buyer))['offers']==[]
        call(f"select public.submit_barter_offer('{aid}',1000,'[]','{uuid4()}');",uid=buyer,error='restricted')
        sql(f"update public.profiles set is_banned=false where id='{buyer}';")
        for n in range(26):
            sql(f"insert into khub_bot.barter_auctions(seller_id,item_id,item,quantity,market_value,end_time,request_id) values('{seller}',2,'Paging item {n:02}',2,40000000,now()+make_interval(hours=>{n+1}),'{uuid4()}');")
        page1=json.loads(call("select public.read_barter_auctions('Paging','ending',1);"))
        page2=json.loads(call("select public.read_barter_auctions('Paging','ending',2);"))
        assert len(page1['rows'])==24 and page1['more'] and len(page2['rows'])==2 and not page2['more']
        assert page1['rows'][0]['item']=='Paging item 00' and page2['rows'][0]['item']=='Paging item 24'
        assert len(json.loads(call("select public.read_barter_auctions('ITEM 25','ending',1);"))['rows'])==1
        # Independent PostgreSQL sessions exercise real row-lock serialization.
        from concurrent.futures import ThreadPoolExecutor
        def parallel_call(query,who):
            return subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',f"set request.jwt.claim.sub='{who}';set role authenticated;"+query],capture_output=True,text=True)
        race_token=str(uuid4())
        race_query=f"select public.submit_barter_offer('{aid}',2000,'[]','{race_token}');"
        with ThreadPoolExecutor(max_workers=2) as workers:
            results=list(workers.map(lambda _: parallel_call(race_query,other),range(2)))
        assert all(r.returncode==0 for r in results),[r.stderr for r in results]
        race_offer=results[0].stdout.strip()
        assert race_offer==results[1].stdout.strip()
        queries=[f"select public.review_barter_offer('{race_offer}','accepted');",f"select public.review_barter_offer('{race_offer}','rejected');"]
        with ThreadPoolExecutor(max_workers=2) as workers:
            results=list(workers.map(lambda query: parallel_call(query,seller),queries))
        assert sorted(r.returncode==0 for r in results)==[False,True]
        assert sql(f"select count(*) from khub_bot.barter_offers where request_id='{race_token}';")=='1'
        print('PASS: concurrent duplicate submissions and conflicting host decisions serialize without duplication or overwrite')
        print('PASS: visibility, restrictions, immutable decisions, search and bounded ordered pagination')
        print('PASS: independent barter creation, market threshold/freshness, optional minimum, privacy, host decisions, lower acceptance, feedback, idempotency, deadline and notices')
    finally:
        if started: pg('-m','immediate','-w','stop')
