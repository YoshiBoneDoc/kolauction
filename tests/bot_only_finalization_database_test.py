"""Bot-only expiration and financial safety against ALL local SQL migrations.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/bot_only_finalization_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-bot-only-expiration-',dir='/tmp') as folder:
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
        # No browser finalization RPC is used anywhere in this scenario.
        direct_empty=create(False,500)
        direct_bid=create(False,500);bid(direct_bid,100)
        escrow_empty=funded()
        escrow_bid=funded()
        buy_order=call("select public.create_buy_auction(2,10,200,24,'finished');",seller)
        funding=int(sql(f"select funding_required from khub_bot.buy_orders where auction_id='{buy_order}';"))
        assert ingest(mail(buy_order,'fund',funding,actor=48889601))=='accepted'
        for ident in [direct_empty,direct_bid,escrow_empty,escrow_bid,buy_order]:
            set_end(ident,"clock_timestamp()-interval '120 seconds'")

        bid(direct_bid,200,error='ended')
        call(f"select public.purchase_auction('{direct_empty}');",error='ended')
        call(f"select public.reserve_buy_quantity('{buy_order}',1);",error='not accepting reservations')
        assert row(direct_bid)['status']=='active' and row(direct_bid)['current_bid']==100
        assert row(direct_empty)['instant_purchased_at'] is None
        assert sql(f"select count(*) from khub_bot.buy_reservations where auction_id='{buy_order}';")=='0'
        print('PASS: delayed finalization cannot admit late direct bids, buyouts or Buy reservations')

        # Timely escrow mail remains valid even when processed after the deadline;
        # a genuinely late receipt is rejected and its entire funded bid refunded.
        deadline=int(sql(f"select floor(extract(epoch from end_time))::bigint from public.auctions where id='{escrow_bid}';"))
        timely=mail(escrow_bid,'bid',200,received=deadline-120)
        stage([timely]);assert ingest(timely)=='accepted'
        late=mail(escrow_empty,'bid',300)
        stage([late]);assert ingest(late)!='accepted'
        assert row(escrow_empty)['current_bid']==0
        assert int(sql(f"select coalesce(sum(meat),0) from khub_bot.deliveries where receipt_id='{late['id']}' and kind='refund';"))==300
        print('PASS: receipt time remains authoritative; a late funded bid is refunded exactly once')

        # Explicitly hold the financial lock in another local connection. Reads
        # must still succeed in a READ ONLY transaction; actual maintenance waits.
        holder=subprocess.Popen([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1',
            '-c','begin;select pg_advisory_xact_lock(3888760);select pg_sleep(4);rollback;'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        import time
        for _ in range(100):
            if sql("select count(*) from pg_locks where locktype='advisory' and classid=0 and objid=3888760 and objsubid=1 and granted;")=='1':break
            assert holder.poll() is None,'Local lock holder exited early'
            time.sleep(0.02)
        else:raise AssertionError('Local financial lock was not acquired')
        before=sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        for view,ident in [('detail',direct_bid),('seller',seller),('profile',None),('browse',None)]:
            identifier=lit(ident) if ident else 'null'
            result=sql(f"begin read only;set local statement_timeout='1000ms';set local role authenticated;select public.read_auction_page('{view}',{identifier},'','all','ending',1);commit;",buyer)
            assert json.loads(result)['privacy_version']==1
        sql("set statement_timeout='300ms';select public.bot_tick();",error='statement timeout')
        holder.communicate(timeout=10);assert holder.returncode==0
        assert before==sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        print('PASS: detail/seller/profile/browse reads neither mutate state nor wait for the global lock; financial maintenance still waits')

        sql('set role service_role;select public.bot_tick();')
        assert row(direct_empty)['status']=='ended_no_bids'
        assert row(direct_bid)['status']=='awaiting_trade' and row(direct_bid)['final_price']==100
        for ident in [escrow_empty,escrow_bid,buy_order]:assert row(ident)['status']=='active'
        print('PASS: bot tick alone closes Direct auctions; escrow and Buy settlement still wait for a completed safe inbox scan')

        scan=stage([])
        sql(f"set role service_role;select public.bot_finish_inbox_scan('{scan}');select public.bot_tick();")
        assert row(escrow_empty)['status']=='settling' and row(escrow_empty)['settlement_outcome']=='ended_no_bids'
        assert row(escrow_bid)['status']=='settling' and row(escrow_bid)['settlement_outcome']=='completed'
        assert row(escrow_bid)['final_price']==200
        assert row(buy_order)['status']=='settling' and row(buy_order)['settlement_outcome']=='expired'
        assert int(sql(f"select sum(meat) from khub_bot.deliveries where auction_id='{buy_order}' and kind='refund';"))==funding
        print('PASS: normal completed scan plus bot tick settles Escrow sell and Buy deadlines and queues the exact unused-funds refund')

        ids_sql=','.join(lit(ident) for ident in [escrow_empty,escrow_bid,buy_order])
        delivery_ids=json.loads(sql(f"select jsonb_agg(id order by id) from khub_bot.deliveries where auction_id in ({ids_sql}) and state='pending';"))
        for delivery_id in delivery_ids:
            attempt=sql(f"update khub_bot.deliveries set state='sending',attempt=gen_random_uuid() where id='{delivery_id}' returning attempt;")
            sql(f"set role service_role;select public.bot_ack_delivery('{delivery_id}','{attempt}',true,'Disposable local test: simulated delivery, no KoL send.');")
        sql('set role service_role;select public.bot_tick();')
        assert row(escrow_empty)['status']=='ended_no_bids'
        assert row(escrow_bid)['status']=='completed'
        assert row(buy_order)['status']=='expired'
        assert row(direct_bid)['status']=='awaiting_trade' # Never fabricate direct-trade completion.
        ledger=sql("select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;")
        for _ in range(3):sql('set role service_role;select public.bot_tick();')
        assert ledger==sql("select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;")
        print('PASS: only delivery acknowledgments complete escrow outcomes; repeated ticks do not duplicate refunds or payouts')

        # Exact high-value scenario: one Nuge crossbow and a 200M funded bid.
        # Everything is synthetic/local; no KoL connection or actual asset send.
        parser_root=ROOT/'bot/src' if (ROOT/'bot/src/mail-parser.mjs').exists() else ROOT/'src'
        parse_script="import {parseKmail} from "+json.dumps((parser_root/'mail-parser.mjs').as_uri())+";import {normalizeMail} from "+json.dumps((parser_root/'protocol.mjs').as_uri())+";let input='';for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify(JSON.parse(input).map(raw=>normalizeMail(raw,parseKmail))));"
        for uncertain in [False,True]:
            high=call('select public.create_auction('+lit("The Nuge's favorite crossbow")+",1,100,24,null,null,7201,true);",seller)
            number=row(high)['auction_number']
            deposit=mail(high,'list',actor=48889601)['raw']
            deposit['message']=f'LIST {number}<center><table class="item" rel="id=7201&n=1&t=1&g=0"><tr><td><img src="/itemimages/nugebow.gif" title="The Nuge crossbow"></td><td>You acquire an item: <b>The Nuge crossbow</b></td></tr></table></center>'
            funded_bid=mail(high,'bid')['raw']
            funded_bid['message']=f'BID {number}<center><table><tr><td><img src="/itemimages/meat.gif"></td><td>You gain 200,000,000 Meat.</td></tr></table></center>'
            parsed=json.loads(subprocess.run(['node','--input-type=module','-e',parse_script],input=json.dumps([deposit,funded_bid]),text=True,capture_output=True,check=True).stdout)
            assert parsed[0]['items']==[{'id':7201,'quantity':1}] and parsed[1]['meat']==200000000
            assert ingest(parsed[0])=='accepted'
            stage([parsed[1]]);assert ingest(parsed[1])=='accepted'
            assert row(high)['current_bid']==200000000 and row(high)['highest_bidder_id']==buyer
            held=json.loads(sql('select public.bot_liabilities();'))
            assert int(held['meat'])>=200000000 and int(held['items']['7201'])>=1
            set_end(high,"clock_timestamp()-interval '120 seconds'")
            close_scan=stage([])
            sql(f"select public.bot_finish_inbox_scan('{close_scan}');select public.bot_tick();")
            settled=row(high)
            assert settled['status']=='settling' and settled['final_price']==200000000
            assert settled['fee_policy']=='tiered_v1' and settled['fee_meat']==5110000
            asset_rows=json.loads(sql(f"select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d where auction_id='{high}' and kind in ('sale_item','sale_meat');"))
            assert len(asset_rows)==2
            winner=[d for d in asset_rows if d['kind']=='sale_item'][0]
            payout=[d for d in asset_rows if d['kind']=='sale_meat'][0]
            assert winner['recipient_id']==48889602 and winner['item_id']==7201 and winner['quantity']==1
            assert payout['recipient_id']==48889601 and payout['meat']==194890000
            assert payout['meat']+settled['fee_meat']==200000000
            frozen_count=sql(f"select count(*) from khub_bot.deliveries where auction_id='{high}';")
            for _ in range(3):sql('select public.bot_tick();')
            assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{high}';")==frozen_count
            uncertain_row=None;seen=set()
            for _ in range(100):
                result=sql('set role service_role;select public.bot_claim_delivery(5);')
                if not result:break
                delivery=json.loads(result)
                assert delivery['id'] not in seen;seen.add(delivery['id'])
                assert delivery['delivery_reference'].startswith('D-')
                if uncertain and delivery['id']==payout['id']:
                    uncertain_row=delivery
                    sql(f"select public.bot_ack_delivery('{delivery['id']}','{delivery['attempt']}',false,'Local simulated lost send acknowledgment; no game transfer.');")
                    result=json.loads(sql(f"select public.bot_record_mailbox_check('{delivery['id']}','{delivery['attempt']}',"+lit(json.dumps({'status':'check_failed','candidate_ids':[]}))+');'))
                    assert result['status']=='isolated'
                else:
                    sql(f"select public.bot_ack_delivery('{delivery['id']}','{delivery['attempt']}',true,'Local simulated confirmed transfer; no game transfer.');")
            else:raise AssertionError('Local delivery queue did not drain')
            assert winner['id'] in seen and payout['id'] in seen
            if uncertain:
                assert uncertain_row and row(high)['status']=='settling'
                assert sql(f"select state from khub_bot.deliveries where id='{payout['id']}';")=='unknown'
                pg('-l',str(Path(folder)/'postgres.log'),'-m','fast','-w','restart')
                assert sql(f"select state from khub_bot.deliveries where id='{payout['id']}';")=='unknown'
                assert sql('select public.bot_claim_delivery(5);')==''
                verified={'status':'verified','candidate_ids':['99900001'],'message_id':'99900001','message_hash':'a'*64}
                sql(f"select public.bot_record_mailbox_check('{payout['id']}','{uncertain_row['attempt']}',"+lit(json.dumps(verified))+');')
            assert row(high)['status']=='completed'
            assert ingest(parsed[0])=='duplicate' and ingest(parsed[1])=='duplicate'
            for _ in range(3):sql('select public.bot_tick();')
            assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{high}';")==frozen_count
            assert int(sql(f"select sum(meat) from khub_bot.closet_transfers where auction_id='{high}' and source='sale_fee';"))==5110000
        print('PASS: 200M Nuge crossbow settlement preserves both assets, pays exact numeric recipients (194,890,000 seller / 5,110,000 fee), claims once, and survives uncertain payout/restart/recovery without resending')
    finally:
        if started:pg('-m','fast','-w','stop')
