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
with tempfile.TemporaryDirectory(prefix='khub-buy-reservations-',dir='/tmp') as folder:
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
        first=create(1000,200);assert order(first)['funding_required']==210000;fund(first)
        r=reserve(first,20);assert reserve(first,20)['id']==r['id']
        assert available(first)==980
        reserve(first,10,error='already have a reservation')
        reserve(first,1,buyer,error='own order')
        assert 'valid reservation' in ingest(mail(first,'fill',uid=seller2,quantity=1))
        assert 'valid reservation' in ingest(reserved_mail(first,r,uid=seller2))
        assert 'valid reservation' in ingest(reserved_mail(first,r,quantity=19))
        good=reserved_mail(first,r);assert ingest(good)=='accepted' and state(r)=='fulfilled'
        assert ingest(good)=='duplicate' and order(first)['purchased_quantity']==20
        sql(f"delete from khub_bot.inbox_bid_mail where mail_id='{good['id']}';")
        assert ingest(good)=='duplicate'
        assert sql(f"select processed from khub_bot.inbox_bid_mail where mail_id='{good['id']}';")=='t'
        assert order(first)['commission_meat']==200 and available(first)==979 # 50 Meat held for a possible gift
        d=claim_item(first);ack(d)
        assert available(first)==980 and order(first)['gift_meat']==0
        print('PASS: exact upfront commission reserve, authenticated idempotent reservations, exact quantity/owner matching, ordinary delivery releases temporary gift budget')
        race=create(100);fund(race)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures=[pool.submit(call,f"select public.reserve_buy_quantity('{race}',80);",uid) for uid in [seller,seller2]]
            outcomes=[]
            for future in futures:
                try:outcomes.append(json.loads(future.result()))
                except AssertionError as error:assert 'not currently available' in str(error)
        assert len(outcomes)==1 and available(race)==20
        protected=outcomes[0]
        # A received-before-deadline deposit is honored even when processing is late.
        late=create(10);fund(late);r=reserve(late,10)
        epoch=int(sql("select floor(extract(epoch from clock_timestamp()))::bigint;"))
        sql(f"update khub_bot.buy_reservations set created_at=to_timestamp({epoch-700}),expires_at=to_timestamp({epoch-61}) where id='{r['id']}';")
        payload=reserved_mail(late,r,received=epoch-62)
        assert ingest(payload)=='accepted' and state(r)=='fulfilled'
        expired=create(10);fund(expired);r=reserve(expired,10)
        sql(f"update khub_bot.buy_reservations set created_at=to_timestamp({epoch-700}),expires_at=to_timestamp({epoch-61}) where id='{r['id']}';")
        assert available(expired)==0
        complete_scan();assert state(r)=='expired' and available(expired)==10
        assert 'valid reservation' in ingest(reserved_mail(expired,r))
        print('PASS: concurrent reservations cannot overclaim; timely KMail survives delayed processing; expired reservations release only after complete safe scans')
        # Protect active seller commitments from delivery expense. Gift charge is
        # exactly once even if its RPC response or delivery acknowledgment is lost.
        gifts=create(100);fund(gifts);r=reserve(gifts,20);assert ingest(reserved_mail(gifts,r))=='accepted'
        protected=reserve(gifts,50,seller2)
        d=claim_item(gifts);assert charge(d)['payer']=='buyer';assert charge(d)['already_charged']
        assert order(gifts)['gift_meat']==50 and order(gifts)['balance_meat']==16750
        assert order(gifts)['reduced_quantity']==1
        assert state(protected)=='active'
        assert available(gifts)==29
        ack(d)
        assert order(gifts)['purchased_quantity']==20 and order(gifts)['reduced_quantity']==1
        sql(f"set role service_role;select public.bot_defer_buy_delivery('{d['id']}','{d['attempt']}');",error='Invalid buy delivery')
        print('PASS: 50-Meat gifts charged once, unreserved quantity shrinks, purchased and reserved quantities remain distinct and protected')
        # Exact full reservations can leave no free wrapping funds. No commitment
        # is reduced: retain items, notify buyer, accept a top-up, then deliver.
        tight=create(1);fund(tight);r=reserve(tight,1);assert ingest(reserved_mail(tight,r))=='accepted'
        d=claim_item(tight);assert charge(d)['authorized'] is False
        assert order(tight)['gift_meat']==0 and order(tight)['balance_meat']==0
        sql(f"set role service_role;select public.bot_defer_buy_delivery('{d['id']}','{d['attempt']}');")
        assert sql(f"select state from khub_bot.deliveries where id='{d['id']}';")=='pending'
        assert auction(tight)['status']=='settling' and not order(tight)['refund_finalized']
        assert ingest(mail(tight,'fund',meat=50))=='accepted'
        d=claim_item(tight);assert charge(d)['authorized'];ack(d);settle(tight)
        assert auction(tight)['status']=='completed' and order(tight)['gift_meat']==50
        print('PASS: no gift charge consumes seller commitments; underfunded gifts safely defer, accept buyer top-ups, and settle without lost items')
        held=create(10,200,'finished');fund(held);r=reserve(held,5);assert ingest(reserved_mail(held,r))=='accepted'
        assert order(held)['held_quantity']==5
        call(f"select public.cancel_auction('{held}');")
        assert order(held)['balance_meat']==1050 and not order(held)['refund_finalized']
        d=claim_item(held);assert charge(d)['authorized'];ack(d)
        assert order(held)['refunded_meat']==1000 and order(held)['gift_meat']==50
        settle(held);assert auction(held)['status']=='cancelled'
        # Known not-attempted requests release charges; unknown gift outcomes do
        # not release or resend until the existing evidence-based reconciliation.
        interrupted=create(20);fund(interrupted);r=reserve(interrupted,5);ingest(reserved_mail(interrupted,r));d=claim_item(interrupted);charge(d)
        sql(f"set role service_role;select public.bot_defer_buy_delivery('{d['id']}','{d['attempt']}');")
        assert order(interrupted)['gift_meat']==0 and order(interrupted)['reduced_quantity']==0
        d=claim_item(interrupted);charge(d);ack(d,False)
        assert order(interrupted)['gift_meat']==50
        sql(f"set role service_role;select public.bot_reconcile_delivery('{d['id']}',false,'Fixture proves gift was not sent; release its budget once.');")
        assert order(interrupted)['gift_meat']==0
        print('PASS: finished delivery charges at settlement, refunds only remaining funds; known no-send and uncertain sends keep distinct recoverable accounting')
        # No cancellation can revoke a live seller reservation or spend its Meat.
        committed=create(10);fund(committed);r=reserve(committed,5)
        call(f"select public.cancel_auction('{committed}');")
        assert auction(committed)['status']=='active' and order(committed)['close_reason']=='cancel'
        assert available(committed)==0 and order(committed)['refunded_meat']==0
        assert ingest(reserved_mail(committed,r))=='accepted'
        d=claim_item(committed);ack(d);assert order(committed)['refunded_meat']==1050
        settle(committed);assert auction(committed)['status']=='cancelled'
        # Direct RPCs cannot expose reservations or internal budget functions.
        for table in ['buy_reservations','buy_gift_expenses','buy_order_events']:
            call(f'select * from khub_bot.{table};',seller,error='permission denied')
        sql(f"set role anon;select public.reserve_buy_quantity('{first}',1);",error='permission denied')
        sql(f"set role authenticated;select public.bot_charge_buy_gift('{d['id']}','{d['attempt']}');",seller,error='permission denied')
        rows=projected(gifts,buyer);assert rows[0]['reduced_quantity']==1 and rows[0]['purchased_quantity']==20
        assert rows[0]['my_reservation'] is None and 'reservation_audit' not in rows[0]
        assert projected(gifts,seller2)[0]['my_reservation']['id']==protected['id']
        assert 'reservation_audit' in projected(gifts,admin)[0]
        # Abuse controls are creation/active limits, never bans or forfeited items.
        fresh,_=account(91005,48889105,'Reservation Limit Fixture')
        orders=[create(10) for _ in range(4)]
        for ident in orders:fund(ident)
        for ident in orders[:3]:reserve(ident,1,fresh)
        reserve(orders[3],1,fresh,error='maximum 3 active')
        def expire_fresh():
            sql(f"update khub_bot.buy_reservations set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '70 seconds' where seller_id='{fresh}' and state='active';")
            complete_scan()
        expire_fresh()
        for _ in range(9):reserve(orders[0],1,fresh);expire_fresh()
        reserve(orders[0],1,fresh,error='maximum 12 per hour')
        assert sql("select count(*) from khub_bot.account_bans where kol_player_id=48889105;")=='0'
        print('PASS: cancellation honors commitments; reservation privacy/admin audit; 3-active and 12/hour safeguards impose no automatic penalties')

    finally:
        if started:pg('-m','fast','-w','stop')
