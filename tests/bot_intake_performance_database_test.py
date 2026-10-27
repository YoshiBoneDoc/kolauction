"""Phase 3 intake, retention, lock and financial safety against ALL migrations.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/bot_intake_performance_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-intake-performance-',dir='/tmp') as folder:
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
        financial_definitions="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid))
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname in ('public','khub_bot') and p.prokind='f'
              and p.proname in ('bot_ingest_mail','bot_ingest_donation','bot_tick','bot_ack_delivery',
              'bot_claim_delivery','finish_listing','finish_buy_order','reserve_buy_quantity','expire_buy_reservations','bot_mail_cleanup');"""
        for migration in migrations:
            if migration.name.startswith('202610270117'):before_financial=sql(financial_definitions)
            sql(migration.read_text())
        assert before_financial==sql(financial_definitions)
        print('PASS: financial intake, validation, locking, dispatch, settlement and cleanup function definitions unchanged')
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

        from datetime import datetime,timezone
        seller,_=account(89601,48889601,'Receipt Seller')
        buyer,_=account(89602,48889602,'Receipt Buyer')
        other,_=account(89603,48889603,'Receipt Other')
        from concurrent.futures import ThreadPoolExecutor
        from datetime import datetime,timezone
        def call(query,uid=buyer,error=None):return sql('set role authenticated;'+query,uid,error)
        ids=iter(range(99600,99999))
        def stamp(epoch):return datetime.fromtimestamp(epoch,timezone.utc).isoformat()
        def create(escrow=False,buyout=None):
            return call(f"select public.create_auction('seal tooth',1,100,24,null,{buyout or 'null'},2,{'true' if escrow else 'false'});",seller)
        def row(ident):return json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{ident}';"))
        def events(ident):return json.loads(sql(f"select coalesce(jsonb_agg(to_jsonb(e) order by recorded_at,bid_id),'[]') from khub_bot.auction_bid_extensions e where auction_id='{ident}';"))
        def bid(ident,amount,uid=buyer,error=None):return call(f"select public.place_bid('{ident}',{amount});",uid,error)
        def mail(ident,kind,meat=0,quantity=0,actor=48889602,received=None,mid=None):
            if received is None:received=int(sql('select floor(extract(epoch from clock_timestamp()))::bigint;'))
            mid=str(mid or next(ids))
            return {'id':mid,'sender_id':actor,'sender_name':'Timing fixture','received_at':stamp(received),'command':{'type':kind,'auction_id':ident},
                'meat':meat,'items':[{'id':2,'quantity':quantity}] if quantity else [],
                'raw':{'id':mid,'fromid':str(actor),'fromname':'Timing fixture','type':'normal','message':kind.upper()+' '+ident,'azunixtime':str(received)}}
        def ingest(m,error=None):return sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(m))+');',error=error)
        def stage(mails):
            scan=json.loads(sql('select public.bot_begin_inbox_scan();'))['id']
            sql(f"select public.bot_stage_inbox_scan('{scan}',"+lit(json.dumps(mails))+');')
            return scan
        def funded():
            ident=create(True)
            assert ingest(mail(ident,'list',quantity=1,actor=48889601))=='accepted'
            return ident
        def set_end(ident,expr):
            sql(f"update public.auctions set created_at=clock_timestamp()-interval '2 days',end_time={expr},item_escrowed_at=case when escrow_mode then clock_timestamp()-interval '1 day' else item_escrowed_at end where id='{ident}';")
        def handled(mails,role='service_role'):
            return json.loads(sql('begin read only;set local role '+role+';select public.bot_handled_mail('+lit(json.dumps(mails))+');commit;'))
        assert json.loads(sql('select public.bot_inspect();'))['mailReplayOptimizationVersion']==1
        for role in ['anon','authenticated']:
            sql('set role '+role+";select public.bot_handled_mail('[]');",error='permission denied')
        assert handled([])==[]
        sql("select public.bot_handled_mail('{}');",error='Invalid replay manifest')
        print('PASS: replay RPC is read-only, service-role only and validates manifests')

        buy=call("select public.create_buy_auction(2,10,200,24,'finished');",seller)
        funding=int(sql(f"select funding_required from khub_bot.buy_orders where auction_id='{buy}';"))
        fund=mail(buy,'fund',funding,actor=48889601)
        assert handled([fund])==[] and ingest(fund)=='accepted'
        reservation=json.loads(call(f"select public.reserve_buy_quantity('{buy}',2);"))
        fill=mail(buy,'fill',quantity=2)
        fill['command']['reservation_id']=reservation['id']
        scan=stage([fill]);assert ingest(fill)=='accepted'
        # The source mail remains in KoL and payouts remain pending. Intake is
        # committed nevertheless; existing dispatch/recovery owns those debts.
        assert set(handled([fund,fill]))=={fund['id'],fill['id']}
        assert int(sql(f"select count(*) from khub_bot.deliveries where receipt_id='{fill['id']}' and state='pending';"))>0
        before=sql(f"select to_jsonb(o) from khub_bot.buy_orders o where auction_id='{buy}';")
        ledger=sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')
        for _ in range(3):
            assert ingest(fund)=='duplicate' and ingest(fill)=='duplicate'
            assert set(handled([fund,fill]))=={fund['id'],fill['id']}
        assert before==sql(f"select to_jsonb(o) from khub_bot.buy_orders o where auction_id='{buy}';")
        assert ledger==sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')
        changed=dict(fund,meat=funding+1)
        assert handled([changed])==[]
        ingest(changed,error='payload changed')
        print('PASS: actual FUND/FILL duplicates cannot top up twice, repay twice or change obligations; mismatches reach validation')

        rejected=mail(buy,'unknown',meat=50)
        assert ingest(rejected)!='accepted'
        assert handled([rejected])==[rejected['id']]
        refund_count=sql(f"select count(*) from khub_bot.deliveries where receipt_id='{rejected['id']}' and meat=50;")
        assert refund_count=='1' and ingest(rejected)=='duplicate'
        assert sql(f"select count(*) from khub_bot.deliveries where receipt_id='{rejected['id']}' and meat=50;")==refund_count
        assert sql(f"select public.bot_mail_cleanup(array['{rejected['id']}']);")=='[]'
        print('PASS: rejected funded mail keeps one refund obligation and remains subject to the unchanged source-retention policy')

        sql(f"update khub_bot.inbox_bid_mail set processed=false where mail_id='{fill['id']}';")
        assert handled([fill])==[]
        recovery_scan=json.loads(sql('select public.bot_begin_inbox_scan();'))['id']
        recovered=json.loads(sql(f"select public.bot_stage_inbox_scan('{recovery_scan}','[]');"))
        assert any(m['id']==fill['id'] for m in recovered)
        # Complete staging returns the independent pending queue even though
        # source mail is absent. Re-ingestion only repairs the staged flag.
        assert ingest(fill)=='duplicate' and handled([fill])==[fill['id']]
        sql(f"select public.bot_finish_inbox_scan('{recovery_scan}');")
        assert before==sql(f"select to_jsonb(o) from khub_bot.buy_orders o where auction_id='{buy}';")
        print('PASS: unresolved durable mail is never classified away; duplicate recovery repairs staging without another transfer')
        sql(f"update khub_bot.inbox_bid_mail set payload='{{}}' where mail_id='{fill['id']}';")
        assert handled([fill])==[]
        sql(f"update khub_bot.inbox_bid_mail set payload="+lit(json.dumps(fill))+f" where mail_id='{fill['id']}';")
        assert handled([fill])==[fill['id']]

        # Preserve account retries, legacy donation review and unfinished receipts.
        pending_account=mail(buy,'register',actor=48889604)
        job=json.loads(sql('select public.bot_prepare_account_mail('+lit(json.dumps(pending_account))+",'Kh9!AnotherFixturePassword');"))
        assert job['state']=='pending'
        assert handled([pending_account])==[]
        completed_account=json.loads(sql("select payload from khub_bot.receipts where mail_id='89601';"))
        assert handled([completed_account])==[]
        review=mail(buy,'donation',mid='99101')
        processing=mail(buy,'fund',mid='99102')
        for payload,result in [(review,'donation'),(processing,'processing')]:
            sql('insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result) values('+lit(payload['id'])+',48889602,now(),'+lit(json.dumps(payload))+','+lit(result)+');')
        sql("insert into khub_bot.mail_policy_reviews(receipt_id,reason) values('99101','Synthetic review');")
        assert handled([review,processing])==[]
        sql("update khub_bot.mail_policy_reviews set refund_queued=true where receipt_id='99101';")
        assert handled([review])==[] # Keep even completed reviews on their special path.
        print('PASS: pending account jobs, unfinished receipts and historical donation reviews retain their retry paths')

        gift=mail(buy,'fund',mid='99103')
        gift['raw']['gift_original']={'synthetic':'verified gift source'}
        sql("insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result) values('99103',48889602,now(),"+lit(json.dumps(gift))+",'accepted');")
        assert handled([gift])==[]
        sql("insert into khub_bot.incoming_gifts(mail_id,wrapper_id,envelope,payload) values('99103',1167,'{}',"+lit(json.dumps(gift))+');')
        assert handled([gift])==['99103']
        sql("update khub_bot.incoming_gifts set legacy_donation=true where mail_id='99103';")
        assert handled([gift])==[]
        print('PASS: skipping a gift replay requires the existing exact verified gift proof; legacy/unverified gifts keep validation')

        # A failed financial statement rolls back; the next user's known-good
        # request can still commit. Unknown intake is never marked handled.
        failed=mail(buy,'fund',meat=-1)
        failed['id']='bad-id'
        ingest(failed,error='Invalid normalized')
        assert handled([failed])==[]
        next_fund=mail(buy,'fund',100,actor=48889601)
        assert ingest(next_fund)=='accepted' and handled([next_fund])==[next_fund['id']]
        print('PASS: failed intake has no committed receipt; a later unrelated valid request still commits')

        # Financial lock held elsewhere: the optional batch read remains useful
        # and nonblocking, while genuine financial intake must still wait.
        holder=subprocess.Popen([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt',
            '-c','begin;select pg_advisory_xact_lock(3888760);select pg_sleep(3);rollback;'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        import time
        for _ in range(100):
            if sql("select count(*) from pg_locks where locktype='advisory' and objid=3888760 and granted;")=='1':break
            time.sleep(.02)
        else:raise AssertionError('Lock holder not acquired')
        assert set(json.loads(sql("begin read only;set local statement_timeout='500ms';set local role service_role;select public.bot_handled_mail("+lit(json.dumps([fund,fill]))+');commit;')))=={fund['id'],fill['id']}
        sql("set statement_timeout='200ms';select public.bot_ingest_mail("+lit(json.dumps(fund))+');',error='statement timeout')
        holder.communicate(timeout=10);assert holder.returncode==0
        print('PASS: batch read does not acquire the financial advisory lock; financial operations still do')

        # Production-like scan history: volatile per-row clock prevents an index
        # bound. Compare with the same fixed cutoff used by the modified cleanup.
        sql("insert into khub_bot.inbox_scans(started_at,staged_at,completed_at) select now()-interval '1 hour',now(),now() from generate_series(1,20500);")
        old_scan=sql("insert into khub_bot.inbox_scans(started_at) values(now()-interval '8 days') returning id;")
        recent_scan=sql("insert into khub_bot.inbox_scans(started_at) values(now()-interval '6 days') returning id;")
        sql("insert into khub_bot.inbox_bid_mail values('99201','{}',now()-interval '8 days',false),('99202','{}',now()-interval '8 days',true),('99203','{}',now()-interval '6 days',true);")
        sql('analyze khub_bot.inbox_scans;analyze khub_bot.inbox_bid_mail;')
        baseline=json.loads(sql("explain(analyze,format json) select id from khub_bot.inbox_scans where started_at<clock_timestamp()-interval '7 days';"))[0]['Plan']
        fixed=json.loads(sql("explain(analyze,format json) select id from khub_bot.inbox_scans where started_at<statement_timestamp()-interval '7 days';"))[0]['Plan']
        assert baseline['Node Type']=='Seq Scan' and baseline['Rows Removed by Filter']>=20500
        assert 'inbox_scans_retention_idx' in json.dumps(fixed),fixed
        assert fixed['Actual Rows']==1 and fixed.get('Rows Removed by Filter',0)==0
        # Complete scans must still reject unresolved staged mail.
        blocked_scan=stage([])
        sql(f"select public.bot_finish_inbox_scan('{blocked_scan}');",error='Pending bid mail')
        assert sql("select count(*) from khub_bot.inbox_bid_mail where mail_id='99201' and not processed;")=='1'
        sql("update khub_bot.inbox_bid_mail set processed=true where mail_id='99201';")
        sql(f"select public.bot_finish_inbox_scan('{blocked_scan}');")
        assert sql(f"select count(*) from khub_bot.inbox_scans where id='{old_scan}';")=='0'
        assert sql(f"select count(*) from khub_bot.inbox_scans where id='{recent_scan}';")=='1'
        assert sql("select string_agg(mail_id,',' order by mail_id) from khub_bot.inbox_bid_mail where mail_id like '992%';")=='99203'
        assert sql("select count(*) from pg_indexes where schemaname='khub_bot' and indexname in ('deliveries_receipt_state_idx','deliveries_auction_state_idx','inbox_scans_retention_idx','inbox_bid_mail_retention_idx');")=='4'
        print(f"PASS: fixed-cutoff index plan replaces {baseline['Rows Removed by Filter']+baseline['Actual Rows']} heap row visits with {fixed['Actual Rows']} matching row; 7-day retention and pending-mail guard preserved")

        draft=create(True)
        sql(f"update public.auctions set created_at=clock_timestamp()-interval '25 hours' where id='{draft}';")
        sql('set role service_role;select public.bot_tick();')
        assert row(draft)['status']=='expired' and row(draft)['closure_reason']=='deposit_expired'
        print('PASS: ordinary bot tick still expires unfunded drafts without needing duplicate ingestion as a maintenance trigger')

        # Asset-free synthetic notifications demonstrate that neither lookup
        # needs to scan unrelated delivery history. These are never dispatched.
        sql("insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message) select 'phase3-fixture:'||n,48889602,'notice','Synthetic index fixture' from generate_series(1,10000) n;analyze khub_bot.deliveries;")
        for predicate,index in [(f"receipt_id='{fill['id']}'",'deliveries_receipt_state_idx'),(f"auction_id='{buy}'",'deliveries_auction_state_idx')]:
            plan=json.loads(sql('explain(analyze,format json) select id from khub_bot.deliveries where '+predicate+" and state not in ('sent','cancelled');"))[0]['Plan']
            assert index in json.dumps(plan),plan
        print('PASS: receipt/state and auction/state lookup plans use their targeted partial indexes against 10,000 unrelated notifications')
    finally:
        if started:pg('-m','fast','-w','stop')
