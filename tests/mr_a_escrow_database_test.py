"""Mixed-asset escrow accounting, intake, settlement, delivery and recovery.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/mr_a_escrow_database_test.py
"""
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
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
        third=account(99003,48889903,'Mixed Bidder')
        sql("insert into khub_bot.market_prices values(194,70000000,now()-interval '1 minute',now()-interval '1 minute',true);")
        def create(rate=70000000,**extra):
            listing={'item':'seal tooth','itemId':2,'quantity':1,'minBidMeat':1000000,'auctionTime':'24',
                'instantPurchasePrice':None,'escrowMode':True,**extra}
            aid=sql('set role authenticated;select public.create_mr_a_auction('+lit(json.dumps(listing))+f',{rate});',owner)
            sql(f"update public.auctions set created_at=now()-interval '10 minutes' where id='{aid}';")
            return aid
        def state(aid): return json.loads(sql(f"select row_to_json(a) from public.auctions a where id='{aid}';"))
        # New creation requires explicit operator activation; ordinary users cannot activate.
        listing={'item':'seal tooth','itemId':2,'quantity':1,'minBidMeat':1,'auctionTime':'24','escrowMode':True}
        sql('set role authenticated;select public.create_mr_a_auction('+lit(json.dumps(listing))+',70000000);',owner,'not enabled')
        sql('set role authenticated;select public.set_mr_a_escrow_enabled(true);',owner,'permission denied')
        sql('delete from khub_bot.mr_a_escrow_config;')
        sql('set role service_role;select public.set_mr_a_escrow_enabled(true);',error='configuration is missing')
        sql('set role authenticated;select public.create_mr_a_auction('+lit(json.dumps(listing))+',70000000);',owner,'not enabled')
        sql('insert into khub_bot.mr_a_escrow_config values(true,false);')
        sql('set role service_role;select public.set_mr_a_escrow_enabled(true);')
        serial_mail=100000
        def payload(aid,cmd='bid',meat=0,q=0,sender=48889902,items=None,received=None):
            global serial_mail
            serial_mail+=1
            stamp=int(sql("select floor(extract(epoch from clock_timestamp()-interval '2 minutes'))::bigint;")) if received is None else received
            return {'id':str(serial_mail),'sender_id':sender,'sender_name':'Fixture player',
                'received_at':datetime.fromtimestamp(stamp,timezone.utc).isoformat(),
                'command':{'type':cmd,'auction_id':aid},'meat':meat,'items':items if items is not None else ([{'id':194,'quantity':q}] if q else []),
                'raw':{'id':str(serial_mail),'fromid':str(sender),'fromname':'Fixture player','type':'normal','azunixtime':str(stamp),'message':cmd.upper()+' '+aid}}
        def stage(mails):
            sid=json.loads(sql('set role service_role;select public.bot_begin_inbox_scan();'))['id']
            sql(f"set role service_role;select public.bot_stage_inbox_scan('{sid}',"+lit(json.dumps(mails))+');')
            return sid
        def ingest(p,staged=True,error=None):
            if staged and p['command']['type'] in ['bid','buy']: stage([p])
            return sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(p))+');',error=error)
        def fund(aid,items=None):
            lot=items or [{'id':2,'quantity':1}]
            p=payload(aid,'list',sender=48889901,items=lot)
            assert ingest(p)=='accepted'
            sql(f"update public.auctions set item_escrowed_at=now()-interval '5 minutes' where id='{aid}';")
            return p
        def liabilities(): return json.loads(sql('set role service_role;select public.bot_liabilities();'))
        def amounts(query):
            return json.loads(sql("select jsonb_build_object('meat',coalesce(sum(meat),0),'mr_a',coalesce(sum(quantity) filter(where item_id=194),0),'lot',coalesce(sum(quantity) filter(where item_id=2),0)) from khub_bot.deliveries where "+query+';'))
        def snapshot(): return sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b),'receipts',(select jsonb_agg(to_jsonb(r) order by mail_id) from khub_bot.receipts r),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        def finish(aid,instant=False):
            if not instant: sql(f"update public.auctions set created_at=least(created_at,now()-interval '10 minutes'),end_time=now()-interval '1 minute' where id='{aid}';")
            scan=stage([])
            sql(f"set role service_role;select public.bot_finish_inbox_scan('{scan}');")
        aid=create(instantPurchasePrice=150000000);fund(aid)
        baseline=liabilities()
        sql(f"set role authenticated;select public.place_mixed_bid('{aid}',6000000,1);",other,error='does not accept Direct')
        sql(f"set role authenticated;select public.place_bid('{aid}',76000000);",other,error='KMail')
        p=payload(aid,meat=6000000,q=1)
        ingest(p,False,error='staged inbox')
        assert ingest(p)=='accepted'
        a=state(aid);assert (a['current_bid'],a['payment_meat'],a['payment_mr_a'])==(76000000,6000000,1)
        held=liabilities();assert int(held['meat'])-int(baseline['meat'])==6000000
        assert int(held['items'].get('194',0))-int(baseline['items'].get('194',0))==1
        before=snapshot();assert ingest(p,False)=='duplicate';assert snapshot()==before
        changed={**p,'meat':6000001};ingest(changed,False,error='staged inbox')
        sid=json.loads(sql('set role service_role;select public.bot_begin_inbox_scan();'))['id']
        sql(f"set role service_role;select public.bot_stage_inbox_scan('{sid}',"+lit(json.dumps([changed]))+');',error='payload changed')
        # Future quotes do not reprice existing bids; new creation rejects them.
        sql("update khub_bot.market_prices set available=false where item_id=194;")
        p2=payload(aid,meat=0,q=2,sender=48889903)
        assert ingest(p2)=='accepted'
        refund=amounts("receipt_id='"+p2['id']+"' and dedupe_key like 'outbid:%'")
        assert refund=={'meat':6000000,'mr_a':1,'lot':0},refund
        before=snapshot();assert ingest(p2,False)=='duplicate';assert snapshot()==before
        sql(f"insert into khub_bot.administrators(user_id,note) values('{owner}','Synthetic test administrator');")
        bid_id=sql("select bid_id from khub_bot.bid_receipts where receipt_id='"+p['id']+"';")
        refs=json.loads(sql(f"select khub_bot.admin_bid_delivery_references('{bid_id}');",owner))
        assert len([r for r in refs if r['label']=='Bid refund'])==2,refs
        sql(f"delete from khub_bot.administrators where user_id='{owner}';")
        assert json.loads(sql(f"select khub_bot.admin_bid_delivery_references('{bid_id}');",owner))==[]
        held_before_review=liabilities()
        sql(f"update public.auctions set status='on_hold' where id='{aid}';")
        assert liabilities()==held_before_review
        assert state(aid)['payment_mr_a']==2
        hold=liabilities();assert int(hold['items']['194'])>=3
        reject=payload(aid,meat=1,q=3)
        assert ingest(reject)!='accepted'
        assert amounts("receipt_id='"+reject['id']+"' and kind='refund'")['mr_a']==3
        sql(f"update public.auctions set status='active' where id='{aid}';")
        # Cancel-with-bids cannot confiscate the bidder's physical assets.
        sql(f"select public.cancel_auction('{aid}');",owner,error='bids')
        impossible=payload(aid,meat=123,q=3)
        assert 'exceeds the buyout' in ingest(impossible)
        assert amounts("receipt_id='"+impossible['id']+"' and kind='refund'")=={'meat':123,'mr_a':3,'lot':0}
        wrong=payload(aid,meat=7,items=[{'id':2,'quantity':4},{'id':194,'quantity':1}])
        assert ingest(wrong)!='accepted'
        assert amounts("receipt_id='"+wrong['id']+"' and kind='refund'")=={'meat':7,'mr_a':1,'lot':4}
        # Buyout preserves Mr. A quantity, refunds only excess Meat.
        buy=payload(aid,'buy',meat=20000000,q=2)
        assert ingest(buy)=='accepted'
        a=state(aid);assert a['current_bid']==150000000 and a['payment_meat']==10000000 and a['payment_mr_a']==2
        assert amounts("receipt_id='"+buy['id']+"' and dedupe_key like 'excess:%'")=={'meat':10000000,'mr_a':0,'lot':0}
        assert amounts("receipt_id='"+buy['id']+"' and dedupe_key like 'outbid:%'")=={'meat':0,'mr_a':2,'lot':0}
        sql(f"select khub_bot.finish_listing('{aid}','instant');")
        assert state(aid)['status']=='active','No scan must mean no finalization'
        early=stage([])
        sql(f"update khub_bot.inbox_scans set started_at=(select escrow_buyout_received_at+interval '29 seconds' from public.auctions where id='{aid}') where id='{early}';")
        sql(f"set role service_role;select public.bot_finish_inbox_scan('{early}');")
        assert state(aid)['status']=='active','A pre-grace scan must not finalize'
        held_before=liabilities()
        sql('select public.set_escrow_promotion(false);')
        finish(aid,True)
        a=state(aid);assert a['status']=='settling' and a['fee_meat']==4110000 and a['waived_fee_meat']==0,a
        assert amounts(f"auction_id='{aid}' and kind='sale_meat'")=={'meat':5890000,'mr_a':2,'lot':0}
        assert amounts(f"auction_id='{aid}' and kind='sale_item'")=={'meat':0,'mr_a':0,'lot':1}
        sql(f"update public.auctions set payment_mr_a=0 where id='{aid}';",error='immutable')
        after=liabilities();assert int(held_before['meat'])-int(after['meat'])==4110000
        assert held_before['items']==after['items']
        before=snapshot();finish(aid,True);assert snapshot()==before
        # Rejection and excess plans are idempotent, even after settlement.
        before=snapshot();assert ingest(buy,False)=='duplicate';assert snapshot()==before
        # Restore quote only for new auctions; old ones never depend on it again.
        sql("update khub_bot.market_prices set available=true,observed_at=now(),checked_at=now() where item_id=194;")
        # Fee is based on full value, capped to Meat; remainder is permanently waived.
        for m,q,calculated,collected in [(2000000,1,2270000,2000000),(0,2,3910000,0),(10000000,1,2510000,2510000)]:
            sale=create();fund(sale)
            assert ingest(payload(sale,meat=m,q=q))=='accepted'
            finish(sale)
            a=state(sale)
            assert a['calculated_fee_meat']==calculated and a['fee_meat']==collected and a['waived_fee_meat']==calculated-collected,a
            assert amounts(f"auction_id='{sale}' and kind='sale_meat'")=={'meat':m-collected,'mr_a':q,'lot':0}
            fee=sql(f"select khub_bot.settle_mr_a_fee(a) from public.auctions a where id='{sale}';")
            assert int(fee)==collected
        # Promotional free allowance and discounted tiers still use full value.
        sql('select public.set_escrow_promotion(true);')
        sale=create();fund(sale);assert ingest(payload(sale,meat=0,q=1))=='accepted';finish(sale)
        assert state(sale)['fee_meat']==0 and state(sale)['calculated_fee_meat']==0
        discounted=create();fund(discounted);assert ingest(payload(discounted,meat=1,q=1))=='accepted';finish(discounted)
        a=state(discounted);assert a['calculated_fee_meat']==1400000 and a['fee_meat']==1 and a['waived_fee_meat']==1399999
        assert sql(f"select fee from khub_bot.promotional_escrow_volume where transaction_key='sell:{discounted}';")=='1'
        # Gate rollback never prevents bidding/settlement on existing auctions.
        paused=create();fund(paused)
        sql('set role service_role;select public.set_mr_a_escrow_enabled(false);')
        assert ingest(payload(paused,meat=6000000,q=1))=='accepted'
        finish(paused)
        assert state(paused)['status']=='settling' and amounts(f"auction_id='{paused}' and kind='sale_meat'")['mr_a']==1
        sql('set role authenticated;select public.create_mr_a_auction('+lit(json.dumps(listing))+',70000000);',owner,'not enabled')
        assert sql(f"select khub_bot.settle_mr_a_fee(a) from public.auctions a where id='{discounted}';")=='1'
        sql('set role service_role;select public.set_mr_a_escrow_enabled(true);')
        # Exact bundle deposits, including Mr. A as both lot and payment asset.
        bundle=create(bundleItems=[{'id':2,'quantity':2},{'id':194,'quantity':3}])
        invalid_deposit=payload(bundle,'list',sender=48889901,items=[{'id':2,'quantity':2}])
        assert ingest(invalid_deposit)!='accepted'
        fund(bundle,[{'id':2,'quantity':2},{'id':194,'quantity':3}])
        assert ingest(payload(bundle,meat=0,q=1))=='accepted'
        finish(bundle)
        assert amounts(f"auction_id='{bundle}' and kind='sale_item'")=={'meat':0,'mr_a':3,'lot':2}
        assert amounts(f"auction_id='{bundle}' and kind='sale_meat'")=={'meat':0,'mr_a':1,'lot':0}
        # A pending staged bid blocks finalization until durable receipt processing.
        pending=create();fund(pending)
        queued=payload(pending,meat=6000000,q=1)
        pending_scan=stage([queued])
        sql(f"set role service_role;select public.bot_finish_inbox_scan('{pending_scan}');",error='Pending bid mail')
        assert ingest(queued,False)=='accepted'
        sql(f"set role service_role;select public.bot_finish_inbox_scan('{pending_scan}');")
        assert state(pending)['status']=='active'
        # Forged opened-gift contents cannot enter the mixed intake path.
        forged=payload(pending,meat=10000000,q=1,sender=48889903)
        forged['raw']['gift_original']={'type':'giftshop'}
        ingest(forged,False,error='not been verified')
        # Verified gift contents use the SAME mixed receipt and reserve path.
        for gift_quantity,gift_rate in [(1,70000000),(6000000001,1000)]:
            sql(f"update khub_bot.market_prices set price_meat={gift_rate},available=true,observed_at=now(),checked_at=now() where item_id=194;")
            gift_auction=create(rate=gift_rate);fund(gift_auction)
            gift=payload(gift_auction,meat=6000000,q=gift_quantity)
            body='BID '+gift_auction
            original={**gift['raw'],'type':'giftshop','message':body+'<table class="item" rel="id=1167&n=1"><tr><td><img></td></tr></table>'}
            gift['raw']['gift_original']={**original,'message':original['message']+'<p>Inside Note:<p>Enjoy!'}
            envelope={'id':gift['id'],'wrapper_id':1167,'opened':False,'raw':original}
            sql('set role service_role;select public.bot_register_gift_mail('+lit(json.dumps([envelope]))+');')
            held=liabilities()
            before_gift={'meat':'1000000000000','items':{k:str(int(v)+1000) for k,v in held['items'].items()}}
            before_gift['items']['1167']='10'
            attempt=json.loads(sql('set role service_role;select public.bot_claim_gift_open('+lit(json.dumps(before_gift))+');'))
            after_gift={'meat':str(int(before_gift['meat'])+6000000),'items':dict(before_gift['items'])}
            after_gift['items']['1167']='9'
            after_gift['items']['194']=str(int(after_gift['items'].get('194','0'))+gift_quantity)
            sql(f"set role service_role;select public.bot_finish_gift_open('{attempt['id']}',"+lit(json.dumps(gift))+','+lit(json.dumps(after_gift))+');')
            unposted=liabilities()
            assert ingest(gift)=='accepted'
            assert liabilities()==unposted,'Posting proven contents must transfer, not duplicate or drop, their reserves'
            before=snapshot();assert ingest(gift,False)=='duplicate';assert snapshot()==before
        sql("update khub_bot.market_prices set price_meat=70000000,available=true,observed_at=now(),checked_at=now() where item_id=194;")
        # No-bid cancellation returns only the lot, with no sale fee.
        cancel=create();fund(cancel)
        sql(f"set role authenticated;select public.cancel_auction('{cancel}');",owner)
        assert amounts(f"auction_id='{cancel}' and kind='return_item'")=={'meat':0,'mr_a':0,'lot':1}
        # Automatic retry retains the original valuation after quote becomes stale.
        retry=create(autoRelist=True,relistCount=1,relistReduction=5);fund(retry)
        sql("update khub_bot.market_prices set available=false where item_id=194;")
        finish(retry)
        assert state(retry)['status']=='active' and state(retry)['mr_a_rate']==70000000
        # Competing intake connections keep chronological acceptance and exact refunds.
        sql("update khub_bot.market_prices set available=true,observed_at=now(),checked_at=now() where item_id=194;")
        race=create();fund(race)
        stamp=int(sql("select floor(extract(epoch from now()-interval '2 minutes'))::bigint;"))
        low=payload(race,meat=6000000,q=1,received=stamp)
        high=payload(race,meat=10000000,q=1,sender=48889903,received=stamp)
        stage([low,high])
        def competing(p):
            path=Path(folder)/f'race-{uuid4()}.sql'
            path.write_text('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(p))+');')
            r=subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-f',str(path)],capture_output=True,text=True)
            return r.returncode,r.stdout.strip(),r.stderr
        with ThreadPoolExecutor(max_workers=2) as pool:
            high_future=pool.submit(competing,high)
            low_future=pool.submit(competing,low)
            high_result=high_future.result();low_result=low_future.result()
        assert low_result[0]==0 and low_result[1]=='accepted',low_result
        if high_result[0]:
            assert 'pending bid mail' in high_result[2].lower(),high_result
            assert ingest(high,False)=='accepted'
        else: assert high_result[1]=='accepted',high_result
        assert (state(race)['current_bid'],state(race)['payment_meat'],state(race)['payment_mr_a'])==(80000000,10000000,1)
        assert amounts("receipt_id='"+high['id']+"' and dedupe_key like 'outbid:%'")=={'meat':6000000,'mr_a':1,'lot':0}
        assert sql(f"select count(*) from public.bids where auction_id='{race}';")=='2'
        # Late-discovered older mail enters the existing timing-review hold.
        held_before=liabilities()
        older=payload(race,meat=20000000,q=1,received=stamp-1)
        assert ingest(older)!='accepted'
        assert state(race)['status']=='on_hold' and state(race)['escrow_timing_review']
        assert state(race)['payment_mr_a']==1 and state(race)['payment_meat']==10000000
        held_after=liabilities()
        assert int(held_after['meat'])-int(held_before['meat'])==20000000
        assert int(held_after['items']['194'])-int(held_before['items']['194'])==1
        # Meat-only escrow remains Meat-only and returns unsupported payment items.
        plain=sql("select public.create_auction('seal tooth',1,1000000,24,null,null,2,true);",owner)
        fund(plain)
        invalid=payload(plain,meat=1000000,q=1)
        assert 'Meat only' in ingest(invalid)
        assert amounts("receipt_id='"+invalid['id']+"' and kind='refund'")=={'meat':1000000,'mr_a':1,'lot':0}
        assert ingest(payload(plain,meat=1000000))=='accepted';finish(plain)
        assert state(plain)['current_bid']==1000000
        # No Mr. A business cap: large exact quantities reuse deterministic chunks.
        sql("update khub_bot.market_prices set price_meat=1000,available=true,observed_at=now(),checked_at=now() where item_id=194;")
        large=create(rate=1000);fund(large)
        first=payload(large,meat=0,q=6000000001)
        assert ingest(first)=='accepted'
        higher=payload(large,meat=0,q=7000000001,sender=48889903)
        assert ingest(higher)=='accepted'
        assert amounts("receipt_id='"+higher['id']+"' and dedupe_key like 'outbid:%'")['mr_a']==6000000001
        finish(large)
        assert state(large)['fee_meat']==0
        assert amounts(f"auction_id='{large}' and kind='sale_meat'")['mr_a']==7000000001
        assert sql(f"select max(quantity)<=1000000000 from khub_bot.deliveries where auction_id='{large}';")=='t'
        assert int(sql(f"select count(*) from khub_bot.deliveries where auction_id='{large}' and kind='sale_meat';"))==8
        sql("update khub_bot.market_prices set price_meat=70000000,available=true,observed_at=now(),checked_at=now() where item_id=194;")
        # Exercise the actual delivery claim/ack/recovery RPCs with synthetic outcomes.
        # The seller's Meat and Mr. A obligations are separate, exact liabilities.
        target=sql(f"select id from khub_bot.deliveries where auction_id='{aid}' and kind='sale_meat' and item_id=194;")
        failed=None
        for _ in range(500):
            d=json.loads(sql('set role service_role;select public.bot_claim_delivery_batch(5);') or 'null')
            if d is None: break
            before=liabilities()
            if d['id']==target:
                failed=d
                sql(f"set role service_role;select public.bot_ack_delivery('{d['id']}','{d['attempt']}',false,'Synthetic unknown-send result; no game request was made.');")
                assert liabilities()==before,'Unknown asset send must retain all liabilities'
                assert sql(f"select state from khub_bot.deliveries where id='{target}';")=='unknown'
                sql('set role service_role;select public.bot_claim_delivery_batch(5);',error='uncertain')
                break
            sql(f"set role service_role;select public.bot_ack_delivery('{d['id']}','{d['attempt']}',true,'Synthetic confirmed send; no game request was made.');")
        assert failed is not None,'Target Mr. A obligation was never claimed'
        before=liabilities()
        sql(f"set role service_role;select public.bot_reconcile_delivery('{target}',true,'Synthetic exact Sent evidence confirms this delivery, recipient, reference, Meat and Mr. A quantity.');")
        after=liabilities();assert int(before['items']['194'])-int(after['items']['194'])==2
        sql(f"set role service_role;select public.bot_ack_delivery('{target}','{failed['attempt']}',true,'Synthetic repeated acknowledgment must not release twice.');",error='claim does not match')
        assert liabilities()==after
        # Remaining sibling assets survive a partial result and finish only once.
        for _ in range(500):
            d=json.loads(sql('set role service_role;select public.bot_claim_delivery_batch(5);') or 'null')
            if d is None: break
            sql(f"set role service_role;select public.bot_ack_delivery('{d['id']}','{d['attempt']}',true,'Synthetic confirmed remainder; no game request was made.');")
        assert state(aid)['status']=='completed'
        assert int(sql(f"select count(*) from khub_bot.deliveries where auction_id='{aid}' and state not in ('sent','cancelled');"))==0
        # Known-unsent preparation holds reserve every asset and require explicit release.
        sql("update khub_bot.market_prices set available=true,observed_at=now(),checked_at=now() where item_id=194;")
        prepared=create();fund(prepared);assert ingest(payload(prepared,meat=6000000,q=1))=='accepted';finish(prepared)
        target=sql(f"select id from khub_bot.deliveries where auction_id='{prepared}' and kind='sale_meat' and item_id=194;")
        before=liabilities()
        sql(f"select khub_bot.hold_unprepared_delivery('{target}','fixture','Synthetic known-unsent preparation failure.');")
        assert liabilities()==before
        # Release after a mock preparation correction, never an uncertain-send retry.
        sql(f"set role service_role;select public.bot_retry_held_delivery('{target}','Synthetic preparation corrected; no send was attempted and the original payload is unchanged.');")
        count=int(sql(f"select count(*) from khub_bot.deliveries where auction_id='{prepared}' and kind='sale_meat';"))
        for _ in range(500):
            d=json.loads(sql('set role service_role;select public.bot_claim_delivery_batch(5);') or 'null')
            if d is None: break
            if d['id']==target:
                before=liabilities()
                sql(f"set role service_role;select public.bot_ack_delivery('{target}','{d['attempt']}',false,'Synthetic uncertain attempt; no real send occurred.');")
                sql(f"set role service_role;select public.bot_reconcile_delivery('{target}',false,'Synthetic independent evidence confirms this attempt was not sent; original physical payload stays reserved.');")
                assert liabilities()==before
                again=json.loads(sql('set role service_role;select public.bot_claim_delivery_batch(5);'))
                assert again['id']==target and again['attempt']!=d['attempt']
                assert again.get('quantity')==d.get('quantity') and again.get('meat')==d.get('meat')
                sql(f"set role service_role;select public.bot_ack_delivery('{target}','{again['attempt']}',true,'Synthetic confirmed retry after verified not-sent reconciliation.');")
            else:
                sql(f"set role service_role;select public.bot_ack_delivery('{d['id']}','{d['attempt']}',true,'Synthetic confirmed unrelated delivery.');")
        assert int(sql(f"select count(*) from khub_bot.deliveries where auction_id='{prepared}' and kind='sale_meat';"))==count
        assert state(prepared)['status']=='completed'
        # Operator history and totals must never count Meat-equivalent value as physical Meat.
        history=json.loads(sql("set role service_role;select public.bot_financial_history('sales',0,100);"))
        row=next(r for r in history['records'] if r['auction_id']==aid)
        assert row['payment_meat']=='10000000' and row['payment_mr_a']=='2' and row['seller_proceeds_meat']=='5890000',row
        stats=json.loads(sql('set role service_role;select public.bot_financial_stats();'))['sales']
        expected=json.loads(sql("select jsonb_build_object('meat',sum(coalesce(payment_meat,current_bid)-fee_meat),'mr_a',sum(payment_mr_a),'waived',sum(waived_fee_meat)) from public.auctions where escrow_mode and auction_kind='sell' and status='completed' and highest_bidder_id is not null and current_bid>0;"))
        assert int(stats['seller_proceeds_meat'])==expected['meat'] and int(stats['seller_proceeds_mr_a'])==expected['mr_a']
        assert int(stats['waived_commission_meat'])==expected['waived']
        detail=json.loads(sql(f"set role authenticated;select public.read_auction_detail_static(p_id=>'{discounted}');",owner))['rows'][0]
        assert detail['waived_fee_meat']==1399999 and detail['calculated_fee_meat']==1400000,detail
        sql("update khub_bot.site_trade_totals_snapshot set refreshed_at='-infinity';")
        totals=json.loads(sql('select khub_bot.refresh_site_trade_totals();'))
        units=int(sql("select sum(khub_bot.auction_units(a)+a.payment_mr_a) from public.auctions a where auction_kind='sell' and status='completed' and winner_id is not null and final_price is not null;"))
        assert int(totals['items'])==units,totals
        print('PASS preparation holds, verified not-sent retries and physical-asset financial reports')
        print('PASS partial delivery, unknown reserves, no automatic resend, verified reconciliation and duplicate acknowledgment')
        print('PASS mixed intake, exact refunds, physical reserves, buyouts, commissions, promotions, bundles, retries and compatibility')
    finally:
        if started: pg('-m','immediate','-w','stop')
