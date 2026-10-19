"""Exercise actual PostgreSQL functions, RLS, concurrency, and persistence.
Uses an isolated temporary database with a minimal Supabase Auth stub.
Run: python3 tests/database_test.py (requires PostgreSQL binaries).
"""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BINDIR = Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip())
SELLER = '00000000-0000-0000-0000-000000000001'
BUYER = '00000000-0000-0000-0000-000000000002'
OTHER = '00000000-0000-0000-0000-000000000003'

with tempfile.TemporaryDirectory(prefix='kolauction-db-', dir='/tmp') as directory:
    data = Path(directory) / 'data'
    def pg_ctl(*args):
        return subprocess.run([str(BINDIR / 'pg_ctl'), '-D', str(data), *args],
                              check=True, capture_output=True, text=True)
    subprocess.run([str(BINDIR / 'initdb'), '-D', str(data), '-A', 'trust', '--no-locale'],
                   check=True, capture_output=True, text=True)
    started = False
    try:
        pg_ctl('-l', str(Path(directory) / 'postgres.log'), '-o', f"-F -h '' -k {directory}", '-w', 'start')
        started = True
        def sql(query, user=None, role=None, error=None):
            prefix = ''
            if role:
                prefix += f'set role {role};'
            if user:
                prefix += f"set request.jwt.claim.sub = '{user}';"
            result = subprocess.run([
                str(BINDIR / 'psql'), '-h', directory, '-d', 'postgres', '-X', '-qAt',
                '-v', 'ON_ERROR_STOP=1', '-c', prefix + query,
            ], capture_output=True, text=True)
            if error:
                assert result.returncode != 0 and error.lower() in result.stderr.lower(), result.stderr
            else:
                assert result.returncode == 0, result.stderr
            return result.stdout.strip()

        sql('''
            create role anon;
            create role authenticated;
            create role service_role bypassrls;
            create schema auth;
            create table auth.users (id uuid primary key, raw_user_meta_data jsonb, email text, email_confirmed_at timestamptz);
            create function auth.uid() returns uuid language sql stable as
                $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
            grant usage on schema public, auth to anon, authenticated, service_role;
            grant execute on function auth.uid() to anon, authenticated;
        ''')
        for name in ['202610180001_create_profiles.sql', '202610180002_create_auctions_and_bids.sql']:
            sql((ROOT / 'supabase' / 'migrations' / name).read_text())
        for uid, name in [(SELLER, 'Seller'), (BUYER, 'Buyer'), (OTHER, 'Other')]:
            metadata = json.dumps({'khub_username': name})
            sql(f"insert into auth.users (id, raw_user_meta_data, email) values ('{uid}', '{metadata}', '{name.lower()}@example.com');")

        sql((ROOT / 'supabase/migrations/202610190002_registration_conflicts.sql').read_text())
        # Both confirmed and unconfirmed accounts reserve their email addresses.
        sql(f"update auth.users set email_confirmed_at=now() where id='{SELLER}';")
        for role in ['anon', 'authenticated']:
            result = json.loads(sql("select public.registration_conflicts(' sElLeR ', ' SELLER@EXAMPLE.COM ');", role=role))
            assert result == {'username_taken': True, 'email_taken': True}
            assert json.loads(sql("select public.registration_conflicts('NewName', 'buyer@example.com');", role=role)) == {'username_taken': False, 'email_taken': True}
            assert json.loads(sql("select public.registration_conflicts('Seller', 'new@example.com');", role=role)) == {'username_taken': True, 'email_taken': False}
            assert json.loads(sql("select public.registration_conflicts('NewName', 'new@example.com');", role=role)) == {'username_taken': False, 'email_taken': False}
        sql("select public.registration_conflicts('', 'x@y.com');", role='anon', error='valid username')
        sql("insert into auth.users (id, raw_user_meta_data, email) values ('00000000-0000-0000-0000-000000000004', '{\"khub_username\":\"sELLeR\"}', 'fresh@example.com');", error='duplicate key')
        assert sql('select count(*) from auth.users;') == '3'

        create = "select public.create_auction('test item', 5000000000, 100, 24, null);"
        auction = sql(create, SELLER, 'authenticated')
        assert len(auction) == 36
        assert sql('select count(*) from public.auctions;', role='anon') == '1'
        sql('select * from public.profiles;', role='anon', error='permission denied')
        assert sql('select khub_username from public.profiles;', BUYER, 'authenticated') == 'Buyer'
        sql(create, role='anon', error='permission denied')
        sql(create, role='authenticated', error='log in')
        sql("select public.create_auction('item', 0, 100, 24, null);", SELLER, 'authenticated', error='check constraint')
        sql("select public.create_auction('item', 1, 100, 7, null);", SELLER, 'authenticated', error='valid auction duration')
        sql(f"update public.auctions set current_bid=1 where id='{auction}';", BUYER, 'authenticated', error='permission denied')
        sql(f"delete from public.auctions where id='{auction}';", SELLER, 'authenticated', error='permission denied')
        sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values ('{auction}','{SELLER}','Spoof',100);", BUYER, 'authenticated', error='permission denied')
        def bid(amount):
            return f"select public.place_bid('{auction}', {amount});"
        sql(bid(100), SELLER, 'authenticated', error='own auction')
        sql(bid(99), BUYER, 'authenticated', error='minimum')
        sql(bid(20000000001), BUYER, 'authenticated', error='20 billion')
        sql(bid('null'), BUYER, 'authenticated', error='20 billion')
        sql(bid(100), BUYER, 'authenticated')
        sql(bid(110), BUYER, 'authenticated', error='already the highest')
        sql(bid(100), OTHER, 'authenticated', error='exceed the current')
        sql(bid(110), OTHER, 'authenticated')

        # Race the same amount from different bidders; only one may commit.
        race = sql(create, SELLER, 'authenticated')
        def race_bid(uid):
            try:
                sql(f"select public.place_bid('{race}', 200);", uid, 'authenticated')
                return True
            except AssertionError as failure:
                assert 'exceed the current' in str(failure), str(failure)
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(race_bid, [BUYER, OTHER])) == [False, True]
        assert sql(f"select count(*) from public.bids where auction_id='{race}';") == '1'
        assert sql(f"select current_bid from public.auctions where id='{race}';") == '200'

        sql(f"update public.auctions set created_at=clock_timestamp()-interval '2 days', end_time=clock_timestamp()-interval '1 day' where id='{race}';")
        sql(f"select public.place_bid('{race}', 300);", BUYER, 'authenticated', error='ended')
        sql("update public.profiles set khub_username='Renamed' where id='" + BUYER + "';", BUYER, 'authenticated')
        assert sql(f"select count(*) from public.bids where bidder_id='{BUYER}';", role='anon') != '0'
        # Upgrade a database that already has live and expired auctions/bids.
        previous_winner = sql(f"select bidder_username from public.bids where auction_id='{race}' order by amount desc limit 1;")
        sql((ROOT / 'supabase/migrations/202610190001_auction_lifecycle.sql').read_text())
        assert sql(f"select status from public.auctions where id='{race}';") == 'awaiting_trade'
        assert sql(f"select winner_username from public.auctions where id='{race}';") == previous_winner
        sql(f"select public.finalize_auction('{race}');", BUYER, 'authenticated', error='permission denied')
        sql('select public.finalize_expired_auctions();', role='anon')

        def expire(auction_id):
            sql(f"update public.auctions set created_at=clock_timestamp()-interval '2 days', end_time=clock_timestamp()-interval '1 day' where id='{auction_id}';")

        cancelled = sql(create, SELLER, 'authenticated')
        sql(f"select public.cancel_auction('{cancelled}');", BUYER, 'authenticated', error='Only the seller')
        sql(f"select public.cancel_auction('{cancelled}');", role='anon', error='permission denied')
        sql(f"select public.cancel_auction('{cancelled}');", SELLER, 'authenticated')
        sql(f"select public.cancel_auction('{cancelled}');", SELLER, 'authenticated')
        assert sql(f"select status from public.auctions where id='{cancelled}';") == 'cancelled'
        sql(f"select public.place_bid('{cancelled}',100);", BUYER, 'authenticated', error='cancelled')
        sql(f"update public.auctions set status='active' where id='{cancelled}';", SELLER, 'authenticated', error='permission denied')

        unsold = sql(create, SELLER, 'authenticated')
        expire(unsold)
        sql('select public.finalize_expired_auctions();', role='anon')
        assert sql(f"select status || ':' || (winner_id is null)::text || ':' || (final_price is null)::text from public.auctions where id='{unsold}';") == 'ended_no_bids:true:true'
        sql(f"select public.confirm_auction_trade('{unsold}');", SELLER, 'authenticated', error='winning bid')
        sql(f"select public.cancel_auction('{unsold}');", SELLER, 'authenticated', error='already ended')

        sold = sql(create, SELLER, 'authenticated')
        sql(f"select public.place_bid('{sold}',100);", BUYER, 'authenticated')
        sql(f"select public.cancel_auction('{sold}');", SELLER, 'authenticated', error='with bids')
        sql(f"select public.confirm_auction_trade('{sold}');", SELLER, 'authenticated', error='ended auction')
        expire(sold)
        sql(f"select public.confirm_auction_trade('{sold}');", role='anon', error='permission denied')
        sql(f"select public.confirm_auction_trade('{sold}');", OTHER, 'authenticated', error='Only the seller and winning bidder')
        sql(f"select public.confirm_auction_trade('{sold}');", SELLER, 'authenticated')
        assert sql(f"select status from public.auctions where id='{sold}';") == 'awaiting_trade'
        assert sql(f"select winner_id::text || ':' || winner_username || ':' || final_price from public.auctions where id='{sold}';") == BUYER + ':Renamed:100'
        seller_confirmation = sql(f"select seller_confirmed_at from public.auctions where id='{sold}';")
        sql(f"select public.confirm_auction_trade('{sold}');", SELLER, 'authenticated')
        assert sql(f"select seller_confirmed_at from public.auctions where id='{sold}';") == seller_confirmation
        sql(f"select public.confirm_auction_trade('{sold}');", BUYER, 'authenticated')
        assert sql(f"select status || ':' || (completed_at is not null)::text from public.auctions where id='{sold}';") == 'completed:true'
        completed_time = sql(f"select completed_at from public.auctions where id='{sold}';")
        sql(f"select public.confirm_auction_trade('{sold}');", BUYER, 'authenticated')
        assert sql(f"select completed_at from public.auctions where id='{sold}';") == completed_time
        sql(f"select public.confirm_auction_trade('{sold}');", OTHER, 'authenticated', error='Only the seller')
        sql(f"select public.place_bid('{sold}',200);", OTHER, 'authenticated', error='ended')
        assert sql(f"select count(*) from public.bids where auction_id='{sold}';") == '1'

        # A first bid and seller cancellation must not both succeed.
        contested = sql(create, SELLER, 'authenticated')
        def competing_action(action):
            if action == 'cancel':
                statement = f"select public.cancel_auction('{contested}');"
                uid = SELLER
            else:
                statement = f"select public.place_bid('{contested}',100);"
                uid = BUYER
            try:
                sql(statement, uid, 'authenticated')
                return True
            except AssertionError as failure:
                assert 'with bids' in str(failure) or 'cancelled' in str(failure), str(failure)
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(competing_action, ['cancel', 'bid'])) == [False, True]
        assert sql(f"select (status = 'cancelled' and current_bid = 0) or (status = 'active' and current_bid = 100) from public.auctions where id='{contested}';") == 't'

        # Simultaneous confirmations produce exactly one completed result.
        both = sql(create, SELLER, 'authenticated')
        sql(f"select public.place_bid('{both}',100);", BUYER, 'authenticated')
        expire(both)
        def confirm(uid):
            return sql(f"select public.confirm_auction_trade('{both}');", uid, 'authenticated')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(confirm, [SELLER, BUYER]))
        assert sql(f"select status from public.auctions where id='{both}';") == 'completed'

        # Upgrade a database with existing auction outcomes and bids.
        sql((ROOT / 'supabase/migrations/202610190003_instant_purchase.sql').read_text())
        assert sql('select count(*) from public.auctions where instant_purchase_price is not null;') == '0'
        assert sql("select count(*) from pg_proc where proname='create_auction' and pronamespace='public'::regnamespace;") == '1'
        legacy = sql(create, SELLER, 'authenticated')
        assert sql(f"select instant_purchase_price is null from public.auctions where id='{legacy}';") == 't'

        def instant_create(price=1000):
            return sql(f"select public.create_auction('instant item', 2, 100, 24, null, {price});", SELLER, 'authenticated')

        def purchase(listing_id, uid=BUYER, role='authenticated', error=None):
            return sql(f"select public.purchase_auction('{listing_id}');", uid, role, error=error)

        for price in ['0', '99', '-1', '20000000001']:
            sql(f"select public.create_auction('instant item', 1, 100, 24, null, {price});", SELLER, 'authenticated', error='instant purchase price')
        boundary = instant_create(20000000000)
        assert sql(f"select instant_purchase_price from public.auctions where id='{boundary}';") == '20000000000'
        minimum_price = instant_create(100)
        purchase(minimum_price)
        assert sql(f"select final_price from public.auctions where id='{minimum_price}';") == '100'
        purchase(legacy, error='no instant purchase price')
        sql("select public.create_auction('item',1,100,24,null,1000);", role='anon', error='permission denied')
        instant = instant_create()
        purchase(instant, SELLER, error='own auction')
        purchase(instant, uid=None, role='anon', error='permission denied')
        purchase(instant, uid=None, error='log in')
        sql(f"update public.auctions set instant_purchase_price=1 where id='{instant}';", BUYER, 'authenticated', error='permission denied')
        sql(f"select public.place_bid('{instant}',200);", BUYER, 'authenticated')
        # The current highest bidder can choose to end bidding at the offer.
        purchase(instant)
        assert sql(f"select status || ':' || final_price || ':' || current_bid || ':' || (instant_purchased_at is not null)::text from public.auctions where id='{instant}';") == 'awaiting_trade:1000:1000:true'
        assert sql(f"select winner_id::text || ':' || winner_username from public.auctions where id='{instant}';") == BUYER + ':Renamed'
        recorded = sql(f"select row_to_json(a) from public.auctions a where id='{instant}';")
        purchase(instant)
        assert sql(f"select row_to_json(a) from public.auctions a where id='{instant}';") == recorded
        assert sql(f"select count(*) from public.bids where auction_id='{instant}';") == '2'
        purchase(instant, OTHER, error='ended')
        sql(f"select public.place_bid('{instant}',1500);", OTHER, 'authenticated', error='ended')
        sql(f"select public.cancel_auction('{instant}');", SELLER, 'authenticated', error='already ended')
        sql('select public.finalize_expired_auctions();', role='anon')
        assert sql(f"select row_to_json(a) from public.auctions a where id='{instant}';") == recorded
        for uid in [SELLER, BUYER]:
            sql(f"select public.confirm_auction_trade('{instant}');", uid, 'authenticated')
        assert sql(f"select status from public.auctions where id='{instant}';") == 'completed'
        purchase(instant)  # Also idempotent after the trade completes.
        assert sql(f"select count(*) from public.bids where auction_id='{instant}';") == '2'

        # API callers bidding at/above the offer never pay above the set price.
        for amount in [1000, 1500, 20000000000]:
            threshold = instant_create()
            sql(f"select public.place_bid('{threshold}',{amount});", BUYER, 'authenticated')
            assert sql(f"select status || ':' || final_price || ':' || (instant_purchased_at is not null)::text from public.auctions where id='{threshold}';") == 'awaiting_trade:1000:true'
            assert sql(f"select amount from public.bids where auction_id='{threshold}';") == '1000'

        expired_instant = instant_create()
        expire(expired_instant)
        purchase(expired_instant, error='ended')
        assert sql(f"select count(*) from public.bids where auction_id='{expired_instant}';") == '0'
        cancelled_instant = instant_create()
        sql(f"select public.cancel_auction('{cancelled_instant}');", SELLER, 'authenticated')
        purchase(cancelled_instant, error='cancelled')

        # Competing buyers cannot both accept the same instant offer.
        purchased_race = instant_create()
        def concurrent_purchase(uid):
            try:
                purchase(purchased_race, uid)
                return True
            except AssertionError as failure:
                assert 'ended' in str(failure), str(failure)
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(concurrent_purchase, [BUYER, OTHER])) == [False, True]
        assert sql(f"select count(*) from public.bids where auction_id='{purchased_race}';") == '1'
        assert sql(f"select final_price from public.auctions where id='{purchased_race}';") == '1000'

        # A lower bid may commit before purchase, but cannot reopen or overwrite it.
        purchase_vs_bid = instant_create()
        def bid_or_purchase(action):
            try:
                if action == 'purchase': purchase(purchase_vs_bid, BUYER)
                else: sql(f"select public.place_bid('{purchase_vs_bid}',500);", OTHER, 'authenticated')
                return True
            except AssertionError as failure:
                assert action == 'bid' and 'ended' in str(failure), str(failure)
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(bid_or_purchase, ['purchase', 'bid']))
        assert results[0]
        assert sql(f"select status || ':' || winner_id::text || ':' || current_bid from public.auctions where id='{purchase_vs_bid}';") == 'awaiting_trade:' + BUYER + ':1000'

        # Deadline must be checked after waiting for a lock, not when requested.
        locked = instant_create()
        sql(f"update public.auctions set end_time=clock_timestamp()+interval '0.4 seconds' where id='{locked}';")
        locker = subprocess.Popen([str(BINDIR / 'psql'), '-h', directory, '-d', 'postgres', '-X', '-qAt', '-c',
            f"begin; select 1 from public.auctions where id='{locked}' for update; select pg_sleep(1); commit;"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        assert locker.stdout.readline().strip() == '1'
        purchase(locked, error='ended')
        locker.communicate(timeout=5)
        assert locker.returncode == 0
        assert sql(f"select count(*) from public.bids where auction_id='{locked}';") == '0'

        # New KMail escrow workflow. The stub service role represents the bot.
        sql((ROOT / 'supabase/migrations/202610190004_kmail_escrow.sql').read_text())
        catalog_json = json.dumps([{'id':1,'name':'escrow item'}])
        sql(f"select public.bot_sync_catalog('{catalog_json}');", role='service_role')
        def mail(mid, sid, command, meat=0, items=None):
            return {'id': str(mid), 'sender_id': sid, 'sender_name': f'Player{sid}', 'received_at': '2026-10-19T12:00:00Z',
                'command': command, 'meat': meat, 'items': items or [], 'raw': {'id': str(mid)}}
        def ingest(payload, role='service_role', error=None):
            encoded = json.dumps(payload).replace("'", "''")
            return sql(f"select public.bot_ingest_mail('{encoded}');", role=role, error=error)
        for index, (uid,sid) in enumerate([(SELLER,777),(BUYER,888),(OTHER,999)]):
            challenge=json.loads(sql('select public.request_kol_verification();', uid, 'authenticated'))
            token=challenge['command'].split()[1]
            assert ingest(mail(1000+index,sid,{'type':'verify','token':token}))=='accepted'
            assert sql(f"select kol_player_id from public.profiles where id='{uid}';")==str(sid)
        sql("update public.profiles set kol_player_id=123 where id='"+BUYER+"';", BUYER,'authenticated',error='permission denied')
        for role in ['anon','authenticated']:
            sql('select public.bot_tick();', role=role, error='permission denied')
            ingest(mail(9999,999,{'type':'unknown'}),role=role,error='permission denied')
            sql('select * from khub_bot.receipts;',role=role,error='permission denied')
            sql('select public.bot_claim_delivery();',role=role,error='permission denied')
        def escrow_create(price='null'):
            return sql(f"select public.create_auction('escrow item',2,100,24,null,{price},1);",SELLER,'authenticated')
        funded=escrow_create(1000)
        assert sql(f"select status from public.auctions where id='{funded}';",SELLER,'authenticated')=='pending_escrow'
        assert sql(f"select count(*) from public.auctions where id='{funded}';",role='anon')=='0'
        assert sql(f"select count(*) from public.auctions where id='{funded}';",BUYER,'authenticated')=='0'
        sql(f"select public.place_bid('{funded}',100);",BUYER,'authenticated',error='funded bid')
        sql(f"select public.purchase_auction('{funded}');",BUYER,'authenticated',error='KMail')
        sql(f"select public.confirm_auction_trade('{funded}');",SELLER,'authenticated',error='bot')
        wrong=mail(1100,999,{'type':'list','auction_id':funded},items=[{'id':1,'quantity':2}])
        assert 'Only the listing seller' in ingest(wrong)
        assert sql(f"select status from public.auctions where id='{funded}';")=='pending_escrow'
        deposit=mail(1101,777,{'type':'list','auction_id':funded},items=[{'id':1,'quantity':2}])
        assert ingest(deposit)=='accepted'
        assert ingest(deposit)=='duplicate'
        assert sql(f"select status||':'||(item_escrowed_at is not null)::text from public.auctions where id='{funded}';")=='active:true'
        assert sql(f"select end_time>clock_timestamp()+interval '23 hours' from public.auctions where id='{funded}';")=='t'
        assert sql(f"select count(*) from public.auctions where id='{funded}';",role='anon')=='1'
        assert ingest(mail(1102,888,{'type':'bid','auction_id':funded},meat=200))=='accepted'
        assert ingest(mail(1103,999,{'type':'bid','auction_id':funded},meat=300))=='accepted'
        assert sql("select sum(meat) from khub_bot.deliveries where dedupe_key like 'outbid:1103:%';")=='200'
        # Same high bidder raises with a full new amount; previous escrow returns.
        assert ingest(mail(1104,999,{'type':'bid','auction_id':funded},meat=400))=='accepted'
        assert sql("select sum(meat) from khub_bot.deliveries where dedupe_key like 'outbid:1104:%';")=='300'
        # Rejected low bid is returned in full and cannot alter the high bid.
        assert 'exceeding' in ingest(mail(1105,888,{'type':'bid','auction_id':funded},meat=100))
        assert sql("select sum(meat) from khub_bot.deliveries where dedupe_key like 'rejected:1105:%';")=='100'
        assert sql(f"select current_bid from public.auctions where id='{funded}';")=='400'
        assert ingest(mail(1106,888,{'type':'buy','auction_id':funded},meat=1200))=='accepted'
        assert sql(f"select status||':'||final_price||':'||winner_id::text from public.auctions where id='{funded}';")=='settling:1000:'+BUYER
        assert sql("select sum(meat) from khub_bot.deliveries where dedupe_key like 'excess:1106:%';")=='200'
        assert sql(f"select sum(meat) from khub_bot.deliveries where kind='sale_meat' and auction_id='{funded}';")=='1000'
        assert sql(f"select sum(quantity) from khub_bot.deliveries where kind='sale_item' and auction_id='{funded}';")=='2'
        assert 'closed' in ingest(mail(1107,999,{'type':'bid','auction_id':funded},meat=2000))
        assert sql(f"select current_bid from public.auctions where id='{funded}';")=='1000'
        # Accepted, rejected, outbid, excess, and final payment obligations conserve all Meat.
        liabilities=json.loads(sql('select public.bot_liabilities();',role='service_role'))
        assert int(liabilities['meat'])==4200  # 200+300+400+100+1200+2000
        assert liabilities['items']['1']=='4'  # wrong sender refund plus winner's escrow
        def drain():
            while True:
                raw=sql('select public.bot_claim_delivery();',role='service_role')
                if not raw: break
                delivery=json.loads(raw)
                sql(f"select public.bot_ack_delivery('{delivery['id']}','{delivery['attempt']}',true,'fixture send acknowledged');",role='service_role')
        # An unresolved send survives restart and blocks every subsequent claim.
        delivery=json.loads(sql('select public.bot_claim_delivery();',role='service_role'))
        sql('select public.bot_claim_delivery();',role='service_role',error='reconciliation')
        pg_ctl('-l',str(Path(directory)/'postgres.log'),'-m','fast','-w','restart')
        sql('select public.bot_claim_delivery();',role='service_role',error='reconciliation')
        sql(f"select public.bot_ack_delivery('{delivery['id']}','{delivery['attempt']}',false,'network timeout; outcome unknown');",role='service_role')
        assert json.loads(sql('select public.bot_inspect();',role='service_role'))['attention'][0]['state']=='unknown'
        sql(f"select public.bot_reconcile_delivery('{delivery['id']}',false,'x');",role='service_role',error='evidence')
        sql(f"select public.bot_reconcile_delivery('{delivery['id']}',true,'Verified fixture sent-copy marker and attachments.');",role='service_role')
        drain()
        assert sql(f"select status||':'||(settled_at is not null)::text from public.auctions where id='{funded}';")=='completed:true'
        assert json.loads(sql('select public.bot_liabilities();',role='service_role'))=={'meat':'0','items':{}}
        # No-bid expiry returns items; cancellation returns a deposited lot too.
        for idx, outcome in enumerate(['ended_no_bids','cancelled']):
            lot=escrow_create()
            ingest(mail(1200+idx,777,{'type':'list','auction_id':lot},items=[{'id':1,'quantity':2}]))
            if outcome=='cancelled': sql(f"select public.cancel_auction('{lot}');",SELLER,'authenticated')
            else:
                expire(lot)
                sql('select public.bot_tick();',role='service_role')
            assert sql(f"select status from public.auctions where id='{lot}';")=='settling'
            drain()
            assert sql(f"select status from public.auctions where id='{lot}';")==outcome
        # Unknown commands return all normal attachments rather than eating them.
        assert 'Unknown command' in ingest(mail(1300,999,{'type':'unknown'},meat=321,items=[{'id':1,'quantity':3}]))
        assert sql("select sum(meat)||':'||sum(quantity) from khub_bot.deliveries where receipt_id='1300';")=='321:3'
        drain()

        assert 'Unknown command' in ingest(mail(1301,999,{'type':'unknown'}))
        assert sql("select count(*) from khub_bot.deliveries where receipt_id='1301';")=='0'
        # Deadline close with a winning funded bid and a snapshotted fee.
        sql('update khub_bot.settings set fee_bps=200 where id;')
        fee_lot=escrow_create()
        ingest(mail(1400,777,{'type':'list','auction_id':fee_lot},items=[{'id':1,'quantity':2}]))
        ingest(mail(1401,888,{'type':'bid','auction_id':fee_lot},meat=1000))
        expire(fee_lot)
        sql('select public.bot_tick();',role='service_role')
        assert sql(f"select fee_meat from public.auctions where id='{fee_lot}';")=='20'
        assert sql(f"select sum(meat) from khub_bot.deliveries where auction_id='{fee_lot}' and kind='sale_meat';")=='980'
        drain()
        assert sql(f"select status from public.auctions where id='{fee_lot}';")=='completed'
        sql('update khub_bot.settings set fee_bps=0,start_on_deposit=false where id;')
        fixed=escrow_create()
        deadline=sql(f"select end_time from public.auctions where id='{fixed}';")
        wrong_qty=mail(1410,777,{'type':'list','auction_id':fixed},items=[{'id':1,'quantity':3}])
        assert 'exactly' in ingest(wrong_qty)
        assert sql(f"select status from public.auctions where id='{fixed}';")=='pending_escrow'
        ingest(mail(1411,777,{'type':'list','auction_id':fixed},items=[{'id':1,'quantity':2}]))
        assert sql(f"select end_time from public.auctions where id='{fixed}';")==deadline
        sql(f"select public.cancel_auction('{fixed}');",SELLER,'authenticated')
        drain()
        sql('update khub_bot.settings set start_on_deposit=true where id;')
        # Two funded BUY messages produce one winner and a full loser refund.
        mail_race=escrow_create(1000)
        ingest(mail(1500,777,{'type':'list','auction_id':mail_race},items=[{'id':1,'quantity':2}]))
        def race_mail(pair):
            mid,sid=pair
            return ingest(mail(mid,sid,{'type':'buy','auction_id':mail_race},meat=1000))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(race_mail,[(1501,888),(1502,999)]))
        assert sorted(results)==['Bidding is closed.','accepted']
        assert sql(f"select count(*) from public.bids where auction_id='{mail_race}';")=='1'
        assert int(json.loads(sql('select public.bot_liabilities();',role='service_role'))['meat'])==2000
        # Replaying either receipt cannot duplicate winner, payouts, or refunds.
        for mid,sid in [(1501,888),(1502,999)]:
            assert ingest(mail(mid,sid,{'type':'buy','auction_id':mail_race},meat=1000))=='duplicate'
        assert int(json.loads(sql('select public.bot_liabilities();',role='service_role'))['meat'])==2000
        ingest(mail(1501,888,{'type':'buy','auction_id':mail_race},meat=1001),error='payload changed')
        drain()
        assert json.loads(sql('select public.bot_liabilities();',role='service_role'))=={'meat':'0','items':{}}

        # Page reads must preserve RLS while limiting transfer to requested records.
        sql((ROOT / 'supabase/migrations/202610190005_auction_page_reads.sql').read_text())
        def read_page(view='browse', uid=None, role='anon', **options):
            args=[f"p_view => '{view}'"]
            for key,value in options.items():
                args.append(f"p_{key} => '{value}'")
            return json.loads(sql('select public.read_auction_page('+','.join(args)+');',uid,role))
        private_lot=escrow_create()
        assert read_page('detail',id=private_lot)['rows']==[]
        assert len(read_page('detail',SELLER,'authenticated',id=private_lot)['rows'])==1
        assert read_page('detail',BUYER,'authenticated',id=private_lot)['rows']==[]
        assert read_page('profile')['rows']==[]
        own=read_page('profile',BUYER,'authenticated')
        assert all(r['seller_id']==BUYER or r['winner_id']==BUYER or sql(f"select exists(select 1 from public.bids where auction_id='{r['id']}' and bidder_id='{BUYER}');")=='t' for r in own['rows'])
        assert all(b['bidder_id']==BUYER for b in own['bids'])
        sql(f"""insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,end_time)
            select '{SELLER}','Seller','page fixture '||n,1,n,24,clock_timestamp()+interval '1 day'
            from generate_series(1,30) n;""")
        first=read_page(search='page fixture',sort='price-asc')
        second=read_page(search='page fixture',sort='price-asc',page=2)
        assert first['total']==30 and len(first['rows'])==24 and len(second['rows'])==6
        assert first['bids']==[] and second['bids']==[]
        assert [r['min_bid_meat'] for r in first['rows']+second['rows']]==list(range(1,31))
        assert not set(r['id'] for r in first['rows']) & set(r['id'] for r in second['rows'])
        assert read_page(search='PAGE FIXTURE',sort='price-desc')['rows'][0]['min_bid_meat']==30
        assert read_page(search='%',status='all')['total']==0  # Literal search, not LIKE wildcard.
        page_id=first['rows'][0]['id']
        sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{page_id}','{BUYER}','Buyer',100);")
        detail=read_page('detail',id=page_id)
        assert len(detail['rows'])==1 and detail['rows'][0]['bid_count']==1 and len(detail['bids'])==1
        home=read_page('home')
        assert len(home['rows'])==4 and home['bids']==[]
        assert all(r['status']=='active' for r in home['rows'])
        assert [r['bid_count'] for r in home['rows']]==sorted([r['bid_count'] for r in home['rows']],reverse=True)
        assert read_page(status='completed')['total']==int(sql("select count(*) from public.auctions where status='completed';"))
        assert all(r['status']!='pending_escrow' for r in read_page(status='ended')['rows'])

        # Friendly KMail references must preserve old audit evidence and financial state.
        old_id=sql("select id from khub_bot.deliveries where state='sent' order by created_at,id limit 1;")
        sql(f"update khub_bot.deliveries set state='unknown' where id='{old_id}';")
        financial_before=sql('select json_agg(json_build_array(id,state,meat,item_id,quantity,attempt,evidence) order by id) from khub_bot.deliveries;')
        sql((ROOT / 'supabase/migrations/202610190006_friendly_bot_messages.sql').read_text())
        assert sql('select json_agg(json_build_array(id,state,meat,item_id,quantity,attempt,evidence) order by id) from khub_bot.deliveries;')==financial_before
        old=json.loads(sql(f"select public.bot_lookup_delivery('{old_id}');",role='service_role'))
        assert old['reference_marker']=='[kHub delivery '+old_id+']' and old['display_message'] is None
        assert json.loads(sql(f"select public.bot_lookup_delivery('{old['delivery_reference'].lower()}');",role='service_role'))['id']==old_id
        sql('select public.bot_claim_delivery(2);',role='service_role',error='reconciliation')
        assert json.loads(sql('select public.bot_inspect();',role='service_role'))['attention'][0]['reference_marker']==old['reference_marker']
        sql(f"select public.bot_reconcile_delivery('{old_id}',true,'Verified legacy UUID sent-copy and exact attachments.');",role='service_role')
        for role in ['anon','authenticated']:
            sql(f"select public.bot_lookup_delivery('{old['delivery_reference']}');",role=role,error='permission denied')
            sql('select public.bot_claim_delivery(2);',role=role,error='permission denied')
        sql("select public.bot_lookup_delivery('D-999999999999999999');",role='service_role',error='not found')
        sql("select public.bot_lookup_delivery('D-10%');",role='service_role',error='reference')
        sql('select public.bot_claim_delivery();',role='service_role',error='does not exist')
        sql('select public.bot_claim_delivery(1);',role='service_role',error='version 2')
        assert sql('select count(*)=count(distinct reference_number) from khub_bot.deliveries;')=='t'
        assert sql('select count(*)=count(distinct auction_number) from public.auctions;')=='t'
        # All original template families render without exposing their UUIDs.
        previews=json.loads(sql('select json_agg(json_build_object(\'id\',d.id,\'auction_id\',d.auction_id,\'body\',khub_bot.friendly_message(d))) from khub_bot.deliveries d;'))
        for preview in previews:
            assert preview['id'] not in preview['body']
            assert not preview['auction_id'] or preview['auction_id'] not in preview['body']
        assert any('Account linked' in p['body'] for p in previews)
        assert any('Your auction sold' in p['body'] for p in previews)
        assert any('Auction cancelled' in p['body'] for p in previews)
        assert any('Auction ended without bids' in p['body'] for p in previews)
        assert any('Request not accepted' in p['body'] for p in previews)

        sql('update khub_bot.settings set fee_bps=0,start_on_deposit=true;')
        pretty_lot=escrow_create(1000)
        ingest(mail(2001,777,{'type':'list','auction_id':pretty_lot},items=[{'id':1,'quantity':2}]))
        claimed=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert claimed['display_message'].startswith('Your auction is live\n\nescrow item × 2\nAuction #')
        assert claimed['reference_marker']=='Reference: '+claimed['delivery_reference']
        # A confirmed not-sent retry keeps the exact body/ref, even if listing text changes.
        sql(f"select public.bot_ack_delivery('{claimed['id']}','{claimed['attempt']}',false,'fixture network outcome uncertain');",role='service_role')
        sql(f"update public.auctions set item='changed label' where id='{pretty_lot}';")
        sql(f"select public.bot_reconcile_delivery('{claimed['id']}',false,'Verified fixture transfer rejected; assets never left.');",role='service_role')
        retried=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert retried['display_message']==claimed['display_message'] and retried['reference_marker']==claimed['reference_marker']
        sql(f"select public.bot_ack_delivery('{retried['id']}','{retried['attempt']}',true,'fixture send acknowledged');",role='service_role')
        sql(f"update public.auctions set item='escrow item' where id='{pretty_lot}';")
        ingest(mail(2002,888,{'type':'bid','auction_id':pretty_lot},meat=719))
        ingest(mail(2003,999,{'type':'bid','auction_id':pretty_lot},meat=800))
        ingest(mail(2004,888,{'type':'buy','auction_id':pretty_lot},meat=1200))
        bodies=[]
        while True:
            raw=sql('select public.bot_claim_delivery(2);',role='service_role')
            if not raw: break
            delivery=json.loads(raw);bodies.append(delivery['display_message'])
            sql(f"select public.bot_ack_delivery('{delivery['id']}','{delivery['attempt']}',true,'fixture send acknowledged');",role='service_role')
        assert any('bid of 719 Meat' in b for b in bodies)  # Not the later 1,000 Meat final price.
        assert any(b.startswith('Extra Meat returned') for b in bodies)
        assert any(b.startswith('Your previous bid has been returned') for b in bodies)
        assert any(b.startswith('You won!') for b in bodies)
        assert any(b.startswith('Your auction sold') and 'fee' not in b for b in bodies)
        assert sql(f"select status from public.auctions where id='{pretty_lot}';")=='completed'
        assert json.loads(sql('select public.bot_liabilities();',role='service_role'))=={'meat':'0','items':{}}
        # Short auction commands resolve server-side to the same locked UUID row.
        sql((ROOT / 'supabase/migrations/202610190007_short_auction_commands.sql').read_text())
        short_lot=escrow_create(1000)
        number=sql(f"select auction_number from public.auctions where id='{short_lot}';")
        short_deposit=mail(3001,777,{'type':'list','auction_number':number},items=[{'id':1,'quantity':2}])
        assert 'Only the listing seller' in ingest(mail(3000,999,{'type':'list','auction_number':number},items=[{'id':1,'quantity':2}]))
        assert ingest(short_deposit)=='accepted' and ingest(short_deposit)=='duplicate'
        assert sql(f"select status from public.auctions where id='{short_lot}';")=='active'
        assert 'own auction' in ingest(mail(3002,777,{'type':'bid','auction_number':number},meat=100))
        short_bid=mail(3003,888,{'type':'bid','auction_number':number},meat=719)
        assert ingest(short_bid)=='accepted' and ingest(short_bid)=='duplicate'
        assert sql(f"select count(*) from public.bids where auction_id='{short_lot}';")=='1'
        receipt=json.loads(sql("select payload from khub_bot.receipts where mail_id='3003';"))
        assert receipt['command']=={'type':'bid','auction_number':number}
        # UUID commands still interoperate with short commands on the very same listing.
        assert ingest(mail(3004,999,{'type':'bid','auction_id':short_lot},meat=800))=='accepted'
        assert 'Unknown escrow auction' in ingest(mail(3005,888,{'type':'bid','auction_number':'999999999999'},meat=100))
        assert 'Unknown escrow auction' in ingest(mail(3006,888,{'type':'bid','auction_number':'9223372036854775808'},meat=100))
        assert 'Unknown escrow auction' in ingest(mail(3007,888,{'type':'bid','auction_number':'1001 OR 1=1'},meat=100))
        assert ingest(mail(3008,888,{'type':'buy','auction_number':number},meat=1200))=='accepted'
        assert sql(f"select winner_id::text||':'||final_price from public.auctions where id='{short_lot}';")==BUYER+':1000'
        while True:
            raw=sql('select public.bot_claim_delivery(2);',role='service_role')
            if not raw: break
            delivery=json.loads(raw)
            sql(f"select public.bot_ack_delivery('{delivery['id']}','{delivery['attempt']}',true,'fixture send acknowledged');",role='service_role')
        assert sql(f"select status from public.auctions where id='{short_lot}';")=='completed'
        assert json.loads(sql('select public.bot_liabilities();',role='service_role'))=={'meat':'0','items':{}}
        for role in ['anon','authenticated']:
            ingest(mail(3999,888,{'type':'bid','auction_number':number},meat=100),role=role,error='permission denied')
        # Gift donations get one durable thank-you and no auction/asset obligations.
        sql((ROOT / 'supabase/migrations/202610190008_donation_acknowledgments.sql').read_text())
        donation=mail(4000,777,{'type':'donation'})
        donation['raw']={'id':'4000','type':'giftshop','message':'BUY '+short_lot+' with a wrapped gift'}
        def ingest_donation(payload=donation,role='service_role',error=None):
            encoded=json.dumps(payload).replace("'","''")
            return sql(f"select public.bot_ingest_donation('{encoded}');",role=role,error=error)
        auctions_before_donation=sql('select json_agg(a order by id) from public.auctions a;')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(lambda _:ingest_donation(),range(2)))==['accepted','duplicate']
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like 'donation-thanks:4000:%';")=='1'
        assert sql('select json_agg(a order by id) from public.auctions a;')==auctions_before_donation
        assert json.loads(sql('select public.bot_liabilities();',role='service_role'))=={'meat':'0','items':{}}
        thanks=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert thanks['display_message']=='Thank you for your donation!\n\nYour support helps keep kHub running.'
        assert thanks['recipient_id']==777 and thanks['auction_id'] is None and thanks['meat']==0 and thanks['quantity']==0
        sql(f"select public.bot_ack_delivery('{thanks['id']}','{thanks['attempt']}',true,'fixture thank-you sent');",role='service_role')
        assert ingest_donation()=='duplicate'
        assert not sql('select public.bot_claim_delivery(2);',role='service_role')
        invalid={**donation,'id':'4001','raw':{'id':'4001','type':'normal'}}
        ingest_donation(invalid,error='Invalid normalized donation')
        ingest_donation({**donation,'id':'4002','meat':100},error='Invalid normalized donation')
        ingest_donation({**donation,'sender_name':'changed sender'},error='payload changed')
        for role in ['anon','authenticated']:
            ingest_donation(role=role,error='permission denied')
        sql((ROOT / 'supabase/migrations/202610190009_normal_kmail_donations.sql').read_text())
        assert ingest_donation()=='duplicate'  # Existing gift acknowledgments survive upgrade.
        normal_donation=mail(5000,888,{'type':'donation'},meat=1234,items=[{'id':1,'quantity':2}])
        normal_donation['raw']={'id':'5000','type':'normal','message':'DONATE'}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(lambda _:ingest_donation(normal_donation),range(2)))==['accepted','duplicate']
        help_mail=mail(5001,888,{'type':'donation'})
        help_mail['raw']={'id':'5001','type':'normal','message':'DONATE'}
        assert ingest_donation(help_mail)=='accepted'
        assert json.loads(sql('select payload from khub_bot.receipts where mail_id=\'5000\';'))==normal_donation
        assert sql("select count(*) from khub_bot.deliveries where receipt_id='5000';")=='1'
        assert sql("select count(*) from khub_bot.deliveries where receipt_id='5000' and (meat<>0 or quantity<>0 or kind<>'notice');")=='0'
        assert sql('select json_agg(a order by id) from public.auctions a;')==auctions_before_donation
        assert json.loads(sql('select public.bot_liabilities();',role='service_role'))=={'meat':'0','items':{}}
        replies=[]
        while True:
            raw=sql('select public.bot_claim_delivery(2);',role='service_role')
            if not raw: break
            delivery=json.loads(raw);replies.append(delivery['display_message'])
            sql(f"select public.bot_ack_delivery('{delivery['id']}','{delivery['attempt']}',true,'fixture donation reply sent');",role='service_role')
        assert len(replies)==2 and any('Thank you for your donation!' in body for body in replies)
        assert any(body.startswith('How to donate') and 'DONATE' in body for body in replies)
        assert ingest_donation(normal_donation)=='duplicate' and ingest_donation(help_mail)=='duplicate'
        # An unknown ordinary message still refunds assets instead of treating them as donations.
        assert 'Unknown command' in ingest(mail(5002,888,{'type':'unknown'},meat=33))
        returned=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert returned['kind']=='refund' and returned['meat']==33
        sql(f"select public.bot_ack_delivery('{returned['id']}','{returned['attempt']}',true,'fixture refund sent');",role='service_role')
        ingest_donation({**normal_donation,'id':'5003','items':[{'id':1,'quantity':-1}]},error='Invalid donation attachments')
        for role in ['anon','authenticated']:
            ingest_donation(normal_donation,role=role,error='permission denied')
        # Upgrade with a previously claimed donation: its retry must retain the old body.
        legacy_donation={**normal_donation,'id':'5010','raw':{'id':'5010','type':'normal','message':'DONATE'}}
        assert ingest_donation(legacy_donation)=='accepted'
        legacy=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        sql(f"select public.bot_ack_delivery('{legacy['id']}','{legacy['attempt']}',false,'fixture uncertain send');",role='service_role')
        sql((ROOT / 'supabase/migrations/202610190010_donation_message_style.sql').read_text())
        sql(f"select public.bot_reconcile_delivery('{legacy['id']}',false,'Verified fixture request rejected and assets never left.');",role='service_role')
        retry=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert retry['display_message']==legacy['display_message'] and retry['display_footer'] is None
        sql(f"select public.bot_ack_delivery('{retry['id']}','{retry['attempt']}',true,'fixture legacy retry sent');",role='service_role')
        styled_donation={**normal_donation,'id':'5011','raw':{'id':'5011','type':'normal','message':'DONATE'}}
        assert ingest_donation(styled_donation)=='accepted'
        styled=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert styled['display_message'].startswith('~ * ~ Thank you for supporting kHub ~ * ~')
        assert 'It’s support from players like you' in styled['display_message']
        assert 'That’s a business expense.' in styled['display_message']
        assert styled['display_footer']=='If this donation was sent in error, please KMail teres minor (#3552305) with the reference ID above.'
        sql(f"select public.bot_ack_delivery('{styled['id']}','{styled['attempt']}',false,'fixture uncertain send');",role='service_role')
        sql(f"select public.bot_reconcile_delivery('{styled['id']}',false,'Verified fixture request rejected and assets never left.');",role='service_role')
        retry=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert all(retry[key]==styled[key] for key in ['display_message','display_footer','reference_marker'])
        sql(f"select public.bot_ack_delivery('{retry['id']}','{retry['attempt']}',true,'fixture styled retry sent');",role='service_role')
        # The wording-only upgrade preserves historical messages and updates new donations.
        sql((ROOT / 'supabase/migrations/202610190011_donation_message_wording.sql').read_text())
        saved=json.loads(sql(f"select public.bot_lookup_delivery('{styled['id']}');",role='service_role'))
        assert saved['display_message']==styled['display_message'] and saved['display_footer']==styled['display_footer']
        revised_donation={**normal_donation,'id':'5012','raw':{'id':'5012','type':'normal','message':'DONATE'}}
        assert ingest_donation(revised_donation)=='accepted'
        revised=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert revised['display_message']=="Thanks so much for pitching in, we really appreciate your support! It’s players like you who make projects like kHub possible.\n\nRest assured, 100% of your donation will go toward keeping kHub running. Except for the part we spend on booze. That’s a business expense."
        assert revised['display_footer']=="\n*If this donation was sent in error, please KMail teres minor (#3552305) with the reference ID above."
        sql(f"select public.bot_ack_delivery('{revised['id']}','{revised['attempt']}',true,'fixture revised donation sent');",role='service_role')
        # Inbox retention and separately tracked manual-review notices.
        sql((ROOT / 'supabase/migrations/202610190012_bot_mail_review.sql').read_text())
        def cleanup(*ids,role='service_role'):
            return json.loads(sql("select public.bot_mail_cleanup(array["+','.join("'"+value+"'" for value in ids)+"]::text[]);",role=role))
        assert cleanup('5012','4000','5002','999999')==['5012'] # Gifts/unknown mail never deleted.
        held_donation={**normal_donation,'id':'5013','raw':{'id':'5013','type':'normal','message':'DONATE'}}
        assert ingest_donation(held_donation)=='accepted'
        assert cleanup('5013')==[]
        held=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert cleanup('5013')==[]
        sql(f"select public.bot_ack_delivery('{held['id']}','{held['attempt']}',false,'fixture uncertain transfer');",role='service_role')
        notice=json.loads(sql('select public.bot_claim_review_notice();',role='service_role'))
        assert notice['kind']=='notice' and notice['meat']==0 and notice['quantity']==0 and notice['item_id'] is None
        assert notice['recipient_id']==held['recipient_id'] and notice['auction_id'] is None and notice['receipt_id'] is None
        assert held['delivery_reference'] in notice['display_message'] and 'may already have arrived' in notice['display_message']
        assert 'do not resend' in notice['display_message'] and notice['delivery_reference']!=held['delivery_reference']
        assert not sql('select public.bot_claim_review_notice();',role='service_role')
        sql(f"select public.bot_ack_delivery('{notice['id']}','{notice['attempt']}',false,'fixture notice uncertain');",role='service_role')
        assert not sql('select public.bot_claim_review_notice();',role='service_role') # No recursive notice or retry.
        sql('select public.bot_claim_delivery(2);',role='service_role',error='reconciliation')
        assert cleanup('5013')==[]
        sql(f"select public.bot_reconcile_delivery('{notice['id']}',false,'Verified notice request rejected and never sent.');",role='service_role')
        retry=json.loads(sql('select public.bot_claim_review_notice();',role='service_role'))
        assert retry['id']==notice['id'] and retry['display_message']==notice['display_message']
        sql(f"select public.bot_ack_delivery('{retry['id']}','{retry['attempt']}',true,'fixture notice sent');",role='service_role')
        assert not sql('select public.bot_claim_review_notice();',role='service_role')
        assert cleanup('5013')==[]
        sql(f"select public.bot_reconcile_delivery('{held['id']}',true,'Verified original sent-copy marker and exact attachments.');",role='service_role')
        assert cleanup('5013')==['5013']
        rejected=mail(5014,888,{'type':'verify','token':'f'*32})
        rejected['raw']={'id':'5014','type':'normal','message':'VERIFY '+'f'*32}
        assert 'invalid or expired' in ingest(rejected)
        reply=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        sql(f"select public.bot_ack_delivery('{reply['id']}','{reply['attempt']}',true,'fixture rejected request reply sent');",role='service_role')
        assert cleanup('5014')==[] # Rejections stay visible even after the reply/refund.
        for role in ['anon','authenticated']:
            sql("select public.bot_mail_cleanup(array['5013']);",role=role,error='permission denied')
            sql('select public.bot_claim_review_notice();',role=role,error='permission denied')
        # Exact donation/fee closet accounting; existing auctions keep their terms.
        sql((ROOT / 'supabase/migrations/202610190013_closet_income.sql').read_text())
        assert sql('select fee_bps from khub_bot.settings;')=='750'
        assert sql(f"select fee_bps from public.auctions where id='{private_lot}';")=='0'
        def drain_v2():
            while True:
                raw=sql('select public.bot_claim_delivery(2);',role='service_role')
                if not raw: break
                delivery=json.loads(raw)
                sql(f"select public.bot_ack_delivery('{delivery['id']}','{delivery['attempt']}',true,'fixture confirmed send');",role='service_role')
        def claim_closet(snapshot=None,reserve=1000,review_meat=0,review_items=None,error=None):
            snapshot=snapshot or {'meat':'10000','closetMeat':'100','items':{'1':'100','1167':'7'},'closetItems':{}}
            encoded=json.dumps(snapshot)
            result=sql(f"select public.bot_claim_closet_transfer('{encoded}',{reserve},{review_meat},'{json.dumps(review_items or {})}');",role='service_role',error=error)
            return json.loads(result) if result and not error else None
        def ack_closet(d,moved=True):
            sql(f"select public.bot_ack_closet_transfer('{d['id']}','{d['attempt']}',{str(moved).lower()},'fixture inventory and closet balances');",role='service_role')
        income={**normal_donation,'id':'6000','meat':1500,'items':[{'id':1,'quantity':3}],
                'raw':{'id':'6000','type':'normal','message':'DONATE'}}
        assert ingest_donation(income)=='accepted' and ingest_donation(income)=='duplicate'
        assert sql("select count(*) from khub_bot.closet_transfers where receipt_id='6000';")=='2'
        drain_v2()
        assert cleanup('6000')==[]
        move=claim_closet(); assert move['meat']==1500 and move['source']=='donation'
        assert move['before_state']=={'inventory':'10000','closet':'100'}
        sql('select public.bot_claim_delivery(2);',role='service_role',error='closet transfer')
        claim_closet(error='Resolve uncertain')
        ack_closet(move,False)
        pg_ctl('-l',str(Path(directory)/'postgres.log'),'-m','fast','-w','restart')
        report=json.loads(sql('select public.bot_inspect();',role='service_role'))
        assert report['closetAttention'][0]['id']==move['id']
        assert report['closetAttention'][0]['closet_reference']==move['closet_reference']
        sql(f"select public.bot_reconcile_closet_transfer('{move['id']}',false,'Verified closet deposit was rejected; no balance change.');",role='service_role')
        retry=claim_closet(); assert retry['id']==move['id'] and retry['attempt']!=move['attempt']
        sql(f"select public.bot_ack_closet_transfer('{move['id']}','{move['attempt']}',true,'stale fixture acknowledgment');",role='service_role',error='claim does not match')
        ack_closet(retry)
        assert cleanup('6000')==[] # Item donation still needs to be closeted.
        item_move=claim_closet(); assert item_move['item_id']==1 and item_move['quantity']==3
        ack_closet(item_move)
        assert cleanup('6000')==['6000'] and claim_closet() is None
        assert sql('select count(*) from khub_bot.closet_reconciliations;')=='1'
        assert json.loads(sql(f"select public.bot_lookup_closet_transfer('{move['closet_reference']}');",role='service_role'))['id']==move['id']
        # A known gift-wrapper item may itself be auctioned; protect those units.
        sql('select public.bot_sync_catalog(\'[ {"id":1167,"name":"plain brown wrapper"} ]\');',role='service_role')
        wrapper_lot=sql("select public.create_auction('plain brown wrapper',2,100,24,null,null,1167);",SELLER,'authenticated')
        assert ingest(mail(6001,777,{'type':'list','auction_id':wrapper_lot},items=[{'id':1167,'quantity':2}]))=='accepted'
        drain_v2()
        for _ in range(2):
            sql('select public.bot_queue_gift_packages(\'{"1167":"7"}\',\'{"1167":"1"}\');',role='service_role')
        assert sql("select sum(quantity) from khub_bot.closet_transfers where source='gift_package';")=='4'
        claim_closet({'meat':'10000','closetMeat':'0','items':{'1167':'6'},'closetItems':{}},review_items={'1167':'1'},error='Not enough unencumbered')
        package=claim_closet(review_items={'1167':'1'}); assert package['item_id']==1167 and package['quantity']==4
        ack_closet(package)
        # An Instant Purchase is a completed sale, with no fee collection until payouts finish.
        sale=escrow_create(10000)
        assert sql(f"select fee_bps from public.auctions where id='{sale}';")=='750'
        ingest(mail(6002,777,{'type':'list','auction_id':sale},items=[{'id':1,'quantity':2}]))
        ingest(mail(6003,888,{'type':'buy','auction_id':sale},meat=10000))
        assert sql(f"select fee_meat from public.auctions where id='{sale}';")=='750'
        assert sql(f"select sum(meat) from khub_bot.deliveries where auction_id='{sale}' and kind='sale_meat';")=='9250'
        assert sql(f"select count(*) from khub_bot.closet_transfers where auction_id='{sale}';")=='0'
        drain_v2()
        assert sql(f"select status from public.auctions where id='{sale}';")=='completed'
        assert sql(f"select sum(meat) from khub_bot.closet_transfers where auction_id='{sale}';")=='750'
        sql('select public.bot_tick();',role='service_role')
        sql(f"update public.auctions set status=status where id='{sale}';")
        assert sql(f"select count(*) from khub_bot.closet_transfers where auction_id='{sale}';")=='1'
        claim_closet({'meat':'2200','closetMeat':'0','items':{},'closetItems':{}},review_meat=500,error='Not enough unencumbered')
        fee=claim_closet({'meat':'2250','closetMeat':'0','items':{},'closetItems':{}},review_meat=500)
        assert fee['meat']==750 and fee['source']=='sale_fee'; ack_closet(fee)
        # An expired no-bid listing returns its items without any commission.
        no_bids=escrow_create()
        ingest(mail(6004,777,{'type':'list','auction_id':no_bids},items=[{'id':1,'quantity':2}]))
        expire(no_bids);sql('select public.bot_tick();',role='service_role');drain_v2()
        assert sql(f"select fee_meat from public.auctions where id='{no_bids}';")=='0'
        assert sql(f"select count(*) from khub_bot.closet_transfers where auction_id='{no_bids}';")=='0'
        # Percentage fees round down to whole Meat; ordinary expiry works as well.
        rounding=escrow_create()
        ingest(mail(6005,777,{'type':'list','auction_id':rounding},items=[{'id':1,'quantity':2}]))
        ingest(mail(6006,888,{'type':'bid','auction_id':rounding},meat=101))
        expire(rounding);sql('select public.bot_tick();',role='service_role');drain_v2()
        assert sql(f"select fee_meat from public.auctions where id='{rounding}';")=='7'
        assert sql(f"select sum(meat) from khub_bot.deliveries where auction_id='{rounding}' and kind='sale_meat';")=='94'
        rounded_fee=claim_closet();assert rounded_fee['meat']==7;ack_closet(rounded_fee)
        cancelled=escrow_create()
        ingest(mail(6007,777,{'type':'list','auction_id':cancelled},items=[{'id':1,'quantity':2}]))
        sql(f"select public.cancel_auction('{cancelled}');",SELLER,'authenticated');drain_v2()
        assert sql(f"select count(*) from khub_bot.closet_transfers where auction_id='{cancelled}';")=='0'
        tiny=sql("select public.create_auction('escrow item',2,1,24,null,null,1);",SELLER,'authenticated')
        ingest(mail(6008,777,{'type':'list','auction_id':tiny},items=[{'id':1,'quantity':2}]))
        ingest(mail(6009,888,{'type':'bid','auction_id':tiny},meat=1))
        expire(tiny);sql('select public.bot_tick();',role='service_role');drain_v2()
        assert sql(f"select fee_meat from public.auctions where id='{tiny}';")=='0'
        assert sql(f"select count(*) from khub_bot.closet_transfers where auction_id='{tiny}';")=='0'
        # Already tracked wrapper donations must not be queued a second time by the package sweep.
        wrapper_donation={**income,'id':'6010','meat':0,'items':[{'id':1167,'quantity':1}],
                          'raw':{'id':'6010','type':'normal','message':'DONATE'}}
        assert ingest_donation(wrapper_donation)=='accepted'
        sql("select public.bot_queue_gift_packages('{\"1167\":\"4\"}','{\"1167\":\"1\"}');",role='service_role')
        assert sql("select sum(quantity) from khub_bot.closet_transfers where source='gift_package';")=='4'
        donation_package=claim_closet({'meat':'10000','closetMeat':'0','items':{'1167':'4'},'closetItems':{}},review_items={'1167':'1'})
        assert donation_package['source']=='donation' and donation_package['quantity']==1;ack_closet(donation_package)
        # Maximum-size donations split into bounded operations and replay just once.
        large_income={**income,'id':'6011','meat':20000000000,'items':[{'id':1,'quantity':5000000000}],
                      'raw':{'id':'6011','type':'normal','message':'DONATE'}}
        assert ingest_donation(large_income)=='accepted' and ingest_donation(large_income)=='duplicate'
        assert sql("select count(*) from khub_bot.closet_transfers where receipt_id='6011';")=='25'
        assert sql("select sum(meat)||':'||sum(quantity) from khub_bot.closet_transfers where receipt_id='6011';")=='20000000000:5000000000'
        assert sql("select max(greatest(meat,quantity)) from khub_bot.closet_transfers where receipt_id='6011';")=='1000000000'
        held_bid=escrow_create()
        ingest(mail(6012,777,{'type':'list','auction_id':held_bid},items=[{'id':1,'quantity':2}]))
        ingest(mail(6013,888,{'type':'bid','auction_id':held_bid},meat=1000));drain_v2()
        claim_closet({'meat':'1000001500','closetMeat':'0','items':{},'closetItems':{}},error='Not enough unencumbered')
        # Restricted RPCs/tables stay server-only.
        for role in ['anon','authenticated']:
            sql("select public.bot_queue_gift_packages('{}','{}');",role=role,error='permission denied')
            sql("select public.bot_claim_closet_transfer('{}',1000,0,'{}');",role=role,error='permission denied')
            sql(f"select public.bot_ack_closet_transfer('{move['id']}','{move['attempt']}',true,'test');",role=role,error='permission denied')
            sql(f"select public.bot_lookup_closet_transfer('{move['closet_reference']}');",role=role,error='permission denied')
            sql(f"select public.bot_reconcile_closet_transfer('{move['id']}',true,'fixture evidence');",role=role,error='permission denied')
            sql('select * from khub_bot.closet_transfers;',role=role,error='permission denied')
        # Revised auction headings and receipts preserve previously claimed messages.
        ingest(mail(7000,999,{'type':'bid','auction_id':held_bid},meat=2000))
        frozen=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert frozen['dedupe_key'].startswith('outbid:')
        sql(f"select public.bot_ack_delivery('{frozen['id']}','{frozen['attempt']}',false,'fixture send uncertain');",role='service_role')
        sql((ROOT / 'supabase/migrations/202610190014_auction_message_layout.sql').read_text())
        sql(f"select public.bot_reconcile_delivery('{frozen['id']}',false,'Verified old request rejected; no transfer occurred.');",role='service_role')
        retry=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert retry['id']==frozen['id'] and retry['display_message']==frozen['display_message']
        sql(f"select public.bot_ack_delivery('{retry['id']}','{retry['attempt']}',true,'fixture old wording sent');",role='service_role')
        drain_v2()
        number=sql(f"select auction_number from public.auctions where id='{held_bid}';")
        heading='Auction #'+number+'\n'+'-'*len('Auction #'+number)+'\nescrow item × 2'
        ingest(mail(7001,888,{'type':'bid','auction_id':held_bid},meat=3000))
        outbid=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert outbid['display_message']=='You’ve been outbid!\n\n'+heading+'\n\nYour previous bid is attached and has been returned in full.'
        sql(f"select public.bot_ack_delivery('{outbid['id']}','{outbid['attempt']}',true,'fixture new outbid notice sent');",role='service_role')
        drain_v2()
        def collect_messages():
            result=[]
            while True:
                raw=sql('select public.bot_claim_delivery(2);',role='service_role')
                if not raw: return result
                delivery=json.loads(raw);result.append(delivery)
                sql(f"select public.bot_ack_delivery('{delivery['id']}','{delivery['attempt']}',true,'fixture message delivered');",role='service_role')
        receipt_sale=escrow_create(10000)
        ingest(mail(7002,777,{'type':'list','auction_id':receipt_sale},items=[{'id':1,'quantity':2}]))
        ingest(mail(7003,888,{'type':'buy','auction_id':receipt_sale},meat=10000))
        receipts=collect_messages()
        number=sql(f"select auction_number from public.auctions where id='{receipt_sale}';")
        heading='Auction #'+number+'\n'+'-'*len('Auction #'+number)+'\nescrow item × 2'
        seller_message=next(d for d in receipts if d['kind']=='sale_meat')
        assert seller_message['display_message']=='Your auction has sold!\n\n'+heading+'\n\nSale Price: 10,000 Meat\nCommission (7.5%): 750 Meat\nYour Proceeds: 9,250 Meat\n\nYour proceeds are attached. Enjoy!\nThanks for using kHub. We hope to see you again soon!'
        assert all(heading in d['display_message'] for d in receipts)
        # Legacy fee terms are rendered accurately rather than hardcoding 7.5%.
        for lot,label in [(fee_lot,'Commission (2%): 20 Meat'),(short_lot,'Commission (0%): 0 Meat')]:
            preview=sql(f"select khub_bot.friendly_message(d) from khub_bot.deliveries d where auction_id='{lot}' and kind='sale_meat' limit 1;")
            assert label in preview
        # Split receipts show total proceeds and the amount actually attached in each mail.
        split_sale=escrow_create(2000000000)
        ingest(mail(7004,777,{'type':'list','auction_id':split_sale},items=[{'id':1,'quantity':2}]))
        ingest(mail(7005,888,{'type':'buy','auction_id':split_sale},meat=2000000000))
        split_receipts=[d for d in collect_messages() if d['kind']=='sale_meat']
        assert len(split_receipts)==2 and sum(d['meat'] for d in split_receipts)==1850000000
        for d in split_receipts:
            assert 'Your Proceeds: 1,850,000,000 Meat' in d['display_message']
            assert f"Attached in this message: {d['meat']:,} Meat" in d['display_message']
            assert 'This portion of your proceeds is attached. Enjoy!' in d['display_message']
        split_bid=escrow_create()
        ingest(mail(7006,777,{'type':'list','auction_id':split_bid},items=[{'id':1,'quantity':2}]))
        ingest(mail(7007,888,{'type':'bid','auction_id':split_bid},meat=1500000000))
        ingest(mail(7008,999,{'type':'bid','auction_id':split_bid},meat=1700000000))
        returned=[d for d in collect_messages() if d['dedupe_key'].startswith('outbid:')]
        assert len(returned)==2 and sum(d['meat'] for d in returned)==1500000000
        for d in returned:
            assert 'returned in full across multiple messages' in d['display_message']
            assert f"This message contains {d['meat']:,} Meat." in d['display_message']
        # No extra owner-funded buffer is required: exact remaining escrow is protected.
        protected=json.loads(sql('select public.bot_liabilities();',role='service_role'))
        without_buffer=claim_closet({'meat':str(int(protected['meat'])+1000000000),'closetMeat':'0',
                                    'items':protected['items'],'closetItems':{}},reserve=0)
        assert without_buffer['meat']==1000000000
        ack_closet(without_buffer)
        # Policy correction: blank funded normal mail is refunded, not donated.
        old_blank=mail(8000,888,{'type':'donation'},items=[{'id':1904,'quantity':1}])
        old_blank['raw']={'id':'8000','type':'normal','message':'<table class="item" rel="id=1904&n=1"></table>'}
        assert ingest_donation(old_blank)=='accepted'
        old_meat=mail(8001,888,{'type':'donation'},meat=50)
        old_meat['raw']={'id':'8001','type':'normal','message':'<center>You gain 50 Meat</center>'}
        assert ingest_donation(old_meat)=='accepted'
        explicit=mail(8002,888,{'type':'donation'},meat=20)
        explicit['raw']={'id':'8002','type':'normal','message':'DONATE<center>You gain 20 Meat</center>'}
        assert ingest_donation(explicit)=='accepted'
        wrapped=mail(8003,888,{'type':'donation'})
        wrapped['raw']={'id':'8003','type':'giftshop','message':'BID 1001'}
        assert ingest_donation(wrapped)=='accepted'
        # Simulate a crash/uncertain write for this previously accepted donation.
        old_closet=json.loads(sql("update khub_bot.closet_transfers set state='moving',attempt=gen_random_uuid(),before_state='{\"inventory\":\"1\",\"closet\":\"0\"}' where receipt_id='8000' returning row_to_json(closet_transfers);"))
        ack_closet(old_closet,False)
        # Reporting also works on installations without the mail-policy migration.
        assert sql("select to_regclass('khub_bot.mail_policy_reviews') is null;")=='t'
        sql((ROOT / 'supabase/migrations/202610190017_financial_reports.sql').read_text())
        early_donations=json.loads(sql("select public.bot_financial_history('donations',0,100);",role='service_role'))['records']
        assert not ({'8000','8001'} & {r['mail_id'] for r in early_donations})
        assert {'8002','8003'} <= {r['mail_id'] for r in early_donations}
        early_stats=json.loads(sql('select public.bot_financial_stats();',role='service_role'))
        sql((ROOT / 'supabase/migrations/202610190015_invalid_mail_refunds.sql').read_text())
        assert json.loads(sql('select public.bot_financial_stats();',role='service_role'))['donations']==early_stats['donations']
        assert sql("select state from khub_bot.closet_transfers where receipt_id='8000';")=='unknown'
        assert sql("select state from khub_bot.closet_transfers where receipt_id='8001';")=='cancelled'
        assert sql("select state from khub_bot.closet_transfers where receipt_id='8002';")=='pending'
        assert sql("select count(*) from khub_bot.deliveries where receipt_id in ('8000','8001') and state='cancelled';")=='2'
        assert sql("select count(*) from khub_bot.deliveries where receipt_id in ('8002','8003') and state='pending';")=='2'
        report=json.loads(sql('select public.bot_inspect();',role='service_role'))
        assert {r['receipt_id'] for r in report['mailPolicyAttention']}=={'8000','8001'}
        corrected={**old_blank,'command':{'type':'unknown'}}
        assert ingest(corrected)=='previous_donation_review'
        ingest({**corrected,'meat':1},error='payload changed')
        sql("select public.bot_queue_previous_donation_refunds('{}');",role='service_role',error='Reconcile uncertain')
        sql(f"select public.bot_reconcile_closet_transfer('{old_closet['id']}',true,'Verified original closet move happened; item currently in closet.');",role='service_role')
        held=json.loads(sql('select public.bot_liabilities();',role='service_role'))
        assert held['items']['1904']=='1'
        missing={'meat':held['meat'],'items':{k:v for k,v in held['items'].items() if k!='1904'}}
        sql(f"select public.bot_queue_previous_donation_refunds('{json.dumps(missing)}');",role='service_role',error='item #1904')
        restored={'meat':held['meat'],'items':held['items']}
        for _ in range(2):
            sql(f"select public.bot_queue_previous_donation_refunds('{json.dumps(restored)}');",role='service_role')
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like 'policy-refund:%';")=='2'
        assert json.loads(sql('select public.bot_liabilities();',role='service_role'))==held
        assert ingest(corrected)=='duplicate' and ingest_donation(old_blank)=='duplicate'
        assert json.loads(sql("select payload from khub_bot.receipts where mail_id='8000';"))==old_blank
        # A stale worker cannot record new implicit donations after the migration.
        fresh_blank=mail(8004,888,{'type':'donation'},meat=70,items=[{'id':1,'quantity':1}])
        fresh_blank['raw']={'id':'8004','type':'normal','message':'<center>You gain 70 Meat</center><table class="item" rel="id=1&n=1"></table>'}
        ingest_donation(fresh_blank,error='require DONATE')
        assert sql("select count(*) from khub_bot.receipts where mail_id='8004';")=='0'
        refund={**fresh_blank,'command':{'type':'unknown'}}
        assert 'Unknown command' in ingest(refund) and ingest(refund)=='duplicate'
        invalid=mail(8005,888,{'type':'unknown'},meat=80)
        invalid['raw']={'id':'8005','type':'normal','message':'hello<center>You gain 80 Meat</center>'}
        assert 'Unknown command' in ingest(invalid)
        assert sql("select sum(meat)||':'||sum(quantity) from khub_bot.deliveries where receipt_id='8004' and kind='refund';")=='70:1'
        assert sql("select sum(meat) from khub_bot.deliveries where receipt_id='8005' and kind='refund';")=='80'
        assert sql("select count(*) from khub_bot.closet_transfers where receipt_id in ('8004','8005');")=='0'
        policy_messages=collect_messages()
        invalid_replies=[d for d in policy_messages if d['receipt_id'] in ['8004','8005']]
        assert len(invalid_replies)==3 and all('Invalid command' in d['display_message'] for d in invalid_replies)
        assert all('being returned' in d['display_message'] for d in invalid_replies)
        assert cleanup('8000','8001','8004','8005')==[]
        assert json.loads(sql('select public.bot_inspect();',role='service_role'))['mailPolicyAttention']==[]
        for role in ['anon','authenticated']:
            sql("select public.bot_queue_previous_donation_refunds('{}');",role=role,error='permission denied')
            sql('select * from khub_bot.mail_policy_reviews;',role=role,error='permission denied')
            ingest(refund,role=role,error='permission denied')
        sql((ROOT / 'supabase/migrations/202610190016_cancel_opened_package.sql').read_text())
        sql((ROOT / 'supabase/migrations/202610190017_financial_reports.sql').read_text())
        def financial_stats():
            return json.loads(sql('select public.bot_financial_stats();',role='service_role'))
        def financial_history(kind,offset=0,limit=100):
            return json.loads(sql(f"select public.bot_financial_history('{kind}',{offset},{limit});",role='service_role'))['records']
        for role in ['anon','authenticated']:
            sql('select public.bot_financial_stats();',role=role,error='permission denied')
            sql("select public.bot_financial_history('donations',0,20);",role=role,error='permission denied')
            sql('select * from khub_bot.report_donations();',role=role,error='permission denied')
        sql("select public.bot_financial_history('other',0,20);",role='service_role',error='Use donations or sales')
        sql("select public.bot_financial_history('sales',-1,20);",role='service_role',error='nonnegative offset')
        sql("select public.bot_financial_history('sales',0,101);",role='service_role',error='limit between')
        base_report=financial_stats()
        report_donation=mail(9100,888,{'type':'donation'},meat=200,items=[{'id':1,'quantity':3}])
        report_donation['raw']={'id':'9100','type':'normal','message':'DONATE'}
        assert ingest_donation(report_donation)=='accepted'
        assert ingest_donation(report_donation)=='duplicate'
        report_gift={**donation,'id':'9101','raw':{'id':'9101','type':'giftshop','message':'A gift'}}
        assert ingest_donation(report_gift)=='accepted'
        donated_report=financial_stats()
        assert int(donated_report['donations']['receipts'])==int(base_report['donations']['receipts'])+2
        assert int(donated_report['donations']['meat'])==int(base_report['donations']['meat'])+200
        assert int(donated_report['donations']['gift_packages'])==int(base_report['donations']['gift_packages'])+1
        def donated_units(report):
            return int(next(x['quantity'] for x in report['donations']['items'] if x['item_id']==1))
        assert donated_units(donated_report)==donated_units(base_report)+3
        donation_rows=financial_history('donations')
        assert not ({'8000','8001','8004','8005'} & {r['mail_id'] for r in donation_rows})
        assert next(r for r in donation_rows if r['mail_id']=='9101')['items']==[]
        assert next(r for r in donation_rows if r['mail_id']=='9100')['meat']=='200'
        assert financial_history('donations',0,1)+financial_history('donations',1,1)==donation_rows[:2]
        assert financial_history('sales',100000)==[]
        # New funded sales count only after every delivery is acknowledged.
        report_sale=escrow_create(10000)
        ingest(mail(9102,777,{'type':'list','auction_id':report_sale},items=[{'id':1,'quantity':2}]))
        ingest(mail(9103,888,{'type':'buy','auction_id':report_sale},meat=10000))
        assert financial_stats()['sales']==base_report['sales']
        collect_messages()
        sold_report=financial_stats()
        for field,delta in [('completed',1),('trade_meat',10000),('commission_meat',750),('seller_proceeds_meat',9250)]:
            assert int(sold_report['sales'][field])==int(base_report['sales'][field])+delta
        assert sold_report['donations']==donated_report['donations']
        sale_rows=financial_history('sales')
        assert len([r for r in sale_rows if r['auction_id']==split_sale])==1
        assert next(r for r in sale_rows if r['auction_id']==split_sale)['sale_meat']=='2000000000'
        assert next(r for r in sale_rows if r['auction_id']==report_sale)['seller_proceeds_meat']=='9250'
        assert int(sold_report['sales']['trade_meat'])==sum(int(r['sale_meat']) for r in sale_rows)
        assert int(sold_report['sales']['commission_meat'])==sum(int(r['commission_meat']) for r in sale_rows)
        # Moving or withdrawing income cannot change historical accounting.
        moved_report=json.loads(sql("begin; update khub_bot.closet_transfers set state='moved' where state='pending'; select public.bot_financial_stats(); rollback;"))
        assert moved_report['sales']==sold_report['sales'] and moved_report['donations']==sold_report['donations']
        def wrapper_plan(key):
            return sql("insert into khub_bot.closet_transfers(dedupe_key,source,item_id,quantity) "
                       f"values ('opened-test:{key}','gift_package',1167,1) returning id;")
        opened=wrapper_plan('opened')
        cancel_reason='Owner confirmed opening the package manually; wrapper consumed.'
        cancel_query=f"select public.bot_cancel_opened_package('{opened}','{cancel_reason}');"
        for role in ['anon','authenticated']:
            sql(cancel_query,role=role,error='permission denied')
        sql(f"select public.bot_cancel_opened_package('{opened}','short');",role='service_role',error='Record why')
        protected_before=sql('select public.bot_liabilities();',role='service_role')
        financial_before=sql('select json_agg(d order by id) from khub_bot.deliveries d;')
        sql(cancel_query,role='service_role')
        assert sql(f"select state from khub_bot.closet_transfers where id='{opened}';")=='cancelled'
        assert sql(f"select resolution||':'||evidence from khub_bot.closet_reconciliations where transfer_id='{opened}';")=='cancelled:'+cancel_reason
        assert sql('select public.bot_liabilities();',role='service_role')==protected_before
        assert sql('select json_agg(d order by id) from khub_bot.deliveries d;')==financial_before
        sql(cancel_query,role='service_role',error='Only never-attempted')
        assert sql(f"select count(*) from khub_bot.closet_reconciliations where transfer_id='{opened}';")=='1'
        for key,changes in [
            ('donation',"source='donation'"),('fee',"source='sale_fee'"),
            ('non-wrapper','item_id=1904'),('moving',"state='moving',attempt=gen_random_uuid()"),
            ('unknown',"state='unknown',attempt=gen_random_uuid()"),('moved',"state='moved',moved_at=now()"),
            ('previously-attempted',"before_state='{\"inventory\":\"1\",\"closet\":\"0\"}'"),
            ('meat','item_id=null,quantity=0,meat=1'),
        ]:
            blocked=wrapper_plan(key)
            sql(f"update khub_bot.closet_transfers set {changes} where id='{blocked}';")
            sql(f"select public.bot_cancel_opened_package('{blocked}','{cancel_reason}');",role='service_role',error='Only never-attempted')
            assert sql(f"select count(*) from khub_bot.closet_reconciliations where transfer_id='{blocked}';")=='0'
        closet_before=sql('select json_agg(c order by id) from khub_bot.closet_transfers c;')
        deliveries_before=sql('select json_agg(d order by id) from khub_bot.deliveries d;')

        before = sql('select json_agg(t order by id) from public.auctions t;')
        bids_before = sql('select json_agg(t order by id) from public.bids t;')
        pg_ctl('-l', str(Path(directory) / 'postgres.log'), '-m', 'fast', '-w', 'restart')
        assert sql('select json_agg(t order by id) from public.auctions t;') == before
        assert sql('select json_agg(t order by id) from public.bids t;') == bids_before
        assert sql('select json_agg(d order by id) from khub_bot.deliveries d;') == deliveries_before
        assert sql('select json_agg(c order by id) from khub_bot.closet_transfers c;') == closet_before
        assert financial_stats()['sales']==sold_report['sales']
        assert financial_stats()['donations']==sold_report['donations']
        assert ingest_donation()=='duplicate'
        assert ingest_donation(normal_donation)=='duplicate'
        assert ingest(corrected)=='duplicate'
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like 'policy-refund:%';")=='2'
        print('PASS: migrations, profile RLS, public reads, write restrictions, input validation, bids, concurrent bids, expiry, identity, registration conflict checks, lifecycle upgrades, cancellation/bid races, two-party completion, instant purchase validation/permissions/price caps/retries/races, lock-wait deadlines, KMail identity/activation/refunds/settlement/fees/funded purchase races/uncertain-send reconciliation, closet income accounting/protected escrow/reserves/package holds/fee collection/uncertain-move reconciliation, and database restart persistence')
    finally:
        if started:
            pg_ctl('-m', 'fast', '-w', 'stop')
