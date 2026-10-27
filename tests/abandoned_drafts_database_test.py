"""Exercise hidden abandoned drafts, database retention and public pagination.
Creates a disposable local PostgreSQL database; no live Supabase or KoL calls.
Run: python3 tests/abandoned_drafts_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-private-drafts-',dir='/tmp') as folder:
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
        # Seed before 092 to verify that its visibility change preserves records,
        # then load all later migrations before testing today's read paths.
        for migration in migrations:
            if migration.name<'202610230092_': sql(migration.read_text())
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

        from concurrent.futures import ThreadPoolExecutor
        buyer,_=account(91001,48889101,'Buy Order Buyer')
        seller,_=account(91002,48889102,'Fill Seller One')
        seller2,_=account(91003,48889103,'Fill Seller Two')
        admin,_=account(91004,3552305,'Buy Order Admin')
        item=int(sql('select id from khub_bot.catalog where is_current and tradeable order by id limit 1;'))
        mid=92000
        def call(query,uid=buyer,error=None):return sql('set role authenticated;'+query,uid,error)
        def create(quantity=100,price=200,mode='immediate',uid=buyer):
            return call(f"select public.create_buy_auction({item},{quantity},{price},24,'{mode}');",uid)
        def order(ident):return json.loads(sql(f"select to_jsonb(o) from khub_bot.buy_orders o where auction_id='{ident}';"))
        def auction(ident):return json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{ident}';"))
        def mail(ident,cmd,uid=buyer,meat=0,quantity=0,item_id=None):
            global mid
            mid+=1
            return {'id':str(mid),'sender_id':int(sql(f"select kol_player_id from public.profiles where id='{uid}';")),
                'sender_name':'Fixture sender','received_at':sql("select date_trunc('second',clock_timestamp());"),'meat':meat,
                'command':{'type':cmd,'auction_id':ident},'items':([{'id':item_id or item,'quantity':quantity}] if quantity else []),'raw':{'type':'normal','azunixtime':sql("select floor(extract(epoch from clock_timestamp()))::bigint;")}}
        def ingest(payload,error=None):
            if payload['command']['type']=='fill':
                scan=json.loads(sql('select public.bot_begin_inbox_scan();'))
                sql(f"select public.bot_stage_inbox_scan('{scan['id']}',"+lit(json.dumps([payload]))+');')
            return sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(payload))+');',error=error)

        def fund(ident):return ingest(mail(ident,'fund',meat=order(ident)['funding_required']))
        def fill(ident,quantity=1,uid=seller):return ingest(mail(ident,'fill',uid=uid,quantity=quantity))
        def settle(ident):
            sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where auction_id='{ident}';select public.bot_tick();")
        def snapshot():return sql("select jsonb_build_object('orders',(select jsonb_agg(to_jsonb(o)) from khub_bot.buy_orders o),'receipts',(select jsonb_agg(to_jsonb(r)) from khub_bot.receipts r),'deliveries',(select jsonb_agg(to_jsonb(d)) from khub_bot.deliveries d));")
        def projected(ident,uid=None):
            return json.loads(sql(f"select public.read_auction_page('detail','{ident}','','all','ending',1);",uid))['rows']
        def reserve(ident,qty,uid=seller,error=None):
            value=call(f"select public.reserve_buy_quantity('{ident}',{qty});",uid,error)
            return json.loads(value) if not error else None
        def reserved_mail(ident,res,uid=seller,quantity=None,received=None):
            payload=mail(ident,'fill',uid=uid,quantity=quantity or res['quantity'])
            epoch=sql("select floor(extract(epoch from clock_timestamp()))::bigint;") if received is None else str(received)
            payload['received_at']=sql(f'select to_timestamp({epoch});');payload['raw']['azunixtime']=epoch
            payload['command']['reservation_id']=res['id'];return payload
        def complete_scan():
            scan=json.loads(sql('select public.bot_begin_inbox_scan();'));sql(f"select public.bot_stage_inbox_scan('{scan['id']}','[]');select public.bot_finish_inbox_scan('{scan['id']}');")
        def state(res):return sql(f"select state from khub_bot.buy_reservations where id='{res['id']}';")
        def available(ident):return int(sql(f"select khub_bot.buy_available('{ident}');"))
        def claim_item(ident):
            return json.loads(sql(f"update khub_bot.deliveries set state='sending',attempt=gen_random_uuid() where id=(select id from khub_bot.deliveries where auction_id='{ident}' and kind='sale_item' and state='pending' order by created_at,id limit 1) returning to_jsonb(deliveries);"))
        def charge(d):return json.loads(sql(f"set role service_role;select public.bot_charge_buy_gift('{d['id']}','{d['attempt']}');"))
        def ack(d,sent=True):sql(f"set role service_role;select public.bot_ack_delivery('{d['id']}','{d['attempt']}',{str(sent).lower()},'Fixture verified result; no actual game requests.');")
        def seed(status='cancelled',escrow=True,funded=False,hours=2,uid=buyer):
            return sql(f"insert into public.auctions(seller_id,seller_username,item,item_id,seller_kol_id,quantity,min_bid_meat,duration_hours,escrow_mode,start_on_deposit,status,created_at,end_time,item_escrowed_at) values('{uid}','Fixture','Visibility fixture',{item},48889101,1,100,24,{str(escrow).lower()},true,'{status}',clock_timestamp()-interval '{hours} hours',clock_timestamp()+interval '1 day',{'clock_timestamp()' if funded else 'null'}) returning id;")
        hidden=[seed(),seed('expired'),seed('voided')]
        unfunded_buy=create();call(f"select public.cancel_auction('{unfunded_buy}');");hidden.append(unfunded_buy)
        visible=[seed(funded=True),seed(escrow=False)]
        # Lots of newer abandoned rows must not consume slots on the public pages.
        visible += [seed(escrow=False) for _ in range(25)]
        hidden += [seed() for _ in range(30)]
        fresh=seed('pending_escrow')
        def whole():return sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'orders',(select jsonb_agg(to_jsonb(o) order by auction_id) from khub_bot.buy_orders o),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d),'receipts',(select jsonb_agg(to_jsonb(r) order by mail_id) from khub_bot.receipts r));")
        visibility_migration=next(p for p in migrations if p.name.startswith('202610230092_'))
        before=whole();sql(visibility_migration.read_text());assert whole()==before
        for migration in migrations:
            if migration.name>visibility_migration.name:sql(migration.read_text())
        manual=seed('pending_escrow')
        call(f"select public.cancel_auction('{manual}');")
        assert auction(manual)['status']=='cancelled'
        hidden.append(manual)
        def read(view='browse',ident=None,uid=None,page=1,extra='',status='all'):
            role='authenticated' if uid else 'anon';arg=lit(ident)+'::uuid' if ident else 'null'
            return json.loads(sql(f"set role {role};select public.read_auction_page('{view}',{arg},'','{status}','newest',{page}{extra});",uid))
        for extra in ['',",'all'",",'all','all'"]:
            for uid in [None,seller,buyer,admin]:
                for view in ['browse','others','seller','profile']:
                    result=read(view,buyer,uid,extra=extra)
                    assert not set(hidden)&{r['id'] for r in result['rows']},(view,uid,result)
                for ident in hidden[:4]:
                    result=read('detail',ident,uid,extra=extra)
                    assert bool(result['rows'])==(uid==admin),(uid,result)
            first=read(page=1,extra=extra);second=read(page=2,extra=extra)
            assert first['total']==len(visible) and len(first['rows'])==24
            assert second['total']==len(visible) and len(second['rows'])==len(visible)-24
            assert {r['id'] for r in first['rows']+second['rows']}==set(visible)
            profile=read('seller',buyer,extra=extra)
            assert profile['seller']['stats']['cancelled']==len(visible),profile
        for uid in [None,buyer,admin]:
            role='authenticated' if uid else 'anon'
            result=json.loads(sql(f"set role {role};select public.read_filtered_auction_page('browse',null,'','cancelled','newest',1,'all','all',null,null);",uid))
            assert result['total']==len(visible)
            assert not set(hidden)&{r['id'] for r in result['rows']}
        assert fresh in {r['id'] for r in read('profile',uid=buyer)['rows']}
        for ident in hidden:assert auction(ident)['id']==ident
        # A user's public seller page should not reveal that hidden drafts exist.
        private_only=seed(uid=seller)
        assert read('seller',seller)['seller'] is None and read('seller',seller)['total']==0
        print('PASS: abandoned Sell/Buy drafts hidden from all listing readers, owner/admin lists, seller counts and non-admin detail links; exact admin lookup remains; pagination includes only real published listings; existing records and assets unchanged')
        old=seed('pending_escrow',hours=25)
        sql('select public.bot_tick();')
        assert auction(old)['status']=='expired' and auction(old)['closure_reason']=='deposit_expired'
        assert read('detail',old)['rows']==[] and read('detail',old,admin)['rows'][0]['id']==old
        assert auction(fresh)['status']=='pending_escrow'
        payload=mail(old,'list',quantity=1);assert ingest(payload)!='accepted'
        assert sql(f"select sum(quantity) from khub_bot.deliveries where receipt_id='{payload['id']}' and kind='refund';")=='1'
        print('PASS: new 24-hour expirations are retained privately instead of deleted, fresh funding drafts remain available, and late attachments are safely returned')
    finally:
        if started:pg('-m','fast','-w','stop')
