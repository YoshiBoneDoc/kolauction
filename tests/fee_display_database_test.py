"""Exercise buy-order escrow, fees, concurrency, recovery and preserved sell flows.
Creates a disposable local PostgreSQL database; no live Supabase or KoL calls.
Run: python3 tests/buy_orders_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-fee-display-',dir='/tmp') as folder:
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
        # Historical 085 behavior; reservation/gift upgrades have their own suite.
        for migration in migrations:
            if not migration.name.startswith('202610220087_'): sql(migration.read_text())
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
        # Make a real settled Sell listing before upgrading its message template.
        name=sql(f"select name from khub_bot.catalog where id={item};")
        sold=call(f"select public.create_auction({lit(name)},1,1000000,24,null,null,{item},true);")
        assert ingest(mail(sold,'list',quantity=1))=='accepted'
        bid=mail(sold,'bid',uid=seller,meat=10000000)
        epoch=sql("select floor(extract(epoch from clock_timestamp()))::bigint;")
        bid['received_at']=sql(f'select to_timestamp({epoch});');bid['raw']['azunixtime']=epoch
        scan=json.loads(sql('select public.bot_begin_inbox_scan();'))
        sql(f"select public.bot_stage_inbox_scan('{scan['id']}',"+lit(json.dumps([bid]))+');')
        assert ingest(bid)=='accepted'
        sql(f"update public.auctions set created_at=created_at-interval '2 hours',end_time=clock_timestamp()-interval '2 minutes' where id='{sold}';select public.bot_finish_inbox_scan('{scan['id']}');")
        sql(f"update khub_bot.deliveries set display_message='Previously frozen fee wording' where auction_id='{sold}' and kind='sale_meat';")
        buy=create(10,10000000);fund(buy);r=reserve(buy,2);assert ingest(reserved_mail(buy,r))=='accepted'
        def fingerprint():return sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'orders',(select jsonb_agg(to_jsonb(o) order by auction_id) from khub_bot.buy_orders o),'receipts',(select jsonb_agg(to_jsonb(r) order by mail_id) from khub_bot.receipts r),'fills',(select jsonb_agg(to_jsonb(f) order by receipt_id) from khub_bot.buy_fulfillments f),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d),'income',(select jsonb_agg(to_jsonb(c) order by id) from khub_bot.closet_transfers c));")
        before=fingerprint();sql(next(p for p in migrations if p.name.startswith('202610220087_')).read_text());assert fingerprint()==before
        assert sql(f"select display_message from khub_bot.deliveries where auction_id='{sold}' and kind='sale_meat';")=='Previously frozen fee wording'
        for fee,price,expected in [(410000,10000000,'4.1%'),(420000,10000000,'4.2%'),(3110000,100000000,'3.11%'),(21110000,1000000000,'2.111%'),(1,6,'16.6667%'),(0,1,'0%'),(1,10000000000000,'<0.0001%')]:
            assert sql(f'select khub_bot.effective_fee_percent({fee},{price});')==expected
        seller_message=sql(f"select khub_bot.friendly_message(d) from khub_bot.deliveries d where auction_id='{sold}' and kind='sale_meat' limit 1;")
        assert 'Tiered Fee (4.1%): 410,000 Meat' in seller_message,seller_message
        funded=sql(f"select khub_bot.friendly_message(d) from khub_bot.deliveries d where auction_id='{buy}' and dedupe_key like 'buy-funded:%';")
        assert 'Estimated Tiered Fee (4.1%): 4,100,000 Meat' in funded,funded
        delivered=sql(f"select khub_bot.friendly_message(d) from khub_bot.deliveries d where auction_id='{buy}' and kind='sale_item';")
        assert 'Tiered Fee (4.1%): 820,000 Meat' in delivered,delivered
        assert projected(buy,buyer)[0]['fulfillments'][0]['commission_meat']==820000
        assert projected(buy,seller2)[0]['fulfillments'][0]['commission_meat'] is None
        print('PASS: effective percentage parity, seller and buyer KMail fee labels, upfront estimates, buyer history and unchanged money/frozen messages')
    finally:
        if started:pg('-m','fast','-w','stop')
