"""Gift commission accounting, preparation deferral, lightweight status and durable recovery.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/bot_resilience_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-bot-resilience-',dir='/tmp') as folder:
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
        upgrade=next((p for p in migrations if p.name.startswith('202610280127_')),None)
        for migration in migrations:
            if migration!=upgrade:sql(migration.read_text())
        catalog_path=ROOT/'src/data/items.json'
        if not catalog_path.exists():catalog_path=ROOT/'catalog/items.json'
        catalog=json.loads(catalog_path.read_text())
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
        owner=account(99001,48889901,'Gift Owner')
        buyer=account(99002,48889902,'Gift Buyer')
        sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp();")
        sql("insert into khub_bot.gift_mail_reviews(mail_id,raw,evidence) values('99003','{\"id\":\"99003\",\"type\":\"giftshop\"}','Synthetic unresolved package; retain all unidentified contents.');")
        sql("update khub_bot.gift_asset_protection set safe_operating_meat=5350,operating_reserve=1000 where id;")
        payouts=[456066,238,106,9500];fees=[24003,12,5,500]
        auctions=[]
        for i,(payout,fee) in enumerate(zip(payouts,fees)):
            ident=str(uuid4());auctions.append(ident)
            sql(f"""insert into public.auctions(id,seller_id,seller_username,item,item_id,quantity,min_bid_meat,current_bid,duration_hours,
                created_at,end_time,status,escrow_mode,seller_kol_id,item_escrowed_at,winner_id,winner_username,highest_bidder_id,final_price,finalized_at,settlement_outcome,fee_meat)
                values('{ident}','{owner}','Gift Owner','Settling fixture {i}',2,500,1,{payout+fee},24,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 minute',
                    'settling',true,48889901,clock_timestamp()-interval '1 day','{buyer}','Gift Buyer','{buyer}',{payout+fee},clock_timestamp(),'completed',{fee});
                insert into khub_bot.deliveries(dedupe_key,recipient_id,auction_id,kind,meat,message,display_message)
                values('fixture-payout-{i}',48889901,'{ident}','sale_meat',{payout},'Fixture payout','Fixture payout');
                insert into khub_bot.deliveries(dedupe_key,recipient_id,auction_id,kind,meat,item_id,quantity,message,display_message)
                values('fixture-item-{i}',48889902,'{ident}','sale_item',0,2,500,'Fixture items','Fixture items');
            """)
        refunds=[]
        for i in [1,2]:
            refunds.append(sql(f"insert into khub_bot.deliveries(dedupe_key,recipient_id,auction_id,kind,meat,message,display_message) values('fixture-refund-{i}',3442039,'{auctions[i]}','refund',11,'Fixture refund','Fixture refund') returning id;"))
        sql(f"""insert into public.auctions(seller_id,seller_username,item,item_id,quantity,min_bid_meat,current_bid,duration_hours,created_at,end_time,status,escrow_mode,seller_kol_id,item_escrowed_at)
            values('{owner}','Gift Owner','Other funded obligations',2,1,1,145047092,24,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day','active',true,48889901,clock_timestamp()-interval '1 day');""")
        snapshot={'meat':'145543894','items':{'2':'2001'},'reserve':1000}
        base_book=json.loads(sql('select khub_bot.liabilities_before_gift_isolation();'))
        assert base_book['meat']=='145513024',base_book
        before_hold=json.loads(sql('select public.bot_refresh_gift_protection('+lit(json.dumps(snapshot))+');'))
        before_wrap=json.loads(sql('select public.bot_gift_wrapping_liabilities();'))
        assert before_hold['meat']=='24520'
        assert before_wrap['meat']=='145562064' and int(snapshot['meat'])<int(before_wrap['meat'])+1050
        print('REPRODUCED: full pre-fix SQL produces the exact incident inventory/liability values and 19,220 Meat solvency deficit')
        if upgrade is None:raise SystemExit('Reproduction complete; add migration 127 before the post-fix checks.')
        sql(upgrade.read_text());sql(upgrade.read_text())
        held=json.loads(sql('select public.bot_refresh_gift_protection('+lit(json.dumps(snapshot))+');'))
        wrapping=json.loads(sql('select public.bot_gift_wrapping_liabilities();'))
        assert held['meat']=='0' and wrapping['meat']=='145537544'
        assert int(snapshot['meat'])>=int(wrapping['meat'])+1050
        print('PASS: migration rerun safe; commissions protected exactly once, operating quota and reserve preserved')
        def call(name,*args,error=None,role='service_role'):
            values=','.join(lit(json.dumps(a))+'::jsonb' if isinstance(a,(dict,list)) else 'null' if a is None else lit(str(a)) for a in args)
            return sql(f'set role {role};select public.{name}({values});',error=error)
        def held(snap):return json.loads(call('bot_refresh_gift_protection',snap))
        # Incoming opening claims must not treat these commissions as bot cash.
        envelope={'id':'99004','wrapper_id':1167,'opened':False,'raw':{'id':'99004','fromid':'48889902','fromname':'Gift Buyer','type':'giftshop','message':'DONATE','azunixtime':'1793160000'}}
        call('bot_register_gift_mail',[envelope])
        opening_snapshot={**snapshot,'items':{**snapshot['items'],'1167':'1'}}
        opening=json.loads(call('bot_claim_gift_open',opening_snapshot))
        assert opening['before_state']['safe_operating_meat']==5350
        call('bot_resolve_gift_not_opened',opening['id'],'Synthetic original KMail remains unopened and inventory is unchanged; no game request was made.')
        # Unknown surplus is still quarantined; correcting commissions cannot
        # turn an unrelated unidentified gift into spendable bot cash.
        unknown={**snapshot,'meat':str(int(snapshot['meat'])+777),'items':{'2':'2001','908':'3'}}
        assert held(unknown)=={'meat':'777','items':{'908':'3'}}
        bad={**snapshot,'meat':str(int(base_book['meat'])+sum(fees)-1)}
        assert held(bad)['meat']=='0'
        assert int(json.loads(call('bot_gift_wrapping_liabilities'))['meat'])+1050>int(bad['meat'])
        held(unknown)
        # Reserve wrapping, then prove the HTTP gift request was never attempted.
        sql(f"update khub_bot.deliveries set created_at='2000-01-01' where id='{refunds[0]}';update khub_bot.deliveries set created_at='2001-01-01' where id='{refunds[1]}';")
        first=json.loads(call('bot_claim_delivery',5));assert first['id']==refunds[0]
        call('bot_authorize_safe_gift_wrapping',first['id'],first['attempt'])
        assert sql('select safe_operating_meat from khub_bot.gift_asset_protection;')=='5300'
        proof={'outcome':'not_attempted','stage':'wrapping_solvency'}
        call('bot_defer_unattempted_gift',first['id'],first['attempt'],proof)
        call('bot_defer_unattempted_gift',first['id'],first['attempt'],proof) # Lost acknowledgment replay.
        assert sql('select safe_operating_meat from khub_bot.gift_asset_protection;')=='5350'
        assert sql(f"select state from khub_bot.deliveries where id='{first['id']}';")=='pending'
        assert sql('select count(*) from khub_bot.gift_preparation_deferrals;')=='1'
        assert json.loads(call('bot_inspect'))['giftPreparationWaits'][0]['failures']==1
        assert held(unknown)=={'meat':'777','items':{'908':'3'}}
        second=json.loads(call('bot_claim_delivery',5));assert second['id']==refunds[1]
        call('bot_ack_delivery',second['id'],second['attempt'],True,'Synthetic confirmed refund; no game transfer.')
        pg('-l',str(Path(folder)/'postgres.log'),'-m','fast','-w','restart')
        assert sql('select count(*) from khub_bot.gift_preparation_deferrals;')=='1'
        sql(f"update khub_bot.gift_delivery_waits set retry_after=clock_timestamp()-interval '1 second' where delivery_id='{first['id']}';")
        retry=json.loads(call('bot_claim_delivery',5));assert retry['id']==first['id'] and retry['attempt']!=first['attempt']
        call('bot_defer_unattempted_gift',retry['id'],retry['attempt'],proof)
        assert sql('select failures from khub_bot.gift_delivery_waits;')=='2'
        wait_seconds=float(sql('select extract(epoch from retry_after-clock_timestamp()) from khub_bot.gift_delivery_waits;'))
        assert 110<wait_seconds<=120
        sql(f"update khub_bot.gift_delivery_waits set retry_after=clock_timestamp()-interval '1 second' where delivery_id='{first['id']}';")
        retry=json.loads(call('bot_claim_delivery',5))
        call('bot_ack_delivery',retry['id'],retry['attempt'],True,'Synthetic confirmed refund after safe retry; no game transfer.')
        assert sql('select count(*) from khub_bot.gift_delivery_waits;')=='0'
        assert json.loads(call('bot_inspect'))['giftPreparationWaits']==[]
        print('PASS: known non-attempt retains liabilities, releases wrapping exactly once, backs off durably across restart, and does not starve other refunds')
        # Genuinely uncertain sends still cannot use the known-non-attempt API.
        uncertain=json.loads(call('bot_claim_delivery',5))
        call('bot_ack_delivery',uncertain['id'],uncertain['attempt'],False,'Synthetic lost game send acknowledgment; do not resend.')
        call('bot_defer_unattempted_gift',uncertain['id'],uncertain['attempt'],proof,error='claim changed')
        isolation=json.loads(call('bot_record_mailbox_check',uncertain['id'],uncertain['attempt'],{'status':'check_failed','candidate_ids':[]}))
        assert isolation['status']=='isolated'
        status=json.loads(call('bot_worker_status'))
        assert uncertain['id'] in [r['id'] for r in status['attention']]
        assert uncertain['id'] in [r['id'] for r in status['isolatedDeliveryAttention']]
        assert not any(k in status for k in ['receipts','deliveryCounts','pendingDeliveryChecks'])
        full=json.loads(call('bot_inspect'))
        for flag in ['incomingGiftsVersion','giftIsolationVersion','closetIsolationVersion','mailboxRecoveryEnabled','receiptTimeBiddingVersion','buyDeliveryBatchingVersion','mailReplayOptimizationVersion']:
            assert status[flag]==full[flag],flag
        for role in ['anon','authenticated']:
            call('bot_worker_status',role=role,error='permission denied')
            call('bot_defer_unattempted_gift',first['id'],first['attempt'],proof,role=role,error='permission denied')
        body=sql("select prosrc from pg_proc where oid='public.bot_worker_status()'::regprocedure;")
        assert 'bot_inspect' not in body and 'delivery_details' not in body and 'count(*)' not in body
        print('PASS: lightweight worker status preserves every coordination flag/isolation and role guard without running full inspection')
        # Complete the simulated unknown using explicit LOCAL evidence, and all
        # remaining payout/item obligations, then verify commission handoff.
        call('bot_reconcile_delivery',uncertain['id'],True,'Synthetic local Sent Mail match verified for this test; no real transfer.')
        sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where state='pending';select public.bot_tick();")
        assert int(sql("select sum(meat) from khub_bot.closet_transfers where source='sale_fee';"))==sum(fees)
        assert sql('select khub_bot.unqueued_sell_commission_meat();')=='0'
        def balanced_snapshot():
            b=json.loads(sql('select khub_bot.liabilities_before_gift_isolation();'))
            c=int(sql("select coalesce(sum(meat),0) from khub_bot.closet_transfers where state in ('pending','moving','unknown');"))
            quota=int(sql('select safe_operating_meat from khub_bot.gift_asset_protection;'))
            return {'meat':str(int(b['meat'])+c+quota+1000+777),'items':{**b['items'],'908':'3'},'reserve':1000}
        assert held(balanced_snapshot())=={'meat':'777','items':{'908':'3'}}
        sql("update khub_bot.closet_transfers set state='moved',moved_at=clock_timestamp();")
        assert held(balanced_snapshot())=={'meat':'777','items':{'908':'3'}}
        pg('-l',str(Path(folder)/'postgres.log'),'-m','fast','-w','restart')
        assert held(balanced_snapshot())=={'meat':'777','items':{'908':'3'}}
        print('PASS: simultaneous settlements move every exact commission once to the closet ledger; unknown Meat/items remain protected through restart')
        # Real Buy FUND/reservation/FILL/batch preparation, followed by a known
        # non-attempt, must retain its original packaging rules and exact budget.
        buy_id=sql("set role authenticated;select public.create_buy_auction(2,2,200,24,'immediate');",owner)
        funding=int(sql(f"select funding_required from khub_bot.buy_orders where auction_id='{buy_id}';"))
        def normal(mid,kind,actor,amount=0,items=None,reservation=None):
            stamp=json.loads(sql("select jsonb_build_object('received_at',date_trunc('second',t),'epoch',floor(extract(epoch from t))::bigint) from (select clock_timestamp() t) clock;"))
            command={'type':kind,'auction_id':buy_id}
            if reservation:command['reservation_id']=reservation
            return {'id':str(mid),'sender_id':actor,'sender_name':'Buy fixture','received_at':stamp['received_at'],'command':command,'meat':amount,'items':items or [],
                'raw':{'id':str(mid),'type':'normal','fromid':str(actor),'fromname':'Buy fixture','message':kind.upper()+' '+buy_id,'azunixtime':str(stamp['epoch'])}}
        fund=normal(99010,'fund',48889901,funding)
        assert call('bot_ingest_mail',fund)=='accepted'
        reservation=json.loads(sql(f"set role authenticated;select public.reserve_buy_quantity('{buy_id}',2);",buyer))
        fill=normal(99011,'fill',48889902,items=[{'id':2,'quantity':2}],reservation=reservation['id'])
        scan=json.loads(call('bot_begin_inbox_scan'))
        call('bot_stage_inbox_scan',scan['id'],[fill]);assert call('bot_ingest_mail',fill)=='accepted'
        call('bot_prepare_buy_delivery',buy_id,True)
        item_delivery=json.loads(sql(f"select to_jsonb(d) from khub_bot.deliveries d where auction_id='{buy_id}' and kind='sale_item' and state='pending' order by created_at desc limit 1;"))
        # Simulate a claim at the preparation boundary; there is no game send.
        item_delivery=json.loads(sql(f"update khub_bot.deliveries set state='sending',attempt=gen_random_uuid() where id='{item_delivery['id']}' returning to_jsonb(deliveries);"))
        assert json.loads(call('bot_charge_buy_gift',item_delivery['id'],item_delivery['attempt']))['authorized']
        quota=sql('select safe_operating_meat from khub_bot.gift_asset_protection;')
        call('bot_authorize_safe_gift_wrapping',item_delivery['id'],item_delivery['attempt'])
        budget_before=sql(f"select to_jsonb(o) from khub_bot.buy_orders o where auction_id='{buy_id}';")
        buy_proof={'outcome':'not_attempted','stage':'buy_wrapping_budget'}
        call('bot_defer_unattempted_gift',item_delivery['id'],item_delivery['attempt'],buy_proof)
        call('bot_defer_unattempted_gift',item_delivery['id'],item_delivery['attempt'],buy_proof)
        assert sql('select safe_operating_meat from khub_bot.gift_asset_protection;')==quota
        assert sql(f"select state from khub_bot.deliveries where id='{item_delivery['id']}';")=='pending'
        assert sql(f"select count(*) from khub_bot.buy_delivery_waits where delivery_id='{item_delivery['id']}';")=='1'
        assert sql(f"select to_jsonb(o) from khub_bot.buy_orders o where auction_id='{buy_id}';")==budget_before
        print('PASS: actual Buy funding/fulfillment/batch preparation defers idempotently, preserving buyer budgets and kHub wrapping funds')
        # Historical sent mail must not affect routine worker status or expose
        # credential message bodies, even when a credential send is uncertain.
        sql("""insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,meat,message,display_message,state,sent_at)
            select 'resilience-history-'||n,48889901,'notice',0,'Synthetic historical notice','Synthetic historical notice','sent',clock_timestamp() from generate_series(1,10000) n;
            insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,meat,message,display_message,state,attempt)
            values('account-credentials:resilience-fixture',48889901,'notice',0,'fixture-private-password','fixture-private-password','unknown',gen_random_uuid());
            analyze khub_bot.deliveries;""")
        status=call('bot_worker_status');assert 'fixture-private-password' not in status and len(status)<2000
        plan=json.loads(sql("explain(analyze,format json) select id from khub_bot.deliveries where state in ('sending','unknown');"))[0]
        def walk(n):
            yield n
            for child in n.get('Plans',[]):yield from walk(child)
        assert any(n.get('Index Name')=='deliveries_uncertain_worker_idx' for n in walk(plan['Plan']))
        inspect_definition=sql("select pg_get_functiondef('public.bot_inspect()'::regprocedure);")
        sql("create or replace function public.bot_inspect() returns jsonb language plpgsql security definer set search_path='' as $$begin raise exception 'Full inspection deliberately disabled in local test';end;$$;")
        assert json.loads(call('bot_worker_status'))['attention']
        sql(inspect_definition)
        import time
        lock=subprocess.Popen([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-c',"begin;select pg_advisory_xact_lock(3888760);select pg_sleep(3);commit;"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            time.sleep(.3)
            sql("set statement_timeout='1s';set role service_role;select public.bot_worker_status();")
        finally:lock.communicate(timeout=10)
        print('PASS: status excludes credentials/history, uses the uncertain-row index with 10,000 sent notices, and does not wait on the financial lock or full inspection')


    finally:
        if started:pg('-m','fast','-w','stop')
