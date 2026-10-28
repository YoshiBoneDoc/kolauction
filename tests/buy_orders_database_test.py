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
with tempfile.TemporaryDirectory(prefix='khub-buy-orders-',dir='/tmp') as folder:
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
            if migration.name<'202610220086_' or migration.name=='202610270124_profile_buy_fulfillment_totals.sql':
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
                'sender_name':'Fixture sender','received_at':sql("select clock_timestamp();"),'meat':meat,
                'command':{'type':cmd,'auction_id':ident},'items':([{'id':item_id or item,'quantity':quantity}] if quantity else []),'raw':{'type':'normal'}}
        def ingest(payload,error=None):return sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(payload))+');',error=error)
        def fund(ident):return ingest(mail(ident,'fund',meat=order(ident)['funding_required']))
        def fill(ident,quantity=1,uid=seller):return ingest(mail(ident,'fill',uid=uid,quantity=quantity))
        def settle(ident):
            sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where auction_id='{ident}';select public.bot_tick();")
        def snapshot():return sql("select jsonb_build_object('orders',(select jsonb_agg(to_jsonb(o)) from khub_bot.buy_orders o),'receipts',(select jsonb_agg(to_jsonb(r)) from khub_bot.receipts r),'deliveries',(select jsonb_agg(to_jsonb(d)) from khub_bot.deliveries d));")
        def projected(ident,uid=None):
            return json.loads(sql(f"select public.read_auction_page('detail','{ident}','','all','ending',1);",uid))['rows']
        first=create();assert auction(first)['status']=='pending_escrow'
        assert order(first)['funding_required']==21000
        assert projected(first)==[] and projected(first,seller)==[]
        assert len(projected(first,buyer))==1 and len(projected(first,admin))==1
        assert 'Only the buyer' in ingest(mail(first,'fund',uid=seller,meat=21000))
        assert 'full required' in ingest(mail(first,'fund',meat=20999))
        assert 'full required' in ingest(mail(first,'fund',meat=21000,quantity=1))
        assert auction(first)['status']=='pending_escrow'
        funding=mail(first,'fund',meat=22000);assert ingest(funding)=='accepted'
        assert auction(first)['status']=='active' and order(first)['balance_meat']==21000
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{funding['id']}' and kind='refund';")=='1000'
        before=snapshot();assert ingest(funding)=='duplicate';assert snapshot()==before
        changed={**funding,'meat':23000};ingest(changed,error='payload changed')
        assert 'not waiting' in ingest(mail(first,'fund',meat=21000))
        assert 'own buy order' in fill(first,1,buyer)
        assert 'only the requested item' in ingest(mail(first,'fill',uid=seller,meat=1,quantity=1))
        assert 'only the requested item' in ingest(mail(first,'fill',uid=seller,quantity=1,item_id=1900000))
        assert 'use FUND' in ingest(mail(first,'list',quantity=100))
        payload=mail(first,'fill',uid=seller,quantity=20);assert ingest(payload)=='accepted'
        o=order(first);assert o['purchased_quantity']==20 and o['balance_meat']==16800 and o['held_quantity']==0 and o['commission_meat']==200
        assert auction(first)['status']=='active'
        before=snapshot();assert ingest(payload)=='duplicate';assert snapshot()==before
        assert fill(first,30,seller2)=='accepted';assert order(first)['purchased_quantity']==50
        assert fill(first,60,seller)=='accepted';o=order(first)
        assert o['purchased_quantity']==100 and o['balance_meat']==0 and o['purchase_meat']==20000 and o['commission_meat']==1000
        assert auction(first)['status']=='settling'
        assert sql(f"select sum(quantity) from khub_bot.deliveries where auction_id='{first}' and dedupe_key like 'buy-fill-excess:%';")=='10'
        assert sql(f"select sum(meat) from khub_bot.deliveries where auction_id='{first}' and dedupe_key like 'buy-fill-payment:%';")=='20000'
        assert sql(f"select sum(meat) from khub_bot.closet_transfers where auction_id='{first}';")=='1000'
        assert 'not accepting' in fill(first)
        settle(first);assert auction(first)['status']=='completed'
        print('PASS: funding validation, excess returns, receipt replay protection, partial/multiple fills, exact full seller payouts, item returns and full completion')
        # Per-fill rounding rather than rounding each item's commission.
        fractional=create(20,1,'finished');assert order(fractional)['funding_required']==21;fund(fractional)
        fill(fractional,10);fill(fractional,10,seller2)
        o=order(fractional);assert o['commission_meat']==0 and o['refunded_meat']==1 and o['held_quantity']==0
        assert sql(f"select sum(quantity) from khub_bot.deliveries where auction_id='{fractional}' and kind='sale_item';")=='20'
        fee_cases=[(200,1000,10000),(1000000,1,50000),(10000000,1,410000),(100000000,1,3110000),(1000000000,1,21110000),(2000000000,1,31110000),(200,5000000,50000000)]
        for price,qty,fee in fee_cases:
            ident=create(qty,price);assert order(ident)['funding_required']==price*qty+fee
            fund(ident);fill(ident,qty);assert order(ident)['commission_meat']==fee
        grouped=create(20,1);fund(grouped);fill(grouped,20);assert order(grouped)['commission_meat']==1
        print('PASS: fractional fees rounded after each fulfillment, unused rounding reserve refunded; every marginal tier and 1B low-unit-price order')
        held=create(100,200,'finished');fund(held);fill(held,20)
        assert order(held)['held_quantity']==20
        liabilities=json.loads(sql('select public.bot_liabilities();'))
        assert int(liabilities['items'][str(item)])>=20 and int(liabilities['meat'])>=16800
        call(f"select public.cancel_auction('{held}');",seller,error='Only the buyer')
        call(f"select public.cancel_auction('{held}');");o=order(held)
        assert o['refunded_meat']==16800 and o['commission_meat']==200 and o['held_quantity']==0
        assert auction(held)['settlement_outcome']=='cancelled'
        before=snapshot();call(f"select public.cancel_auction('{held}');",error='already closed');assert snapshot()==before
        settle(held);assert auction(held)['status']=='cancelled'
        exp=create(mode='finished');fund(exp);fill(exp,20)
        sql(f"update public.auctions set created_at=created_at-interval '2 hours',end_time=clock_timestamp()-interval '1 second' where id='{exp}';select public.finalize_expired_auctions();")
        assert auction(exp)['settlement_outcome']=='expired' and order(exp)['refunded_meat']==16800
        settle(exp);assert auction(exp)['status']=='expired'
        unfunded=create();sql(f"update public.auctions set created_at=created_at-interval '25 hours' where id='{unfunded}';")
        assert '24-hour' in fund(unfunded);assert order(unfunded)['funded_meat']==0
        sql('select public.finalize_expired_auctions();');assert auction(unfunded)['status']=='cancelled'
        print('PASS: held inventory protected, cancellation preserves purchases/fees, expiration refunds unused funds, 24-hour funding deadline, idempotent close')
        race=create(100);fund(race)
        payloads=[mail(race,'fill',uid=uid,quantity=80) for uid in [seller,seller2]]
        with ThreadPoolExecutor(max_workers=2) as pool:
            for result in list(pool.map(ingest,payloads)):assert result=='accepted'
        assert order(race)['purchased_quantity']==100 and order(race)['purchase_meat']==20000
        assert sql(f"select sum(quantity) from khub_bot.buy_fulfillments where auction_id='{race}';")=='100'
        assert sql(f"select sum(quantity) from khub_bot.deliveries where auction_id='{race}' and dedupe_key like 'buy-fill-excess:%';")=='60'
        # A claimed/interrupted outgoing payment remains a liability and prevents completion.
        delivery=json.loads(sql(f"update khub_bot.deliveries set state='sending',attempt=gen_random_uuid() where id=(select id from khub_bot.deliveries where auction_id='{race}' and meat>0 limit 1) returning to_jsonb(deliveries);"))
        sql('select public.bot_tick();');assert auction(race)['status']=='settling'
        sql(f"set role service_role;select public.bot_ack_delivery('{delivery['id']}','{delivery['attempt']}',false,'Fixture lost acknowledgment; inspect sent mail before retry.');")
        assert sql(f"select state from khub_bot.deliveries where id='{delivery['id']}';")=='unknown'
        sql(f"set role service_role;select public.bot_reconcile_delivery('{delivery['id']}',true,'Fixture confirmed matching sent-copy reference, no resend.');")
        assert sql(f"select state from khub_bot.deliveries where id='{delivery['id']}';")=='sent'
        settle(race);assert auction(race)['status']=='completed'
        print('PASS: concurrent sellers cannot overfill or double-spend; interrupted sends retain liabilities and use existing reconciliation without duplicate payments')
        # Browser projection and profile history include sellers without exposing receipt IDs.
        rows=projected(first,seller);assert rows[0]['fulfilled_by_me'] and rows[0]['my_sale_meat']==14000 and rows[0]['my_sale_quantity']==70
        other_seller=projected(first,seller2)[0]
        assert other_seller['my_sale_meat']==6000 and other_seller['my_sale_quantity']==30
        buyer_projection=projected(first,buyer)[0]
        assert buyer_projection['my_sale_meat']==0 and buyer_projection['my_sale_quantity']==0
        unpaid_receipt=sql(f"select receipt_id from khub_bot.buy_fulfillments where auction_id='{first}' and seller_id='{seller}' order by created_at limit 1;")
        sql(f"update khub_bot.deliveries set state='unknown' where receipt_id='{unpaid_receipt}' and dedupe_key like 'buy-fill-payment:%';")
        withheld=projected(first,seller)[0]
        assert withheld['my_sale_meat']==10000 and withheld['my_sale_quantity']==50
        sql(f"update khub_bot.deliveries set state='sent' where receipt_id='{unpaid_receipt}' and dedupe_key like 'buy-fill-payment:%';")
        assert 'balance_meat' not in rows[0] and 'receipt_id' not in rows[0]['fulfillments'][0]
        assert 'receipt_id' in projected(first,admin)[0]['fulfillments'][0]
        assert 'balance_meat' in projected(first,buyer)[0]
        history=json.loads(call("select public.read_auction_page('profile',null,'','all','ending',1);",seller))
        assert first in [r['id'] for r in history['rows']]
        filtered=json.loads(call("select public.read_auction_page('browse',null,'','all','price-desc',1,'all','buy');"))
        assert all(r['auction_kind']=='buy' for r in filtered['rows'])
        report=call(f"select public.submit_trade_query('{uuid4()}','{first}','Please inspect this buy order payment and delivery.');",seller)
        assert 'B-' in report
        unfilled=create()
        assert 'B-' in call(f"select public.submit_trade_query('{uuid4()}','{unfilled}','Please inspect my pending buy order.');",buyer)
        for outsider in [seller,seller2,admin]:
            call(f"select public.submit_trade_query('{uuid4()}','{unfilled}','Please inspect someone else buy order.');",outsider,error='Only the seller')
        for table in ['buy_orders','buy_fulfillments']:
            call(f'select * from khub_bot.{table};',seller,error='permission denied')
        sql(f"set role anon;select public.create_buy_auction({item},1,200,24,'immediate');",error='permission denied')
        call(f"select public.create_buy_auction({item},5000000000,20000000000,24,'immediate');",error='20 billion')
        sql("insert into khub_bot.account_bans(kol_player_id,username,reason) values(48889103,'Fill Seller Two','Fixture restriction');")
        active=create();fund(active);assert 'restricted' in fill(active,1,seller2)
        print('PASS: buy filtering/history, seller support thread, private ledger and administrator references, restricted accounts and safe order funding limits')
        empty_cancel=create();fund(empty_cancel);call(f"select public.cancel_auction('{empty_cancel}');")
        assert order(empty_cancel)['refunded_meat']==21000 and order(empty_cancel)['commission_meat']==0
        cancel_race=create(100);fund(cancel_race)
        payload=mail(cancel_race,'fill',uid=seller,quantity=20)
        with ThreadPoolExecutor(max_workers=2) as pool:
            jobs=[pool.submit(ingest,payload),pool.submit(call,f"select public.cancel_auction('{cancel_race}');")]
            for job in jobs:job.result()
        o=order(cancel_race);assert o['purchased_quantity'] in (0,20)
        assert o['funded_meat']==o['purchase_meat']+o['commission_meat']+o['refunded_meat']
        assert auction(cancel_race)['settlement_outcome']=='cancelled'
        # Two identical intake calls after a worker restart still allocate once.
        duplicate=create(100);fund(duplicate);payload=mail(duplicate,'fill',uid=seller,quantity=10)
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes=list(pool.map(ingest,[payload,payload]))
        assert sorted(outcomes)==['accepted','duplicate'] and order(duplicate)['purchased_quantity']==10
        # Compare exact obligation deltas, ensuring requested items are never
        # treated as inventory and a fill does not free the seller's payment.
        liability_order=create(100,200,'finished')
        before=json.loads(sql('select public.bot_liabilities();'));fund(liability_order)
        after=json.loads(sql('select public.bot_liabilities();'))
        assert int(after['meat'])-int(before['meat'])==21000
        assert int(after['items'].get(str(item),0))==int(before['items'].get(str(item),0))
        before=after;fill(liability_order,20);after=json.loads(sql('select public.bot_liabilities();'))
        assert int(before['meat'])-int(after['meat'])==200
        assert int(after['items'][str(item)])-int(before['items'].get(str(item),0))==20
        profile=json.loads(call(f"select public.read_auction_page('seller','{seller}','','all','ending',1);"))['seller']
        assert int(profile['stats']['buy_order_sales'])>0
        assert json.loads(sql('set role service_role;select public.bot_inspect();'))['buyAuctionsVersion']==1
        print('PASS: zero-fill cancellation, cancel/fill race, simultaneous duplicate replay, exact Meat/item liability conservation and seller profile totals')
        # Preserved sell flows are exercised AFTER the buy migration, including
        # staged receipt-time bidding and the actual delivery formatter/claim path.
        sell_name=sql(f"select name from khub_bot.catalog where id={item};")
        def sell_create(escrow):return call(f"select public.create_auction({lit(sell_name)},5,100,24,null,null,{item},{str(escrow).lower()});")
        direct=sell_create(False);call(f"select public.place_bid('{direct}',100);",seller)
        assert auction(direct)['current_bid']==100 and auction(direct)['auction_kind']=='sell'
        assert projected(direct,seller)[0]['viewer_is_highest_bidder'] is True
        assert projected(direct,buyer)[0]['viewer_is_highest_bidder'] is False
        sell_escrow=sell_create(True);assert ingest(mail(sell_escrow,'list',quantity=5))=='accepted'
        bid=mail(sell_escrow,'bid',uid=seller,meat=100)
        epoch=sql("select floor(extract(epoch from clock_timestamp()))::bigint;")
        bid['received_at']=sql(f'select to_timestamp({epoch});');bid['raw']['azunixtime']=epoch
        scan=json.loads(sql('select public.bot_begin_inbox_scan();'))
        sql('select public.bot_stage_inbox_scan('+lit(scan['id'])+'::uuid,'+lit(json.dumps([bid]))+');')
        assert ingest(bid)=='accepted'
        sql(f"update public.auctions set created_at=created_at-interval '2 hours',end_time=clock_timestamp()-interval '2 minutes' where id='{sell_escrow}';")
        sql(f"select public.bot_finish_inbox_scan('{scan['id']}');")
        assert auction(sell_escrow)['settlement_outcome']=='completed' and auction(sell_escrow)['fee_meat']==5
        settle(sell_escrow);assert auction(sell_escrow)['status']=='completed'
        # Real claim uses the frozen message + existing acknowledgment contract.
        claimed=json.loads(sql("set role service_role;select public.bot_claim_delivery(2);"))
        assert claimed and claimed['message'] and claimed['attempt']
        sql(f"set role service_role;select public.bot_ack_delivery('{claimed['id']}','{claimed['attempt']}',true,'Fixture claim acknowledged, no game connection.');")
        stats=json.loads(sql('set role service_role;select public.bot_financial_stats();'))
        assert int(stats['buy_orders']['fulfillments'])>0 and int(stats['sales']['completed'])>=1
        history=json.loads(sql("set role service_role;select public.bot_financial_history('buy-orders',0,20);"))
        assert history['records'] and all(int(r['sale_meat'])>0 for r in history['records'])
        print('PASS: existing Direct bids and receipt-time Sell escrow settlement still work after migration; delivery claims format, reports separate buy fills from sell trades')

    finally:
        if started:pg('-m','fast','-w','stop')
