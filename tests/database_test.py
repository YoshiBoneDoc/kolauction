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

        before = sql('select json_agg(t order by id) from public.auctions t;')
        bids_before = sql('select json_agg(t order by id) from public.bids t;')
        pg_ctl('-l', str(Path(directory) / 'postgres.log'), '-m', 'fast', '-w', 'restart')
        assert sql('select json_agg(t order by id) from public.auctions t;') == before
        assert sql('select json_agg(t order by id) from public.bids t;') == bids_before
        print('PASS: migrations, profile RLS, public reads, write restrictions, input validation, bids, concurrent bids, expiry, identity, registration conflict checks, lifecycle upgrades, cancellation/bid races, two-party completion, instant purchase validation/permissions/price caps/retries/races, lock-wait deadlines, KMail identity/activation/refunds/settlement/fees/funded purchase races/uncertain-send reconciliation, and database restart persistence')
    finally:
        if started:
            pg_ctl('-m', 'fast', '-w', 'stop')
