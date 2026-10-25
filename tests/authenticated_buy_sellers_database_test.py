"""Exercise creator-only Buy-auction fees and preserved financial records.
Creates a disposable local PostgreSQL database; no live Supabase or KoL calls.
Run: python3 tests/authenticated_buy_sellers_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-private-buy-fees-',dir='/tmp') as folder:
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
            if migration.name<'202610240112_': sql(migration.read_text())
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
            stamp=json.loads(sql("select jsonb_build_object('received_at',date_trunc('second',t),'epoch',floor(extract(epoch from t))::bigint) from (select clock_timestamp() t) clock;"))
            return {'id':str(mid),'sender_id':int(sql(f"select kol_player_id from public.profiles where id='{uid}';")),
                'sender_name':'Fixture sender','received_at':stamp['received_at'],'meat':meat,
                'command':{'type':cmd,'auction_id':ident},'items':([{'id':item_id or item,'quantity':quantity}] if quantity else []),'raw':{'type':'normal','azunixtime':str(stamp['epoch'])}}
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
        historical=create(10,200,'finished');fund(historical);r=reserve(historical,10);assert ingest(reserved_mail(historical,r))=='accepted'
        settle(historical)
        assert auction(historical)['status']=='completed'
        live=create(20,200,'finished');fund(live);r=reserve(live,5);assert ingest(reserved_mail(live,r))=='accepted'
        assert auction(live)['status']=='active'
        # Unfulfilled reservations must not become public participants.
        unused=reserve(live,2,uid=seller2)
        name=sql(f"select coalesce(nullif(btrim(kol_player_name),''),khub_username) from public.profiles where id='{seller}';")
        item_name=sql(f'select name from khub_bot.catalog where id={item};')
        regular=call(f"select public.create_auction({lit(item_name)},1,100,24,null,null,{item},false);",seller2)
        call(f"select public.place_bid('{regular}',100);",seller)
        def read(ident,uid=None,extra=''):
            role='authenticated' if uid else 'anon'
            return json.loads(sql(f"set role {role};select public.read_auction_page('detail','{ident}','','all','ending',1{extra});",uid))
        sell_before={str(uid):read(regular,uid) for uid in [None,buyer,seller,admin]}
        assert read(historical)['rows'][0]['fulfillments'][0]['seller']=='Seller'
        before=sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'orders',(select jsonb_agg(to_jsonb(o) order by auction_id) from khub_bot.buy_orders o),'fills',(select jsonb_agg(to_jsonb(f) order by receipt_id) from khub_bot.buy_fulfillments f),'receipts',(select jsonb_agg(to_jsonb(r) order by mail_id) from khub_bot.receipts r),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        sql(next(p for p in migrations if p.name=='202610240112_public_buy_fulfillment_sellers.sql').read_text())
        after=sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'orders',(select jsonb_agg(to_jsonb(o) order by auction_id) from khub_bot.buy_orders o),'fills',(select jsonb_agg(to_jsonb(f) order by receipt_id) from khub_bot.buy_fulfillments f),'receipts',(select jsonb_agg(to_jsonb(r) order by mail_id) from khub_bot.receipts r),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        assert before==after
        sql(next(p for p in migrations if p.name=='202610240113_authenticated_buy_fulfillment_sellers.sql').read_text())
        for extra in ['',",'all'",",'all','all'"]:
            for ident in [historical,live]:
                for uid in [None,buyer,seller,seller2,admin]:
                    row=read(ident,uid,extra)['rows'][0]
                    assert len(row['fulfillments'])==1
                    fill=row['fulfillments'][0]
                    if uid is None:
                        assert fill['seller']=='Seller' and fill['seller_id'] is None,fill
                    else:
                        assert fill['seller']==name and fill['seller_id']==seller,fill
                    assert fill['seller_id']!=seller2 # active reservation has no history entry
                    if uid not in [buyer,admin]:
                        assert 'commission_meat' not in fill and 'receipt_id' not in fill and 'delivery_references' not in fill,fill
        for uid in [None,buyer,seller,admin]:
            current=read(regular,uid)
            for field in ['rows','bids','total','seller','privacy_version']:
                assert sell_before[str(uid)][field]==current[field],field
        sql(f"update public.profiles set is_banned=true where id='{buyer}';")
        restricted=read(historical,buyer)['rows'][0]
        assert restricted['fulfillments'][0]['seller']=='Seller'
        assert restricted['fulfillments'][0]['seller_id'] is None
        assert 'commission_meat' not in restricted['fulfillments'][0]
        sql(f"set role anon;select khub_bot.buy_history('{live}');",error='permission denied')
        print('PASS: authenticated KoL seller names/profile IDs, anonymous and restricted identities withheld, for historical completed and active accepted fills, all reader variants/viewers, no reservation identities, private fees/admin references and Sell anonymity preserved; financial records unchanged')
    finally:
        if started:pg('-m','fast','-w','stop')
