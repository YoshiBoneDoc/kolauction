"""Exercise safe, durable escrow bid-help replies and unchanged real bids.
Creates a disposable local PostgreSQL database; no live Supabase or KoL calls.
Run: python3 tests/bid_help_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-bid-help-',dir='/tmp') as folder:
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
        # Apply existing behavior before testing the privacy upgrade.
        for migration in migrations:
            if migration.name<'202610230095_': sql(migration.read_text())
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

        buyer,_=account(91001,48889101,'Buy Order Buyer')
        seller,_=account(91002,48889102,'Fill Seller One')
        seller2,_=account(91003,48889103,'Fill Seller Two')
        admin,_=account(91004,3552305,'Buy Order Admin')
        from concurrent.futures import ThreadPoolExecutor
        item=int(sql('select id from khub_bot.catalog where is_current and tradeable order by id limit 1;'))
        def payload(mid,kind='bid_help',meat=0,items=None,uid=seller):
            stamp=json.loads(sql("select jsonb_build_object('received_at',date_trunc('second',t),'epoch',floor(extract(epoch from t))::bigint) from (select clock_timestamp() t) clock;"))
            player=sql(f"select kol_player_id from public.profiles where id='{uid}';")
            return {'id':str(mid),'sender_id':int(player),'sender_name':'Fixture sender','received_at':stamp['received_at'],
                'command':{'type':kind,'auction_number':'1048'},'meat':meat,'items':items or [],
                'raw':{'id':str(mid),'fromid':player,'fromname':'Fixture sender','type':'normal','message':'BID 1048 51000','azunixtime':str(stamp['epoch'])}}
        def ingest(mail,error=None):return sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(mail))+');',error=error)
        def deliveries(mid):return json.loads(sql(f"select coalesce(jsonb_agg(to_jsonb(d)),'[]') from khub_bot.deliveries d where receipt_id='{mid}';"))
        def cleanup(mid):return json.loads(sql(f"set role service_role;select public.bot_mail_cleanup(array['{mid}']);"))
        def stage(mail):
            scan=json.loads(sql('select public.bot_begin_inbox_scan();'))
            sql(f"select public.bot_stage_inbox_scan('{scan['id']}',"+lit(json.dumps([mail]))+');')
        sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp();")
        frozen=sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a)) from public.auctions a),'bids',(select jsonb_agg(to_jsonb(b)) from public.bids b),'deliveries',(select jsonb_agg(to_jsonb(d)) from khub_bot.deliveries d));")
        sql(next(p for p in migrations if p.name.startswith('202610230095_')).read_text())
        assert frozen==sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a)) from public.auctions a),'bids',(select jsonb_agg(to_jsonb(b)) from public.bids b),'deliveries',(select jsonb_agg(to_jsonb(d)) from khub_bot.deliveries d));")
        mail=payload(206072560)
        with ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(lambda _:ingest(mail),range(4)))
        assert results.count('bid_help')==1 and results.count('duplicate')==3
        d=deliveries(mail['id']);assert len(d)==1 and d[0]['kind']=='notice' and d[0]['meat']==0
        body=d[0]['display_message'];assert 'Put only BID 1048' in body and '51,000 Meat actually attached' in body
        assert 'did not place a bid' in body and 'full new amount, not just the increase' in body
        assert cleanup(mail['id'])==[]
        # Exercise the real preparation/frozen-message path; unknown sends remain held.
        claimed=json.loads(sql('set role service_role;select public.bot_claim_delivery(2);'))
        assert claimed['receipt_id']==mail['id'] and 'Put only BID 1048' in claimed['display_message']
        assert cleanup(mail['id'])==[]
        sql(f"update khub_bot.deliveries set state='unknown' where id='{claimed['id']}';")
        assert cleanup(mail['id'])==[] and ingest(mail)=='duplicate'
        sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where id='{claimed['id']}';")
        assert cleanup(mail['id'])==[mail['id']]
        pg('-l',str(Path(folder)/'postgres.log'),'-m','fast','-w','restart');assert ingest(mail)=='duplicate' and len(deliveries(mail['id']))==1
        ingest({**mail,'sender_name':'Changed'},error='Invalid normalized')
        altered=json.loads(json.dumps(mail));altered['raw']['message']='BID 1048 99999';ingest(altered,error='payload changed')
        funded=payload(206072561,meat=51000,items=[{'id':item,'quantity':2}]);assert ingest(funded)=='bid_help'
        refunds=deliveries(funded['id']);assert sum(d['meat'] for d in refunds)==51000 and sum(d['quantity'] for d in refunds)==2
        assert all(d['kind']=='refund' and d['recipient_id']==funded['sender_id'] for d in refunds)
        held=json.loads(sql('set role service_role;select public.bot_liabilities();'))
        assert int(held['meat'])==51000 and int(held['items'][str(item)])==2
        assert 'assets are being returned' in refunds[0]['display_message'] and cleanup(funded['id'])==[]
        bad=payload(206072562,items=[{'id':item,'quantity':-1}]);ingest(bad,error='Invalid bid-help attachments')
        system=payload(206072563);system['sender_id']=0;system['raw']['fromid']='0';ingest(system,error='Invalid normalized')
        for role in ['anon','authenticated']:sql('set role '+role+';select public.bot_ingest_mail('+lit(json.dumps(mail))+');',seller,error='permission denied')
        # Correct syntax with missing attachments receives the same help and releases
        # the staged queue without creating a bid/cursor or blocking unrelated mail.
        dry=payload(206072564,'bid');dry['raw']['message']='BID 1048';stage(dry);assert ingest(dry)=='bid_help'
        assert sql(f"select processed from khub_bot.inbox_bid_mail where mail_id='{dry['id']}';")=='t'
        assert sql('select count(*) from khub_bot.escrow_mail_order;')=='0'
        assert sql('select count(*) from public.bids;')=='0'
        name=sql(f"select name from khub_bot.catalog where id={item};")
        listing=sql(f"set role authenticated;select public.create_auction({lit(name)},1,100,24,null,null,{item},true);",buyer)
        deposit=payload(206072565,'list',items=[{'id':item,'quantity':1}],uid=buyer)
        deposit['command']={'type':'list','auction_id':listing};deposit['raw']['message']='LIST '+listing
        assert ingest(deposit)=='accepted'
        valid=payload(206072566,'bid',meat=51000)
        valid['command']={'type':'bid','auction_id':listing};valid['raw']['message']='BID '+listing
        stage(valid);assert ingest(valid)=='accepted'
        assert int(sql(f"select current_bid from public.auctions where id='{listing}';"))==51000
        assert int(sql(f"select amount from public.bids where auction_id='{listing}';"))==51000
        print('PASS: typed/missing-funds bids get exact instructions once across concurrent retries/restarts; real frozen notice preparation; pending/unknown sends prevent cleanup; attachments fully refunded; no bids/cursor changes; malformed/system/role guards')
    finally:
        if started:pg('-m','fast','-w','stop')
