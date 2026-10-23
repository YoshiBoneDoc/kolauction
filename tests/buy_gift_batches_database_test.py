"""Exercise bot-paid Buy gifts, cross-purchase batching, escrow and recovery.
Creates a disposable local PostgreSQL database; no live Supabase or KoL calls.
Run: python3 tests/buy_gift_batches_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-gift-batches-reservations-',dir='/tmp') as folder:
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
            path=Path(folder)/f'query-{serial}-{uuid4()}.sql'
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
            if migration.name<'202610230096_': sql(migration.read_text())
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
        def complete_fill(ident,qty,uid=seller):
            r=reserve(ident,qty,uid);m=reserved_mail(ident,r,uid=uid);assert ingest(m)=='accepted';return m
        def prep(ident,gift=True):return json.loads(sql(f"set role service_role;select public.bot_prepare_buy_delivery('{ident}',{'null' if gift is None else str(gift).lower()});"))
        def items(ident):return json.loads(sql(f"select coalesce(jsonb_agg(to_jsonb(d) order by created_at,id),'[]') from khub_bot.deliveries d where auction_id='{ident}' and kind='sale_item' and state not in ('sent','cancelled');"))
        def sent_other():sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where kind<>'sale_item' and state='pending';update khub_bot.closet_transfers set state='moved' where state='pending';")
        def claim():return json.loads(sql('set role service_role;select public.bot_claim_delivery(3);') or 'null')
        def clean(mid):return json.loads(sql(f"set role service_role;select public.bot_mail_cleanup(array['{mid}']);"))
        def fingerprint(ident):return sql(f"select jsonb_build_object('order',(select to_jsonb(o) from khub_bot.buy_orders o where auction_id='{ident}'),'bids',(select jsonb_agg(to_jsonb(b)) from public.bids b),'fulfillments',(select jsonb_agg(to_jsonb(f)) from khub_bot.buy_fulfillments f where auction_id='{ident}'));")
        def relax_fixture_limit():sql("update khub_bot.buy_reservations set created_at=clock_timestamp()-interval '2 hours' where state<>'active';")
        # Upgrade an open order with a real old-policy charge; no deposit/top-up is required afterward.
        legacy=create(100,200);fund(legacy);complete_fill(legacy,20);d=claim_item(legacy);assert charge(d)['payer']=='buyer';ack(d)
        assert order(legacy)['gift_meat']==50
        old_balance=order(legacy)['balance_meat'];old_deliveries=sql(f"select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d where auction_id='{legacy}';")
        historical=create(10,100,'finished');fund(historical);complete_fill(historical,1)
        call(f"select public.cancel_auction('{historical}');")
        old_gift=claim_item(historical);assert charge(old_gift)['payer']=='buyer';ack(old_gift)
        sent_other();sql('select public.bot_tick();')
        historical_before=order(historical);assert historical_before['refund_finalized'] and historical_before['gift_meat']==50
        uncertain=create(100,200);fund(uncertain);complete_fill(uncertain,20)
        old_uncertain=claim_item(uncertain);assert charge(old_uncertain)['payer']=='buyer';ack(old_uncertain,False)
        old_deliveries=sql(f"select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d where auction_id='{legacy}';")
        sql(next(p for p in migrations if p.name.startswith('202610230096_')).read_text())
        assert order(historical)==historical_before
        assert items(uncertain)[0]['state']=='unknown' and order(uncertain)['gift_meat']==0
        sql(f"set role service_role;select public.bot_reconcile_delivery('{old_uncertain['id']}',true,'Fixture verified the original gift was delivered exactly once.');")

        assert order(legacy)['gift_meat']==0 and order(legacy)['balance_meat']==old_balance+50 and order(legacy)['reduced_quantity']==0
        assert sql(f"select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d where auction_id='{legacy}';")==old_deliveries
        assert available(legacy)==80
        assert json.loads(sql('set role service_role;select public.bot_inspect();'))['buyDeliveryBatchingVersion']==1
        sql('set role service_role;select public.bot_claim_delivery(2);',error='Update the bot')
        sent_other();relax_fixture_limit()
        assert [int(sql(f'select khub_bot.buy_gift_threshold({price});')) for price in [1,49,50,999,1000,49999,50000,20000000000]]==[1000,1000,100,100,10,10,1,1]
        for price,threshold in [(49,1000),(50,100),(999,100),(1000,10),(49999,10),(50000,1)]:
            ident=create(threshold+10,price);fund(ident)
            part=max(1,threshold-1);complete_fill(ident,part)
            before=fingerprint(ident);held_before=json.loads(sql('select public.bot_liabilities();'))
            result=prep(ident)
            assert result['state']==('ready' if threshold==1 else 'accumulating')
            assert fingerprint(ident)==before and json.loads(sql('select public.bot_liabilities();'))==held_before
            assert available(ident)==threshold+10-part
            if threshold>1:
                sent_other();assert claim() is None
                complete_fill(ident,1,seller2)
                held_before=json.loads(sql('select public.bot_liabilities();'));result=prep(ident)
                assert result['state']=='batched' and result['quantity']==threshold
                assert json.loads(sql('select public.bot_liabilities();'))==held_before
            sent_other();d=claim();assert d['auction_id']==ident and d['quantity']==threshold
            o=fingerprint(ident);assert charge(d)['payer']=='bot';assert charge(d)['already_authorized'];assert fingerprint(ident)==o
            ack(d);assert fingerprint(ident)==o
            assert sql(f"select bot_paid_meat from khub_bot.buy_gift_expenses where delivery_id='{d['id']}';")=='50'
            assert order(ident)['gift_meat']==0 and order(ident)['reduced_quantity']==0
            assert available(ident)==threshold+10-threshold
            relax_fixture_limit()
        print('PASS: every price boundary; threshold is a minimum; bot cost authorization/ack leaves escrow, commissions, reservations and purchasing quantity untouched')
        # Multiple fulfillments in one scan cycle and previous cycles become one whole package.
        bulk=create(1000,100);fund(bulk)
        mails=[complete_fill(bulk,200),complete_fill(bulk,300,seller2),complete_fill(bulk,21)]
        before=fingerprint(bulk);liabilities=sql('select public.bot_liabilities();')
        result=prep(bulk);assert result['quantity']==521 and result['state']=='batched'
        assert len(items(bulk))==1 and items(bulk)[0]['quantity']==521
        assert sql('select public.bot_liabilities();')==liabilities and fingerprint(bulk)==before
        assert prep(bulk)['state']=='ready' and len(items(bulk))==1
        batch_id=result['deliveries'][0]
        assert int(sql(f"select count(*) from khub_bot.buy_item_batch_members where delivery_id='{batch_id}';"))==3
        assert int(sql(f"select jsonb_array_length(source_deliveries) from khub_bot.buy_item_batches where auction_id='{bulk}';"))==3
        sent_other()
        for m in mails:assert clean(m['id'])==[]
        d=claim();assert d['id']==batch_id and d['quantity']==521
        assert charge(d)['payer']=='bot';ack(d,False)
        assert items(bulk)[0]['state']=='unknown'
        assert prep(bulk)['state']=='empty'
        for m in mails:assert clean(m['id'])==[]
        sql(f"set role service_role;select public.bot_reconcile_delivery('{d['id']}',true,'Fixture matching gift package contents and reference verified.');")
        for m in mails:assert clean(m['id'])==[m['id']]
        assert len(items(bulk))==0 and order(bulk)['gift_meat']==0
        relax_fixture_limit()
        # Under-threshold accumulation survives restart, profile failures and a fresh ordinary status.
        ordinary=create(100,100);fund(ordinary);complete_fill(ordinary,3);complete_fill(ordinary,4,seller2)
        assert prep(ordinary)['state']=='accumulating'
        pg('-l',str(Path(folder)/'postgres.log'),'-m','fast','-w','restart')
        assert prep(ordinary,None)['state']=='profile_unknown';sent_other();assert claim() is None
        assert prep(ordinary,False)['state']=='ordinary' and len(items(ordinary))==2
        d=claim();assert d['quantity'] in (3,4)
        # Buyer ascended after the ordinary profile check: no premature small gift.
        assert charge(d)=={'payer':'bot','authorized':False,'reason':'batch_recheck'}
        sql(f"set role service_role;select public.bot_defer_buy_delivery('{d['id']}','{d['attempt']}');")
        assert prep(ordinary,False)['state']=='ordinary'
        for _ in range(2):d=claim();ack(d)
        assert order(ordinary)['gift_meat']==0
        relax_fixture_limit()
        # All terminal paths flush remainders, even one cheap item; a full fill can be below the threshold.
        for reason in ['cancel','deadline','filled']:
            ident=create(1 if reason=='filled' else 10,10);fund(ident);complete_fill(ident,1)
            if reason=='cancel':call(f"select public.cancel_auction('{ident}');")
            elif reason=='deadline':
                sql(f"update public.auctions set end_time=clock_timestamp()-interval '2 minutes',created_at=clock_timestamp()-interval '1 day' where id='{ident}';")
                complete_scan()
            result=prep(ident);assert result['state']=='ready'
            sent_other();d=claim();assert d['auction_id']==ident and d['quantity']==1
            before=fingerprint(ident);assert charge(d)['payer']=='bot';assert fingerprint(ident)==before;ack(d)
            sent_other();sql('select public.bot_tick();')
            expected='cancelled' if reason=='cancel' else 'expired' if reason=='deadline' else 'completed'
            assert auction(ident)['status']==expected,(reason,auction(ident))
            assert order(ident)['refunded_meat']==order(ident)['funding_required']-order(ident)['purchase_meat']-order(ident)['commission_meat']
            assert order(ident)['gift_meat']==0
            relax_fixture_limit()
        print('PASS: 521 accumulated items produce one package; sent/unknown cleanup and restart safety; ordinary KMail unchanged; cancellation/expiry/full fill flush all remainders')
        # Existing seller commitments survive cancellation and free packaging.
        protected=create(100,200);fund(protected);complete_fill(protected,20)
        reserved=reserve(protected,50,seller2);assert available(protected)==30
        bad=reserved_mail(protected,reserved,uid=seller2,quantity=51)
        assert 'valid reservation' in ingest(bad) and order(protected)['purchased_quantity']==20
        call(f"select public.cancel_auction('{protected}');")
        assert state(reserved)=='active' and prep(protected)['state']=='ready'
        sent_other();d=claim();assert d['auction_id']==protected;charge(d);ack(d)
        assert state(reserved)=='active' and order(protected)['balance_meat']==16800
        good=reserved_mail(protected,reserved,uid=seller2);assert ingest(good)=='accepted' and ingest(good)=='duplicate'
        assert state(reserved)=='fulfilled' and order(protected)['purchased_quantity']==70
        prep(protected);sent_other();d=claim();charge(d);ack(d);sent_other();sql('select public.bot_tick();')
        assert order(protected)['refunded_meat']==6300 and auction(protected)['status']=='cancelled'
        relax_fixture_limit()
        # A proven no-send can combine with later purchases, preserving the
        # original batch's receipt mapping. Concurrent preparation cannot duplicate it.
        retry=create(1000,100);fund(retry)
        original_mails=[complete_fill(retry,50),complete_fill(retry,50,seller2)]
        prep(retry);sent_other();d=claim();charge(d)
        sql(f"set role service_role;select public.bot_defer_buy_delivery('{d['id']}','{d['attempt']}');")
        original_mails.append(complete_fill(retry,200))
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:prep(retry),range(2)))
        assert sorted(r['state'] for r in results)==['batched','ready']
        assert len(items(retry))==1 and items(retry)[0]['quantity']==300
        pg('-l',str(Path(folder)/'postgres.log'),'-m','fast','-w','restart')
        sent_other();d=claim();assert d['quantity']==300;charge(d);ack(d)
        for source_mail in original_mails:assert clean(source_mail['id'])==[source_mail['id']]
        assert order(retry)['gift_meat']==0 and items(retry)==[]
        relax_fixture_limit()
        # The retained game-safe 1B transport ceiling must not strand its last
        # physical message below the logical batching threshold on a later cycle.
        huge=create(1000001000,1);fund(huge)
        complete_fill(huge,1000000000);complete_fill(huge,21,seller2)
        result=prep(huge);assert result['quantity']==1000000021 and len(items(huge))==2
        sent_other();d=claim();assert d['quantity']==1000000000;assert charge(d)['payer']=='bot';ack(d)
        assert prep(huge)['state']=='ready'
        d=claim();assert d['quantity']==21 and charge(d)['payer']=='bot';ack(d)
        assert items(huge)==[] and order(huge)['gift_meat']==0
        relax_fixture_limit()
        # Delivery-when-finished is unchanged except packaging is now kHub-funded.
        finished=create(10,200,'finished');fund(finished);complete_fill(finished,3)
        assert items(finished)==[] and order(finished)['held_quantity']==3
        call(f"select public.cancel_auction('{finished}');")
        sent_other();d=claim();assert d['auction_id']==finished and d['quantity']==3
        cost_before=order(finished)['balance_meat'];assert charge(d)['payer']=='bot'
        assert order(finished)['balance_meat']==cost_before
        held=int(json.loads(sql('select public.bot_liabilities();'))['meat'])
        queued_fees=int(sql("select coalesce(sum(meat),0) from khub_bot.closet_transfers where state in ('pending','moving','unknown');"))
        assert int(json.loads(sql('select public.bot_gift_wrapping_liabilities();'))['meat'])==held+queued_fees
        # A known no-send retries safely and preserves all the same assets.
        sql(f"set role service_role;select public.bot_defer_buy_delivery('{d['id']}','{d['attempt']}');")
        assert len(items(finished))==1 and order(finished)['gift_meat']==0
        sql(f"update khub_bot.buy_delivery_waits set retry_after=clock_timestamp()-interval '1 second' where delivery_id='{d['id']}';")
        d=claim();charge(d);ack(d);sent_other();sql('select public.bot_tick();')
        assert order(finished)['refunded_meat']==1470 and auction(finished)['status']=='cancelled'
        assert sql(f"select bot_paid_meat from khub_bot.buy_gift_expenses where delivery_id='{d['id']}';")=='50'
        report=json.loads(sql('set role service_role;select public.bot_financial_stats();'))
        assert report['buy_orders']['bot_packaging_meat']==sql('select coalesce(sum(bot_paid_meat),0)::text from khub_bot.buy_gift_expenses;')
        for role in ['anon','authenticated']:
            sql('set role '+role+';select public.bot_pending_buy_delivery_groups();',buyer,error='permission denied')
            sql(f"set role {role};select public.bot_prepare_buy_delivery('{bulk}',false);",buyer,error='permission denied')
        print('PASS: finished delivery, zero buyer packaging costs, exact unused reserve refunds, recoverable known no-send, idempotent paid expense audit and service-only batching')
    finally:
        if started:pg('-m','fast','-w','stop')
