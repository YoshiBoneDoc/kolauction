"""Exercise seller reservation cancellation, incoming-item races and escrow safety.
Creates a disposable local PostgreSQL database; no live Supabase or KoL calls.
Run: python3 tests/cancel_buy_reservations_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-cancel-reservations-',dir='/tmp') as folder:
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
            if migration.name<'202610220090_': sql(migration.read_text())
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
        ident=create(10,200,'finished');fund(ident);r=reserve(ident,4)
        before=snapshot();reservation_before=sql('select jsonb_agg(to_jsonb(r)) from khub_bot.buy_reservations r;')
        sql(next(p for p in migrations if p.name.startswith('202610220090_')).read_text())
        assert snapshot()==before and reservation_before==sql('select jsonb_agg(to_jsonb(r)) from khub_bot.buy_reservations r;')
        def cancel(res,uid=seller,error=None):
            value=call(f"select public.cancel_buy_reservation('{res['id']}');",uid,error)
            return json.loads(value) if not error else None
        cancel(r,seller2,error='not found for your account')
        cancel(r,buyer,error='not found for your account')
        sql(f"set role anon;select public.cancel_buy_reservation('{r['id']}');",error='permission denied')
        assert snapshot()==before and state(r)=='active'
        assert available(ident)==6
        assert cancel(r)['state']=='cancelled' and available(ident)==10
        after=snapshot();assert cancel(r)['state']=='cancelled' and snapshot()==after
        assert sql(f"select count(*) from khub_bot.buy_order_events where reservation_id='{r['id']}' and kind='reservation_cancelled';")=='1'
        assert order(ident)['balance_meat']==2100 and order(ident)['purchased_quantity']==0
        replacement=reserve(ident,10,seller2)
        old_mail=reserved_mail(ident,r)
        assert 'valid reservation' in ingest(old_mail)
        assert ingest(old_mail)=='duplicate' and order(ident)['purchased_quantity']==0
        assert sql(f"select coalesce(sum(d.quantity),0) from khub_bot.deliveries d where d.recipient_id=48889102 and d.kind='refund' and d.auction_id='{ident}';")=='4'
        assert ingest(reserved_mail(ident,replacement,uid=seller2))=='accepted'
        assert order(ident)['purchased_quantity']==10 and order(ident)['purchase_meat']==2000
        assert cancel(replacement,seller2)['state']=='fulfilled'
        assert order(ident)['purchased_quantity']==10
        print('PASS: migration preserves reservations/assets; owner-only and anonymous guards; atomic release and retry audit; old-command items returned once; completed fulfillments never reversed')

        pending=create(20,200,'finished');fund(pending);r=reserve(pending,5);payload=reserved_mail(pending,r)
        scan=json.loads(sql('select public.bot_begin_inbox_scan();'))
        sql(f"select public.bot_stage_inbox_scan('{scan['id']}',"+lit(json.dumps([payload]))+');')
        before=snapshot();cancel(r,error='already arrived');assert state(r)=='active' and snapshot()==before
        assert ingest(payload)=='accepted';assert cancel(r)['state']=='fulfilled'
        # Buyer close requests can settle after their final seller releases a reservation.
        closing=create(10,200,'finished');fund(closing);r=reserve(closing,10)
        call(f"select public.cancel_auction('{closing}');",buyer)
        assert not order(closing)['refund_finalized']
        assert cancel(r)['state']=='cancelled'
        assert order(closing)['refund_finalized'] and order(closing)['refunded_meat']==2100
        assert cancel(r)['state']=='cancelled'
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{closing}' and kind='refund';")=='1'
        print('PASS: staged incoming items protect their reservation; closing buyer order refunds once after release')
        for _ in range(3):
            racing=create(10,200,'finished');fund(racing);r=reserve(racing,10);payload=reserved_mail(racing,r)
            def try_cancel():
                try:return cancel(r)
                except AssertionError as failure:
                    assert 'already arrived' in str(failure);return None
            with ThreadPoolExecutor(max_workers=2) as pool:
                one=pool.submit(try_cancel);two=pool.submit(ingest,payload)
                result=one.result();outcome=two.result()
            if state(r)=='fulfilled':
                assert outcome=='accepted' and order(racing)['purchased_quantity']==10
                assert result is None or result['state']=='fulfilled'
            else:
                assert state(r)=='cancelled' and 'valid reservation' in outcome
                assert order(racing)['purchased_quantity']==0 and available(racing)==10
            o=order(racing)
            assert o['funded_meat']==sum(o[k] for k in ['balance_meat','purchase_meat','commission_meat','refunded_meat','gift_meat'])
        print('PASS: concurrent cancellation and fulfillment serialize without double spending, overselling or lost items')
    finally:
        if started:pg('-m','fast','-w','stop')
