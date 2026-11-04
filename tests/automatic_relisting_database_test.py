"""Automatic escrow relisting integration and financial isolation.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/automatic_relisting_database_test.py
"""
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-public-projection-',dir='/tmp') as folder:
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
        sql("create schema storage; create table storage.buckets(id text primary key,public boolean); insert into storage.buckets values('creator-photos',false); create table storage.objects(bucket_id text,name text);")
        migrations=sorted([*ROOT.glob('supabase/migrations/*.sql'),*ROOT.glob('supabase/migrations/queue/*.sql')],key=lambda p:p.name)
        assert len({p.name for p in migrations})==len(migrations)
        
        read_probe="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','khub_bot') and p.prokind='f' and (p.proname like 'read_%' or p.proname in ('bot_tick','bot_finish_inbox_scan','finalize_auction','finalize_expired_auctions','bot_worker_status')) and p.proname<>'read_public_auction_live_batch';"""
        for migration in migrations:
            if '193_automatic' in migration.name: before_reads=sql(read_probe)
            sql(migration.read_text())
            if '193_automatic' in migration.name:
                assert sql(read_probe)==before_reads, 'Relisting changed browsing, polling or finalization entry points'
        # Capture webhook payloads locally, without network or credentials.
        sql("""create schema net;
            create table net.test_requests(body jsonb);
            create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin insert into net.test_requests values(body);return 1;end;$$;
            insert into khub_bot.public_cache_webhook_config values(true,'https://fixture.invalid/api/public-auctions/invalidate',repeat('a',64));""")
        catalog=json.loads((ROOT/'src/data/items.json').read_text())
        catalog += [{'id':1900000+i,'name':f'Untradeable fixture {i}','image':'test.gif','tradeable':False}
            for i in range(max(0,10000-len(catalog)))]
        sql('select public.bot_replace_item_catalog('+lit(json.dumps(catalog))+",now(),repeat('a',64));")
        def account(mid,player,name):
            payload={'id':str(mid),'sender_id':player,'sender_name':name,'received_at':'2026-10-21T12:00:00Z',
                'command':{'type':'register'},'meat':0,'items':[],'raw':{'id':str(mid),'fromid':str(player),'fromname':name,'type':'normal','message':'REGISTER'}}
            job=json.loads(sql('select public.bot_prepare_account_mail('+lit(json.dumps(payload))+",'Kh9!FixturePassword');"))
            sql(f"insert into auth.users(id,email,encrypted_password,raw_app_meta_data) values('{job['user_id']}',{lit(job['login_email'])},'fixture-hash',"+lit(json.dumps({'khub_account_job':str(mid)}))+');')
            sql(f"select public.bot_finish_account_job('{mid}');")
            sql(f"insert into auth.sessions values('{uuid4()}','{job['user_id']}');")
            return job['user_id']
        owner=account(99001,48889901,'Relist Seller')
        other=account(99002,48889902,'Relist Buyer')
        def create(count=3,reduction=5,**extra):
            listing={'item':'seal tooth','itemId':2,'quantity':1,'minBidMeat':100,'auctionTime':'24',
                     'instantPurchasePrice':200,'escrowMode':True,**extra}
            return sql('select public.create_relisting_auction('+lit(json.dumps(listing))+f'::jsonb,{count},{reduction});',owner)
        def state(aid):
            return json.loads(sql(f"select row_to_json(a) from public.auctions a where id='{aid}';"))
        def liabilities():
            return json.loads(sql('set role service_role;select public.bot_liabilities();'))
        def fund(aid):
            sql(f"update public.auctions set status='active',item_escrowed_at=now() where id='{aid}';")
        def expire(aid,authorized=True):
            sql(f"update public.auctions set created_at=now()-interval '1 day',end_time=now()-interval '2 minutes' where id='{aid}';")
            if authorized:
                scan=sql("insert into khub_bot.inbox_scans(started_at,staged_at,completed_at) values(now(),now(),now()) returning id;")
                sql(f"insert into khub_bot.escrow_close_authorizations values('{aid}','{scan}');")
            sql(f"select khub_bot.finish_listing('{aid}','deadline');")
            sql(f"delete from khub_bot.escrow_close_authorizations where auction_id='{aid}';")
        aid=create();fund(aid)
        held=liabilities()
        # No complete post-deadline inbox scan: no retry and no return.
        expire(aid,False)
        assert state(aid)['min_bid_meat']==100
        for attempt,price in enumerate([95,90,85],1):
            notices=int(sql('select count(*) from net.test_requests;'))
            expire(aid)
            assert int(sql('select count(*) from net.test_requests;'))==notices+1
            assert json.loads(sql('select body from net.test_requests order by ctid desc limit 1;'))['auction_id']==aid
            live=json.loads(sql(f"set role anon;select public.read_public_auction_live_batch(array['{aid}'::uuid]);"))
            assert live['rows'][0]['min_bid_meat']==price
            a=state(aid)
            assert a['status']=='active' and a['min_bid_meat']==price and a['instant_purchase_price']==200,a
            assert a['item_escrowed_at'] and a['settlement_outcome'] is None
            assert liabilities()==held, 'Relisting changed escrow liabilities'
            assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{aid}';")=='0'
            assert sql(f"select completed from khub_bot.auction_relist_plans where auction_id='{aid}';")==str(attempt)
            # Repeated tick/settlement call cannot consume another attempt.
            sql(f"select khub_bot.finish_listing('{aid}','deadline');")
            assert sql(f"select completed from khub_bot.auction_relist_plans where auction_id='{aid}';")==str(attempt)
        expire(aid)
        assert state(aid)['settlement_outcome']=='ended_no_bids'
        assert liabilities()==held, 'Final return lost or duplicated held assets'
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{aid}' and kind='return_item';")=='1'
        sql(f"select khub_bot.finish_listing('{aid}','deadline');")
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{aid}' and kind='return_item';")=='1'
        assert sql(f"select count(*) from khub_bot.auction_relist_events where auction_id='{aid}';")=='3'
        notices=sql('select count(*) from net.test_requests;')
        sql('set role service_role;select public.bot_tick();')
        assert sql('select count(*) from net.test_requests;')==notices, 'Idle bot tick invalidated shared cache'
        # Same-price, rounding floor, bundles, custom deadlines and cancellation.
        same=create(1,0);fund(same);expire(same);assert state(same)['min_bid_meat']==100
        tiny=create(1,99,minBidMeat=1,instantPurchasePrice=None);fund(tiny);expire(tiny);assert state(tiny)['min_bid_meat']==1
        bundle=create(1,5,bundleItems=[{'id':2,'quantity':2},{'id':364,'quantity':3}],bundleTitle='Relist fixture')
        fund(bundle);before=state(bundle);bundle_held=liabilities();expire(bundle);after=state(bundle)
        assert liabilities()==bundle_held
        expire(bundle)
        assert liabilities()==bundle_held
        assert json.loads(sql(f"select jsonb_object_agg(item_id,quantity) from khub_bot.deliveries where auction_id='{bundle}' and kind='return_item';"))=={'2':2,'364':3}
        for key in ['id','item','bundle_items','image','quantity','seller_id','fee_policy','fee_bps','item_escrowed_at']:
            assert before[key]==after[key],key
        custom=create(1,5,customEndAt=sql("select (now()+interval '3 hours')::text;"));fund(custom);expire(custom)
        assert sql(f"select custom_end_at=end_time and end_time>now()+interval '2 hours' from public.auctions where id='{custom}';")=='t'
        cancelled=create();fund(cancelled)
        sql(f"set role authenticated;select public.cancel_auction('{cancelled}');",other,error='Only the seller')
        sql(f"set role authenticated;select public.cancel_auction('{cancelled}');",owner)
        assert state(cancelled)['settlement_outcome']=='cancelled'
        assert sql(f"select completed from khub_bot.auction_relist_plans where auction_id='{cancelled}';")=='0'
        after_retry=create();fund(after_retry);expire(after_retry)
        cancel_held=liabilities()
        sql(f"set role authenticated;select public.cancel_auction('{after_retry}');",owner)
        assert state(after_retry)['settlement_outcome']=='cancelled'
        assert liabilities()==cancel_held
        assert sql(f"select completed from khub_bot.auction_relist_plans where auction_id='{after_retry}';")=='1'
        sql(f"select khub_bot.finish_listing('{after_retry}','cancel');")
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{after_retry}' and kind='return_item';")=='1'
        # Invalid enrollment cannot leave a half-created listing or bypass permissions.
        for extra in [{'escrowMode':False},{'auctionKind':'buy'},{'giveawayTitle':'No'}]:
            listing={'item':'seal tooth','itemId':2,'quantity':1,'minBidMeat':100,'auctionTime':24,'escrowMode':True,**extra}
            sql('select public.create_relisting_auction('+lit(json.dumps(listing))+',1,5);',owner,error='only available')
        sql("select public.create_relisting_auction('{}',4,5);",owner,error='Choose 1 to 3')
        sql("set role anon; select public.create_relisting_auction('{}',1,5);",error='permission denied')
        # Exercise real staged intake: old-attempt mail refunds; new bids settle normally.
        funded=create();fund(funded);expire(funded)
        sql(f"update public.auctions set item_escrowed_at=now()-interval '2 days' where id='{funded}'; update khub_bot.auction_relist_plans set cycle_started_at=now()-interval '5 seconds' where auction_id='{funded}';")
        epoch=int(sql("select extract(epoch from now())::bigint;"))
        def bid(mid,when):
            return {'id':str(mid),'sender_id':48889902,'sender_name':'Relist Buyer',
                'received_at':datetime.fromtimestamp(when,timezone.utc).isoformat(),
                'command':{'type':'bid','auction_id':funded},'meat':100,'items':[],
                'raw':{'type':'normal','azunixtime':when}}
        old=bid(99100,epoch-20);fresh=bid(99101,epoch-1)
        scan=json.loads(sql('set role service_role; select public.bot_begin_inbox_scan();'))['id']
        sql(f"set role service_role;select public.bot_stage_inbox_scan('{scan}',{lit(json.dumps([old,fresh]))});")
        assert sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(old))+');')=='Bidding is closed.'
        assert sql("select sum(meat) from khub_bot.deliveries where receipt_id='99100' and kind='refund';")=='100'
        assert sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(fresh))+');')=='accepted'
        sql(f"set role service_role;select public.bot_finish_inbox_scan('{scan}');")
        # A delayed old-attempt mail arriving after a valid new-attempt bid must
        # refund without triggering the out-of-order timing hold for this cycle.
        delayed=bid(99102,epoch-10)
        scan=json.loads(sql('set role service_role;select public.bot_begin_inbox_scan();'))['id']
        sql(f"set role service_role;select public.bot_stage_inbox_scan('{scan}',{lit(json.dumps([delayed]))});")
        assert sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(delayed))+');')=='Bidding is closed.'
        assert state(funded)['status']=='active' and not state(funded)['escrow_timing_review']
        sql(f"set role service_role;select public.bot_finish_inbox_scan('{scan}');")
        sql(f"set role authenticated;select public.cancel_auction('{funded}');",owner,error='with bids cannot')
        expire(funded)
        assert state(funded)['settlement_outcome']=='completed'
        assert sql(f"select completed from khub_bot.auction_relist_plans where auction_id='{funded}';")=='1'
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{funded}' and kind='return_item';")=='0'
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{funded}' and kind='sale_item';")=='1'
        # Winner items and seller payout are distinct obligations. Completion
        # waits for both acknowledgments; an unknown send stays reserved.
        assert state(funded)['status']=='settling'
        assert state(funded)['winner_id']==other and state(funded)['final_price']==100
        assert sql(f"select sum(meat) from khub_bot.deliveries where auction_id='{funded}' and kind='sale_meat';")==str(100-state(funded)['fee_meat'])
        sql(f"set role authenticated;select public.cancel_auction('{funded}');",owner,error='already closed')
        obligations=json.loads(sql(f"select jsonb_agg(jsonb_build_object('id',id,'kind',kind)) from khub_bot.deliveries where auction_id='{funded}';"))
        for obligation in sorted(obligations,key=lambda d:d['kind']):
            attempt=str(uuid4())
            sql(f"update khub_bot.deliveries set state='sending',attempt='{attempt}' where id='{obligation['id']}';")
            if obligation['kind']=='sale_item':
                reserved=liabilities()
                sql(f"set role service_role;select public.bot_ack_delivery('{obligation['id']}','{attempt}',false,'Synthetic uncertain-send fixture');")
                assert state(funded)['status']=='settling' and liabilities()==reserved
                # Only the synthetic fixture is re-claimed here; no real resend.
                sql(f"update khub_bot.deliveries set state='sending' where id='{obligation['id']}';")
            sql(f"set role service_role;select public.bot_ack_delivery('{obligation['id']}','{attempt}',true,'Synthetic confirmed-delivery fixture');")
            sql(f"set role service_role;select public.bot_ack_delivery('{obligation['id']}','{attempt}',true,'Synthetic duplicate acknowledgment');",error='claim does not match')
        assert state(funded)['status']=='completed'
        sql(f"select khub_bot.finish_listing('{funded}','deadline');")
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{funded}' and kind in ('sale_item','sale_meat');")=='2'
        assert sql(f"select count(*) from khub_bot.promotional_escrow_volume where transaction_key='sell:{funded}';")=='1'
        # Real scan completion opens exactly one new attempt, even when several
        # bot processes call completion concurrently. Only one owns this scan.
        boundary=create();fund(boundary)
        sql(f"update public.auctions set created_at=now()-interval '1 day',item_escrowed_at=now()-interval '1 day',end_time=now()-interval '2 minutes' where id='{boundary}';")
        scan=json.loads(sql('set role service_role;select public.bot_begin_inbox_scan();'))['id']
        sql(f"set role service_role;select public.bot_stage_inbox_scan('{scan}','[]');")
        processes=[subprocess.Popen([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1',
            '-c',f"set role service_role;select public.bot_finish_inbox_scan('{scan}');"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
        outcomes=[(process.communicate(),process.wait()) for process in processes]
        assert sum(code==0 for _,code in outcomes)==1,outcomes
        assert sql(f"select completed from khub_bot.auction_relist_plans where auction_id='{boundary}';")=='1'
        # KoL timestamps have no fractional seconds. A bid in the reopening
        # second is valid, and one in the preceding second is a normal refund.
        epoch=int(sql(f"select floor(extract(epoch from started_at)) from khub_bot.auction_relist_events where auction_id='{boundary}';"))
        funded=boundary
        before_open=bid(99103,epoch-1);at_open=bid(99104,epoch)
        scan=json.loads(sql('set role service_role;select public.bot_begin_inbox_scan();'))['id']
        sql(f"set role service_role;select public.bot_stage_inbox_scan('{scan}',{lit(json.dumps([before_open,at_open]))});")
        assert sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(before_open))+');')=='Bidding is closed.'
        assert sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(at_open))+');')=='accepted'
        assert sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(at_open))+');')=='duplicate'
        assert sql(f"select count(*) from public.bids where auction_id='{boundary}';")=='1'
        # The ordering protection still holds genuinely out-of-order current-cycle mail.
        sql(f"update khub_bot.escrow_mail_order set received_at=received_at+interval '1 second' where auction_id='{boundary}';")
        out_of_order=bid(99105,epoch)
        sql(f"set role service_role;select public.bot_stage_inbox_scan('"+json.loads(sql('set role service_role;select public.bot_begin_inbox_scan();'))['id']+f"',{lit(json.dumps([out_of_order]))});")
        sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(out_of_order))+');')
        assert state(boundary)['status']=='on_hold' and state(boundary)['escrow_timing_review']
        # 194: a scan started at +29s cannot settle; one started at +30s can.
        # Both paths use the real complete-scan entry point, not wall-clock expiry.
        for enrolled in [False, True]:
            grace=create(1,0);fund(grace)
            if not enrolled: sql(f"delete from khub_bot.auction_relist_plans where auction_id='{grace}';")
            sql(f"update public.auctions set created_at=now()-interval '1 day',end_time=now()-interval '45 seconds' where id='{grace}';")
            for delay in [29,30]:
                scan=sql(f"insert into khub_bot.inbox_scans(started_at,staged_at) select end_time+make_interval(secs=>{delay}),now() from public.auctions where id='{grace}' returning id;")
                sql(f"set role service_role;select public.bot_finish_inbox_scan('{scan}');")
                if delay==29:
                    assert state(grace)['status']=='active'
                    assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{grace}' and kind='return_item';")=='0'
                elif enrolled:
                    assert state(grace)['status']=='active'
                    assert sql(f"select completed from khub_bot.auction_relist_plans where auction_id='{grace}';")=='1'
                else: assert state(grace)['settlement_outcome']=='ended_no_bids'
            live=json.loads(sql(f"set role anon;select public.read_public_auction_live_batch(array['{grace}'::uuid]);"))['rows'][0]
            assert sql(f"select ({lit(live['finalization_not_before'])}::timestamptz-{lit(live['end_time'])}::timestamptz)=interval '30 seconds';")=='t'
        assert "interval '60 seconds'" in sql("select pg_get_functiondef('khub_bot.expire_buy_reservations()'::regprocedure);")
        print('Automatic relisting and 30-second settlement grace checks passed')
    finally:
        if started: pg('-m','immediate','-w','stop')
