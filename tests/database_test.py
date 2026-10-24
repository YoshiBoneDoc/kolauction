"""Exercise actual PostgreSQL functions, RLS, concurrency, and persistence.
Uses an isolated temporary database with a minimal Supabase Auth stub.
Run: python3 tests/database_test.py (requires PostgreSQL binaries).
"""
import concurrent.futures
import json
import re
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def migration_sql(name):
    matches=[p for p in [ROOT/'supabase/migrations'/name,ROOT/'supabase/migrations/queue'/name] if p.is_file()]
    if len(matches)!=1:
        raise ValueError(f'Expected one applied or queued migration named {name}; found {len(matches)}')
    return matches[0].read_text()

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
            sql(migration_sql(name))
        for uid, name in [(SELLER, 'Seller'), (BUYER, 'Buyer'), (OTHER, 'Other')]:
            metadata = json.dumps({'khub_username': name})
            sql(f"insert into auth.users (id, raw_user_meta_data, email) values ('{uid}', '{metadata}', '{name.lower()}@example.com');")

        sql(migration_sql('202610190002_registration_conflicts.sql'))
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
        sql(migration_sql('202610190001_auction_lifecycle.sql'))
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
        sql(migration_sql('202610190003_instant_purchase.sql'))
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
        sql(migration_sql('202610190004_kmail_escrow.sql'))
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
        sql(migration_sql('202610190005_auction_page_reads.sql'))
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
        sql(migration_sql('202610190006_friendly_bot_messages.sql'))
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
        sql(migration_sql('202610190007_short_auction_commands.sql'))
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
        sql(migration_sql('202610190008_donation_acknowledgments.sql'))
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
        sql(migration_sql('202610190009_normal_kmail_donations.sql'))
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
        sql(migration_sql('202610190010_donation_message_style.sql'))
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
        sql(migration_sql('202610190011_donation_message_wording.sql'))
        saved=json.loads(sql(f"select public.bot_lookup_delivery('{styled['id']}');",role='service_role'))
        assert saved['display_message']==styled['display_message'] and saved['display_footer']==styled['display_footer']
        revised_donation={**normal_donation,'id':'5012','raw':{'id':'5012','type':'normal','message':'DONATE'}}
        assert ingest_donation(revised_donation)=='accepted'
        revised=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert revised['display_message']=="Thanks so much for pitching in, we really appreciate your support! It’s players like you who make projects like kHub possible.\n\nRest assured, 100% of your donation will go toward keeping kHub running. Except for the part we spend on booze. That’s a business expense."
        assert revised['display_footer']=="\n*If this donation was sent in error, please KMail teres minor (#3552305) with the reference ID above."
        sql(f"select public.bot_ack_delivery('{revised['id']}','{revised['attempt']}',true,'fixture revised donation sent');",role='service_role')
        # Inbox retention and separately tracked manual-review notices.
        sql(migration_sql('202610190012_bot_mail_review.sql'))
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
        sql(migration_sql('202610190013_closet_income.sql'))
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
        sql(migration_sql('202610190014_auction_message_layout.sql'))
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
        sql(migration_sql('202610190017_financial_reports.sql'))
        early_donations=json.loads(sql("select public.bot_financial_history('donations',0,100);",role='service_role'))['records']
        assert not ({'8000','8001'} & {r['mail_id'] for r in early_donations})
        assert {'8002','8003'} <= {r['mail_id'] for r in early_donations}
        early_stats=json.loads(sql('select public.bot_financial_stats();',role='service_role'))
        sql(migration_sql('202610190015_invalid_mail_refunds.sql'))
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
        sql(migration_sql('202610190016_cancel_opened_package.sql'))
        sql(migration_sql('202610190017_financial_reports.sql'))
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
        # Cosmetic headings update all auction templates, preserving claimed retries.
        ingest(mail(9200,999,{'type':'bid','auction_id':held_bid},meat=4000))
        old_heading_delivery=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert re.search(r'\n-+\n',old_heading_delivery['display_message'])
        sql(f"select public.bot_ack_delivery('{old_heading_delivery['id']}','{old_heading_delivery['attempt']}',false,'fixture send uncertain');",role='service_role')
        def auction_templates():
            return json.loads(sql("select json_object_agg(d.id,khub_bot.friendly_message(d)) from khub_bot.deliveries d "
                "where d.auction_id is not null and (d.kind in ('sale_item','sale_meat','return_item') "
                "or d.dedupe_key like any(array['activated:%','bid-accepted:%','outbid:%','excess:%']));"))
        templates_before=auction_templates()
        frozen_deliveries=sql('select json_agg(d order by id) from khub_bot.deliveries d;')
        for _ in range(2):
            sql(migration_sql('202610190018_plain_auction_headings.sql'))
        assert sql('select json_agg(d order by id) from khub_bot.deliveries d;')==frozen_deliveries
        assert auction_templates()=={key:re.sub(r'(\nAuction #[0-9]+)\n-+\n',r'\1\n',body) for key,body in templates_before.items()}
        sql(f"select public.bot_reconcile_delivery('{old_heading_delivery['id']}',false,'Verified request rejected and assets never left.');",role='service_role')
        old_heading_retry=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert old_heading_retry['id']==old_heading_delivery['id']
        assert old_heading_retry['display_message']==old_heading_delivery['display_message']
        sql(f"select public.bot_ack_delivery('{old_heading_retry['id']}','{old_heading_retry['attempt']}',true,'fixture old message delivered');",role='service_role')
        plain_heading_deliveries=collect_messages()
        assert plain_heading_deliveries
        assert all(not re.search(r'\n-+\n',d['display_message']) for d in plain_heading_deliveries)
        assert all('Auction #' in d['display_message'] for d in plain_heading_deliveries)
        # Auth schema fields model Supabase's Admin API metadata contract. Account
        # creation/password API transport and lost acknowledgments have JS tests.
        sql("alter table auth.users add column raw_app_meta_data jsonb default '{}', add column banned_until timestamptz;")
        sql(migration_sql('202610190019_kmail_accounts.sql'))
        temp_password='Kh9!'+'A'*30
        def account_mail(mid,sid=101001,name='KoL Player',username=None,command='register',meat=0,items=None):
            payload=mail(mid,sid,{'type':command,**({'username':username} if username else {})},meat,items)
            payload['sender_name']=name
            payload['raw']={'id':str(mid),'fromid':str(sid),'fromname':name,'type':'normal','message':command.upper()}
            return payload
        def prepare_account(payload,password=temp_password,role='service_role',error=None):
            encoded=json.dumps(payload).replace("'","''")
            result=sql(f"select public.bot_prepare_account_mail('{encoded}','{password}');",role=role,error=error)
            return None if error else json.loads(result)
        request=account_mail(9400,name='New Player')
        job=prepare_account(request)
        assert job['state']=='pending' and job['username']=='New Player'
        # Reproduce GoTrue's real Admin API ordering: raw_app_meta_data is not
        # stamped until AFTER the initial INSERT. The old trigger rejects it.
        unstamped_insert=f"insert into auth.users(id,email,raw_app_meta_data) values('{job['user_id']}','{job['login_email']}','{{\"provider\":\"email\"}}');"
        sql(unstamped_insert,error='registered by KMail')
        sql(migration_sql('202610190021_auth_creation_order.sql'))
        # Fixed ID AND exact internal address must match the private reservation.
        sql(f"insert into auth.users(id,email) values('{job['user_id']}','wrong@example.com');",error='registered by KMail')
        wrong_stamp=json.dumps({'khub_account_job':'wrong-request'})
        sql(f"insert into auth.users(id,email,raw_app_meta_data) values('{job['user_id']}','{job['login_email']}','{wrong_stamp}');",error='stamp does not match')

        assert prepare_account(request,'Kh9!'+'B'*30)==job
        assert json.loads(sql('select public.bot_pending_account_requests();',role='service_role'))==[request]
        sql(f"select public.bot_finish_account_job('{job['mail_id']}');",role='service_role',error='not confirmed')
        # A public/client-created Auth user cannot bypass verified registration.
        sql("insert into auth.users(id,email,raw_user_meta_data) values(gen_random_uuid(),'bypass@example.com','{\"khub_username\":\"Bypass\"}');",error='registered by KMail')
        def provision(job):
            # Admin createUser first inserts provider metadata, then updates the
            # request stamp later in the same transaction. Profile creation must
            # succeed at INSERT, while finalization still refuses an absent stamp.
            metadata=json.dumps({'khub_account_job':job['mail_id']})
            sql(f"insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data,email_confirmed_at) values('{job['user_id']}','{job['login_email']}','{{\"khub_username\":\"Spoofed\"}}','{{\"provider\":\"email\"}}',now());")
            sql(f"select public.bot_finish_account_job('{job['mail_id']}');",role='service_role',error='not confirmed')
            sql(f"update auth.users set raw_app_meta_data=raw_app_meta_data||'{metadata}'::jsonb where id='{job['user_id']}';")
        provision(job)
        assert sql(f"select khub_username||':'||kol_player_id||':'||account_method from public.profiles where id='{job['user_id']}';")=='New Player:101001:kmail'
        assert sql("select public.khub_login_address(' new PLAYER ');",role='anon')==job['login_email']
        assert sql("select public.khub_login_address('Buyer');",role='anon')=='' # No personal email leak.
        sql(f"select public.bot_finish_account_job('{job['mail_id']}');",role='service_role')
        sql(f"select public.bot_finish_account_job('{job['mail_id']}');",role='service_role')
        assert sql("select count(*) from khub_bot.deliveries where receipt_id='9400';")=='1'
        assert sql("select temporary_password is null from khub_bot.account_jobs where mail_id='9400';")=='t'
        assert prepare_account(request)=={'state':'done'}
        assert cleanup('9400')==[]
        credential_delivery=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert credential_delivery['receipt_id']=='9400' and temp_password in credential_delivery['display_message']
        assert 'Username: New Player' in credential_delivery['display_message']
        sql(f"select public.bot_ack_delivery('{credential_delivery['id']}','{credential_delivery['attempt']}',false,'fixture response lost');",role='service_role')
        assert temp_password not in sql('select public.bot_inspect();',role='service_role')
        assert temp_password not in sql(f"select public.bot_lookup_delivery('{credential_delivery['delivery_reference']}');",role='service_role')
        sql(f"select public.bot_reconcile_delivery('{credential_delivery['id']}',true,'Verified credential sent-copy marker in game.');",role='service_role')
        assert temp_password not in sql("select row_to_json(d) from khub_bot.deliveries d where receipt_id='9400';")
        assert cleanup('9400')==['9400']
        assert prepare_account(account_mail(9401))=={'state':'done'}
        assert 'already has' in sql("select display_message from khub_bot.deliveries where receipt_id='9401';")
        # Recovery cannot choose another account: only the actual sender's linked ID.
        assert prepare_account(account_mail(9402,sid=101002,command='credentials'))=={'state':'done'}
        assert 'No kHub account is linked' in sql("select display_message from khub_bot.deliveries where receipt_id='9402';")
        assert prepare_account(account_mail(9403,command='credentials'))=={'state':'done'}
        assert 'five minutes' in sql("select display_message from khub_bot.deliveries where receipt_id='9403';")
        sql("update khub_bot.account_jobs set created_at=now()-interval '6 minutes' where mail_id='9400';")
        reset=prepare_account(account_mail(9404,command='credentials'),password='Kh9!'+'C'*30)
        assert reset['user_id']==job['user_id'] and reset['action']=='credentials'
        sql("select public.bot_finish_account_job('9404');",role='service_role',error='not confirmed')
        sql(f"update auth.users set raw_app_meta_data='{{\"khub_account_job\":\"9404\"}}' where id='{job['user_id']}';")
        sql("select public.bot_finish_account_job('9404');",role='service_role')
        assert sql("select count(*) from public.profiles where kol_player_id=101001;")=='1'
        assert 'previous password no longer works' in sql("select display_message from khub_bot.deliveries where receipt_id='9404';")
        collect_messages()
        sql(f"update auth.users set email='changed@example.com' where id='{job['user_id']}';",error='cannot be changed')
        sql(f"update public.profiles set khub_username='invalid@email' where id='{job['user_id']}';",job['user_id'],'authenticated',error='permission denied')
        sql(f"update public.profiles set is_banned=true where id='{job['user_id']}';")
        assert sql("select count(*) from khub_bot.account_bans where kol_player_id=101001 and active;")=='1'
        assert sql("select public.khub_login_address('New Player');",role='anon')==''
        assert prepare_account(account_mail(9406,command='credentials'))=={'state':'done'}
        assert 'restricted' in sql("select display_message from khub_bot.deliveries where receipt_id='9406';")
        # Already linked legacy accounts recover without SMTP, using their existing email login.
        legacy_job=prepare_account(account_mail(9407,sid=777,name='Seller',command='credentials'))
        assert legacy_job['user_id']==SELLER and legacy_job['login_email']=='seller@example.com'
        sql(f"update auth.users set raw_app_meta_data='{{\"khub_account_job\":\"9407\"}}' where id='{SELLER}';")
        sql("select public.bot_finish_account_job('9407');",role='service_role')
        assert 'Log in with: seller@example.com' in sql("select display_message from khub_bot.deliveries where receipt_id='9407';")
        # Attachments are refunded and cannot accidentally create/reset an account.
        assert prepare_account(account_mail(9405,sid=101005,meat=50,items=[{'id':1,'quantity':1}]))=={'state':'done'}
        assert sql("select count(*) from khub_bot.account_jobs where mail_id='9405';")=='0'
        assert sql("select sum(meat)||':'||sum(quantity) from khub_bot.deliveries where receipt_id='9405';")=='50:1'
        assert cleanup('9405')==[]
        # Ban checks cover player ID, actual KoL name and old Auth bans.
        sql("insert into khub_bot.account_bans(kol_player_id,reason) values(101006,'fixture ban');")
        sql("insert into khub_bot.account_bans(username,reason) values('ReservedBan','fixture name ban');")
        for i,payload in enumerate([account_mail(9410,sid=101006),
            account_mail(9411,sid=101007,name='ReservedBan'),
            account_mail(9412,sid=101008,name='reservedban')]):
            assert prepare_account(payload)=={'state':'done'}
            assert 'restricted' in sql(f"select display_message from khub_bot.deliveries where receipt_id='{9410+i}';")
        sql(f"update auth.users set banned_until=now()+interval '1 day' where id='{SELLER}';")
        assert prepare_account(account_mail(9413,sid=777,name='Seller'))=={'state':'done'}
        sql(f"update auth.users set banned_until=null where id='{SELLER}';")
        # A custom alias cannot override the authenticated sender's KoL name.
        assert prepare_account(account_mail(9414,sid=101014,username='Impersonated'))=={'state':'done'}
        assert 'without a username' in sql("select display_message from khub_bot.deliveries where receipt_id='9414';")
        assert sql("select count(*) from khub_bot.account_jobs where mail_id='9414';")=='0'
        # Real KoL names longer than the old 16-character alias limit are preserved.
        long_job=prepare_account(account_mail(9415,sid=101015,name='Actual Long KoL Character Name'))
        provision(long_job)
        sql("select public.bot_finish_account_job('9415');",role='service_role')
        assert sql("select khub_username from public.profiles where kol_player_id=101015;")=='Actual Long KoL Character Name'
        # Concurrent registration claims cannot reserve the same username twice.
        contenders=[account_mail(9420+i,sid=102000+i,name='RaceName') for i in range(2)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(prepare_account,contenders))
        assert sorted(r['state'] for r in results)==['done','pending']
        pending=next(r for r in results if r['state']=='pending')
        sql("update public.profiles set khub_username='RaceName' where id='"+BUYER+"';",BUYER,'authenticated',error='permission denied')
        provision(pending)
        sql(f"select public.bot_finish_account_job('{pending['mail_id']}');",role='service_role')
        assert sql("select count(*) from public.profiles where lower(khub_username)='racename';")=='1'
        # Existing sessions cannot write auctions/bids after an account ban.
        sql("insert into khub_bot.account_bans(kol_player_id,reason) values(999,'fixture restriction');")
        assert sql(f"select is_banned from public.profiles where id='{OTHER}';")=='t'
        sql("select public.create_auction('escrow item',2,100,24,null,null,1);",OTHER,'authenticated',error='restricted')
        assert 'restricted' in ingest(mail(9430,999,{'type':'bid','auction_id':held_bid},meat=5000))
        assert sql("select sum(meat) from khub_bot.deliveries where receipt_id='9430';")=='5000'
        for role in ['anon','authenticated']:
            prepare_account(account_mail(9440),role=role,error='permission denied')
            sql("select public.bot_check_account_job('9400');",role=role,error='permission denied')
            sql("select public.bot_finish_account_job('9400');",role=role,error='permission denied')
            sql('select public.bot_pending_account_requests();',role=role,error='permission denied')
            sql('select * from khub_bot.account_jobs;',role=role,error='permission denied')
            sql('select * from khub_bot.account_bans;',role=role,error='permission denied')
        collect_messages()
        suspended_request=account_mail(9450,sid=101050,name='LaterBanned')
        prepare_account(suspended_request)
        sql("insert into khub_bot.account_bans(kol_player_id,reason) values(101050,'Restricted while pending');")
        blocked_job=json.loads(sql("select public.bot_check_account_job('9450');",role='service_role'))
        assert blocked_job['state']=='done' and blocked_job['temporary_password'] is None
        assert sql("select count(*) from public.profiles where kol_player_id=101050;")=='0'
        collect_messages()
        resumable_request=account_mail(9451,sid=101051,name='ResumeAfterCrash')
        resumable_job=prepare_account(resumable_request)
        # Keep old/pending passwords intact while admitting short KMail-safe tokens.
        short_password='Kh9!Ab3Cd4Ef5Gh6'
        short_request=account_mail(9460,sid=101060,name='Short Password Player')
        prepare_account(short_request,password=short_password,error='strong temporary password')
        sql(migration_sql('202610190022_short_temporary_passwords.sql'))
        prepare_account(short_request,password='TooShort',error='strong temporary password')
        short_job=prepare_account(short_request,password=short_password)
        assert len(short_job['temporary_password'])==16
        assert short_job['temporary_password']==short_password
        assert prepare_account(short_request,password='Kh9!Xy7Zt8Uv9Wq0')==short_job
        provision(short_job)
        sql("select public.bot_finish_account_job('9460');",role='service_role')
        assert short_password in sql("select display_message from khub_bot.deliveries where receipt_id='9460';")
        assert prepare_account(resumable_request)==resumable_job
        collect_messages()
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
        # Public gallery exposes only explicitly published, active, reviewed bans.
        sql(migration_sql('202610190020_wall_of_shame.sql'))
        assert json.loads(sql('select public.khub_wall_of_shame();',role='anon'))=={'entries':[],'total':0}
        gallery_ban=sql("insert into khub_bot.account_bans(kol_player_id,reason) values(199001,'SECRET private evidence') returning id;")
        sql(f"insert into khub_bot.ban_publications(ban_id,kol_player_name,public_reason) values({gallery_ban},'Reviewed Player','Documented public reason');")
        for gallery_role in ['anon','authenticated']:
            public_gallery=json.loads(sql('select public.khub_wall_of_shame();',role=gallery_role))
            assert public_gallery['total']==1 and public_gallery['entries'][0]['kol_player_id']==199001
            assert 'SECRET' not in json.dumps(public_gallery) and 'ban_id' not in public_gallery['entries'][0]
            sql('select * from khub_bot.ban_publications;',role=gallery_role,error='permission denied')
            sql("insert into khub_bot.ban_publications(ban_id,kol_player_name,public_reason) values(1,'Forged','Forged');",role=gallery_role,error='permission denied')
            sql('select public.khub_wall_of_shame(-1,24);',role=gallery_role,error='Invalid gallery page')
        assert json.loads(sql('select public.khub_wall_of_shame(24,24);',role='anon'))['entries']==[]
        sql(f"update khub_bot.account_bans set active=false where id={gallery_ban};")
        assert json.loads(sql('select public.khub_wall_of_shame();',role='anon'))['total']==0
        sql(f"update khub_bot.account_bans set active=true where id={gallery_ban};")
        sql(f"update khub_bot.ban_publications set banned_at=now()-interval '2 days',expires_at=now()-interval '1 day' where ban_id={gallery_ban};")
        assert json.loads(sql('select public.khub_wall_of_shame();',role='anon'))['total']==0
        sql(f"update khub_bot.ban_publications set expires_at=now()+interval '1 day' where ban_id={gallery_ban};")
        assert json.loads(sql('select public.khub_wall_of_shame();',role='anon'))['total']==1
        sql(f"update khub_bot.ban_publications set published_at=now()+interval '1 day' where ban_id={gallery_ban};")
        assert json.loads(sql('select public.khub_wall_of_shame();',role='anon'))['total']==0
        closet_before=sql('select json_agg(c order by id) from khub_bot.closet_transfers c;')
        deliveries_before=sql('select json_agg(d order by id) from khub_bot.deliveries d;')

        before = sql('select json_agg(t order by id) from public.auctions t;')
        bids_before = sql('select json_agg(t order by id) from public.bids t;')
        pg_ctl('-l', str(Path(directory) / 'postgres.log'), '-m', 'fast', '-w', 'restart')
        assert sql('select json_agg(t order by id) from public.auctions t;') == before
        assert sql('select json_agg(t order by id) from public.bids t;') == bids_before
        assert sql('select json_agg(d order by id) from khub_bot.deliveries d;') == deliveries_before
        assert sql('select json_agg(c order by id) from khub_bot.closet_transfers c;') == closet_before
        assert json.loads(sql('select public.bot_pending_account_requests();',role='service_role'))==[resumable_request]
        assert prepare_account(resumable_request)==resumable_job
        assert financial_stats()['sales']==sold_report['sales']
        assert financial_stats()['donations']==sold_report['donations']
        assert ingest_donation()=='duplicate'
        assert ingest_donation(normal_donation)=='duplicate'
        assert ingest(corrected)=='duplicate'
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like 'policy-refund:%';")=='2'
        # Public seller profiles must not expose buyers through raw tables or RPCs.
        untouched_auctions=sql('select json_agg(a order by id) from public.auctions a;')
        untouched_bids=sql('select json_agg(b order by id) from public.bids b;')
        untouched_deliveries=sql('select json_agg(d order by id) from khub_bot.deliveries d;')
        sql(migration_sql('202610200023_public_seller_profiles.sql'))
        assert sql('select json_agg(a order by id) from public.auctions a;')==untouched_auctions
        assert sql('select json_agg(b order by id) from public.bids b;')==untouched_bids
        assert sql('select json_agg(d order by id) from khub_bot.deliveries d;')==untouched_deliveries

        def privacy_lot(status='active',escrow=False):
            closed=status in ('awaiting_trade','completed')
            return sql(f"""insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,
                end_time,current_bid,highest_bidder_id,highest_bidder_username,escrow_mode,item_id,seller_kol_id,
                item_escrowed_at,status,winner_id,winner_username,final_price,finalized_at,
                settled_at,seller_confirmed_at,buyer_confirmed_at,completed_at)
                values('{SELLER}','Seller','privacy fixture',2,100,24,now()+interval '1 day',300,'{BUYER}','Buyer',
                {str(escrow).lower()},1,777,case when {str(escrow).lower()} and '{status}'<>'pending_escrow' then now() end,
                '{status}',{repr(BUYER) if closed else 'null'},{repr('Buyer') if closed else 'null'},
                {'300' if closed else 'null'},{'now()' if closed else 'null'},
                {'now()' if status=='completed' and escrow else 'null'},
                {'now()' if status=='completed' and not escrow else 'null'},
                {'now()' if status=='completed' and not escrow else 'null'},
                {'now()' if status=='completed' else 'null'}) returning id;""")

        open_private=privacy_lot()
        for bidder,amount in [(BUYER,100),(OTHER,200),(BUYER,300)]:
            sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{open_private}','{bidder}','{'Buyer' if bidder==BUYER else 'Other'}',{amount});")
        for uid,role in [(None,'anon'),(SELLER,'authenticated'),(OTHER,'authenticated')]:
            page=read_page('detail',uid,role,id=open_private)
            row=page['rows'][0]
            assert row['seller_username']=='Seller' and row['seller_id']==SELLER
            assert row['highest_bidder_id'] is None and row['highest_bidder_username']=='Bidder 1'
            assert row['settlement_contacts'] is None and row['has_winner'] is False
            assert 'seller_kol_id' not in row and 'highest_bidder_kol_id' not in row
            assert page['bids'][0]['bidder_username']==page['bids'][2]['bidder_username']=='Bidder 1'
            assert page['bids'][0]['bidder_id'] is None and page['bids'][2]['bidder_id'] is None
            assert page['bids'][1]['bidder_username']==('You' if uid==OTHER else 'Bidder 2')
        own_page=read_page('detail',BUYER,'authenticated',id=open_private)
        assert own_page['rows'][0]['highest_bidder_id']==BUYER
        assert own_page['rows'][0]['highest_bidder_username']=='You'
        assert [b['bidder_username'] for b in own_page['bids']]==['You','Bidder 2','You']
        assert all(b['bidder_id'] in (None,BUYER) for b in own_page['bids'])
        # A passed timer alone never reveals the winning identity.
        sql(f"update public.auctions set created_at=now()-interval '2 days',end_time=now()-interval '1 hour' where id='{open_private}';")
        assert read_page('detail',SELLER,'authenticated',id=open_private)['rows'][0]['settlement_contacts'] is None
        sql(f"update public.auctions set end_time=now()+interval '1 day' where id='{open_private}';")
        sql(f"select public.place_bid('{open_private}',400);",SELLER,'authenticated',error='own auction')

        direct_private=privacy_lot('awaiting_trade')
        sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{direct_private}','{BUYER}','Buyer',300);")
        for uid in [SELLER,BUYER]:
            row=read_page('detail',uid,'authenticated',id=direct_private)['rows'][0]
            assert row['winner_id']==BUYER and row['winner_username']=='Buyer'
            assert row['settlement_contacts']['buyer']['username']==sql(f"select khub_username from public.profiles where id='{BUYER}';")
            assert row['settlement_contacts']['buyer']['kol_player_id']==888
            assert row['settlement_contacts']['seller']['kol_player_id']==777
            assert 'email' not in json.dumps(row['settlement_contacts'])
        for uid,role in [(None,'anon'),(OTHER,'authenticated')]:
            row=read_page('detail',uid,role,id=direct_private)['rows'][0]
            assert row['has_winner'] is True and row['winner_id'] is None
            assert row['winner_username']=='Bidder 1' and row['settlement_contacts'] is None
        finished_private=privacy_lot('completed',True)
        assert read_page('detail',SELLER,'authenticated',id=finished_private)['rows'][0]['settlement_contacts'] is None
        assert read_page('detail',SELLER,'authenticated',id=finished_private)['rows'][0]['winner_id'] is None
        pending_private=privacy_lot('pending_escrow',True)
        assert read_page('detail',id=pending_private)['rows']==[]
        assert read_page('detail',BUYER,'authenticated',id=pending_private)['rows']==[]
        assert len(read_page('detail',SELLER,'authenticated',id=pending_private)['rows'])==1

        for role in ['anon','authenticated']:
            sql('select * from public.auctions;',role=role,error='permission denied')
            sql('select bidder_id,bidder_username from public.bids;',role=role,error='permission denied')
            sql('select highest_bidder_kol_id from public.auctions;',role=role,error='permission denied')
            sql('select khub_bot.public_auction(null::public.auctions,0,null,null);',role=role,error='permission denied')
            sql(f"select public.finalize_auction('{open_private}');",role=role,error='permission denied')
        assert int(sql('select count(*) from public.auctions;',role='service_role'))>0
        assert int(sql('select count(*) from public.bids;',role='service_role'))>0
        personal=read_page('profile',BUYER,'authenticated')
        assert all(b['bidder_id']==BUYER and b['bidder_username']=='You' for b in personal['bids'])
        public_seller=read_page('seller',id=SELLER,status='all')
        assert public_seller['seller']['username']=='Seller'
        assert pending_private not in [a['id'] for a in public_seller['rows']]
        assert all(a['seller_id']==SELLER and a['status']!='pending_escrow' for a in public_seller['rows'])
        assert public_seller['bids']==[]
        assert int(public_seller['seller']['stats']['escrow_sales'])==int(sql(f"select count(*) from public.auctions where seller_id='{SELLER}' and status='completed' and escrow_mode and winner_id is not null;"))
        assert int(public_seller['seller']['stats']['escrow_value'])==int(sql(f"select coalesce(sum(final_price),0) from public.auctions where seller_id='{SELLER}' and status='completed' and escrow_mode and winner_id is not null;"))
        assert int(public_seller['seller']['stats']['legacy_sales'])==int(sql(f"select count(*) from public.auctions where seller_id='{SELLER}' and status='completed' and not escrow_mode and winner_id is not null;"))
        assert read_page('seller',id='00000000-0000-0000-0000-000000009999')['seller'] is None
        sql(f"""insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,end_time)
            select '{SELLER}','Seller','seller pagination fixture '||n,1,n,24,now()+interval '1 day' from generate_series(1,30) n;""")
        seller_first=read_page('seller',id=SELLER,search='seller pagination fixture',sort='price-asc')
        seller_second=read_page('seller',id=SELLER,search='seller pagination fixture',sort='price-asc',page=2)
        assert seller_first['total']==30 and len(seller_first['rows'])==24 and len(seller_second['rows'])==6
        assert [a['min_bid_meat'] for a in seller_first['rows']+seller_second['rows']]==list(range(1,31))
        assert read_page('seller',id=SELLER,search='%',status='all')['total']==0
        pg_ctl('-l',str(Path(directory)/'postgres.log'),'-m','fast','-w','restart')
        assert read_page('detail',id=direct_private)['rows'][0]['winner_id'] is None
        assert read_page('detail',SELLER,'authenticated',id=direct_private)['rows'][0]['winner_id']==BUYER
        # Optional escrow is additive: old state and obligations must be byte-for-byte unchanged.
        escrow_before=sql('select json_agg(a order by id) from public.auctions a where escrow_mode;')
        obligations_before=sql('select json_agg(d order by id) from khub_bot.deliveries d;')
        sql(migration_sql('202610200024_optional_escrow.sql'))
        assert sql('select json_agg(a order by id) from public.auctions a where escrow_mode;')==escrow_before
        assert sql('select json_agg(d order by id) from khub_bot.deliveries d;')==obligations_before
        def direct_create(price='null',uid=SELLER,error=None):
            return sql(f"select public.create_auction('escrow item',2,100,24,null,{price},1,false);",uid,'authenticated',error=error)
        def pending_trades(uid,page=1,role='authenticated'):
            return json.loads(sql(f'select public.read_pending_trades({page});',uid,role))
        competitor=long_job['user_id']
        direct=direct_create()
        assert sql(f"select status||':'||fee_bps||':'||start_on_deposit||':'||(item_escrowed_at is null) from public.auctions where id='{direct}';")=='active:0:false:true'
        assert read_page('detail',id=direct)['rows'][0]['escrow_mode'] is False
        assert read_page('detail',id=direct)['rows'][0]['settlement_contacts'] is None
        # Omitted argument still creates escrow, with the current stored fee.
        default_escrow=escrow_create()
        assert sql(f"select status||':'||fee_bps from public.auctions where id='{default_escrow}';")=='pending_escrow:750'
        sql(f"select public.place_bid('{default_escrow}',100);",BUYER,'authenticated',error='KMail')
        sql(f"select public.purchase_auction('{default_escrow}');",BUYER,'authenticated',error='KMail')
        sql(f"select public.confirm_auction_trade('{default_escrow}');",SELLER,'authenticated',error='bot')
        sql(f"select public.place_bid('{direct}',100);",SELLER,'authenticated',error='own auction')
        sql(f"select public.purchase_auction('{direct}');",SELLER,'authenticated',error='own auction')
        sql(f"select public.place_bid('{direct}',100);",OTHER,'authenticated',error='restricted')
        direct_create(uid=OTHER,error='restricted')
        # A linked number without verified ownership is insufficient.
        sql(f"update public.profiles set kol_verified_at=null where id='{competitor}';")
        sql(f"select public.place_bid('{direct}',100);",competitor,'authenticated',error='Verify your KoL')
        direct_create(uid=competitor,error='Verify your KoL')
        sql(f"update public.profiles set kol_verified_at=now() where id='{competitor}';")
        sql(f"select public.place_bid('{direct}',100);",BUYER,'authenticated')
        sql(f"select public.place_bid('{direct}',100);",competitor,'authenticated',error='exceed')
        sql(f"select public.cancel_auction('{direct}');",SELLER,'authenticated',error='with bids')
        assert read_page('detail',SELLER,'authenticated',id=direct)['rows'][0]['highest_bidder_id'] is None
        sql(f"update public.auctions set escrow_mode=true where id='{direct}';",error='fixed')
        sql(f"update public.auctions set escrow_mode=false where id='{default_escrow}';",error='fixed')
        sql(f"update public.auctions set fee_bps=900 where id='{default_escrow}';",error='fixed')
        sql(f"select public.confirm_auction_trade('{direct}');",SELLER,'authenticated',error='ended auction')
        sql(f"update public.auctions set created_at=now()-interval '2 days',end_time=now()-interval '1 hour' where id='{direct}';")
        assert read_page('detail',SELLER,'authenticated',id=direct)['rows'][0]['settlement_contacts'] is None
        assert direct not in [a['id'] for a in pending_trades(SELLER)['rows']]
        sql('select public.finalize_expired_auctions();',role='anon')
        assert sql(f"select status||':'||final_price from public.auctions where id='{direct}';")=='awaiting_trade:100'
        sql(f"select public.place_bid('{direct}',200);",competitor,'authenticated',error='ended')
        sql(f"update public.auctions set final_price=200 where id='{direct}';",error='fixed winner')
        for uid in [SELLER,BUYER]:
            trade=next(a for a in pending_trades(uid)['rows'] if a['id']==direct)
            assert trade['settlement_contacts']['buyer']['kol_player_id']==888
            assert trade['settlement_contacts']['seller']['kol_player_id']==777
        assert direct not in [a['id'] for a in pending_trades(competitor)['rows']]
        for uid,role in [(None,'anon'),(competitor,'authenticated')]:
            trade=read_page('detail',uid,role,id=direct)['rows'][0]
            assert trade['winner_id'] is None and trade['winner_username']=='Bidder 1'
            assert trade['settlement_contacts'] is None
        sql(f"select public.confirm_auction_trade('{direct}');",competitor,'authenticated',error='Only the seller')
        sql(f"select public.confirm_auction_trade('{direct}');",SELLER,'authenticated')
        stamp=sql(f"select seller_confirmed_at from public.auctions where id='{direct}';")
        sql(f"select public.confirm_auction_trade('{direct}');",SELLER,'authenticated')
        assert sql(f"select seller_confirmed_at from public.auctions where id='{direct}';")==stamp
        assert sql(f"select status from public.auctions where id='{direct}';")=='awaiting_trade'
        assert direct in [a['id'] for a in pending_trades(SELLER)['rows']]
        sql(f"select public.confirm_auction_trade('{direct}');",BUYER,'authenticated')
        assert sql(f"select status from public.auctions where id='{direct}';")=='completed'
        assert direct not in [a['id'] for a in pending_trades(SELLER)['rows']]
        assert direct not in [a['id'] for a in pending_trades(BUYER)['rows']]
        completed=sql(f"select row_to_json(a) from public.auctions a where id='{direct}';")
        sql(f"select public.confirm_auction_trade('{direct}');",BUYER,'authenticated')
        assert sql(f"select row_to_json(a) from public.auctions a where id='{direct}';")==completed
        assert read_page('detail',id=direct)['rows'][0]['winner_id'] is None
        # Instant purchase and competing requests freeze exactly one winner/bid.
        instant=direct_create('500')
        sql(f"select public.place_bid('{instant}',900);",BUYER,'authenticated')
        sql(f"select public.purchase_auction('{instant}');",BUYER,'authenticated')
        assert sql(f"select status||':'||final_price||':'||current_bid from public.auctions where id='{instant}';")=='awaiting_trade:500:500'
        assert sql(f"select count(*) from public.bids where auction_id='{instant}';")=='1'
        sql(f"select public.purchase_auction('{instant}');",competitor,'authenticated',error='ended')
        race=direct_create('500')
        def race_purchase(uid):
            try:
                sql(f"select public.purchase_auction('{race}');",uid,'authenticated')
                return True
            except AssertionError as failure:
                assert 'ended' in str(failure)
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            assert sum(pool.map(race_purchase,[BUYER,competitor]))==1
        assert sql(f"select count(*) from public.bids where auction_id='{race}';")=='1'
        # Unbid auctions close as unsold, never as a failed or completed trade.
        unsold=direct_create()
        sql(f"update public.auctions set created_at=now()-interval '2 days',end_time=now()-interval '1 hour' where id='{unsold}';")
        sql('select public.finalize_expired_auctions();',role='anon')
        assert sql(f"select status from public.auctions where id='{unsold}';")=='ended_no_bids'
        cancelled=direct_create()
        sql(f"select public.cancel_auction('{cancelled}');",SELLER,'authenticated')
        assert sql(f"select status from public.auctions where id='{cancelled}';")=='cancelled'
        # Pagination includes every pending trade, even those the viewer already confirmed.
        for n in range(13):
            trade=direct_create('500')
            sql(f"select public.purchase_auction('{trade}');",BUYER,'authenticated')
        pages=[pending_trades(SELLER,p) for p in [1,2]]
        assert pages[0]['total']==pages[1]['total'] and pages[0]['total']>12
        assert len(pages[0]['rows'])==12
        assert len({a['id'] for page in pages for a in page['rows']})==pages[0]['total']
        sql('select public.read_pending_trades();',role='anon',error='permission denied')
        assert pending_trades(None)['rows']==[]
        sql('select khub_bot.require_verified_trader();',BUYER,'authenticated',error='permission denied')
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id in ('{direct}','{instant}','{race}');")=='0'
        assert sql('select json_agg(d order by id) from khub_bot.deliveries d;')==obligations_before
        # Mail cannot accidentally fund or deposit a direct auction; attachments are refunded.
        direct_mail=direct_create()
        assert 'escrow' in ingest(mail(9600,888,{'type':'bid','auction_id':direct_mail},meat=200)).lower()
        assert sql("select sum(meat) from khub_bot.deliveries where receipt_id='9600';")=='200'
        assert sql(f"select current_bid from public.auctions where id='{direct_mail}';")=='0'
        assert 'escrow' in ingest(mail(9601,777,{'type':'list','auction_id':direct_mail},items=[{'id':1,'quantity':2}])).lower()
        assert sql("select sum(quantity) from khub_bot.deliveries where receipt_id='9601';")=='2'
        # Escrow still activates and settles through the existing bot RPCs after 024.
        assert ingest(mail(9602,777,{'type':'list','auction_id':default_escrow},items=[{'id':1,'quantity':2}]))=='accepted'
        assert sql(f"select status from public.auctions where id='{default_escrow}';")=='active'
        assert ingest(mail(9603,888,{'type':'bid','auction_id':default_escrow},meat=500))=='accepted'
        expire(default_escrow)
        sql('select public.bot_tick();',role='service_role')
        assert sql(f"select status||':'||fee_meat from public.auctions where id='{default_escrow}';")=='settling:37'
        assert sql(f"select sum(meat) from khub_bot.deliveries where auction_id='{default_escrow}' and kind='sale_meat';")=='463'
        assert sql(f"select sum(quantity) from khub_bot.deliveries where auction_id='{default_escrow}' and kind='sale_item';")=='2'
        assert read_page('detail',SELLER,'authenticated',id=default_escrow)['rows'][0]['settlement_contacts'] is None
        unfinished_closet=json.loads(sql("select coalesce(json_agg(id),'[]') from khub_bot.closet_transfers where state in ('moving','unknown');"))
        if unfinished_closet:
            sql('select public.bot_claim_delivery(2);',role='service_role',error='Uncertain closet transfer')
            # Fixture-only recovery: this isolated harness never makes KoL requests.
            # Use the audited API; do not bypass the claim guard by editing states.
            for transfer in unfinished_closet:
                sql(f"select public.bot_reconcile_closet_transfer('{transfer}',false,'Isolated fixture evidence: no external closet request was executed for this unfinished claim.');",role='service_role')
        collect_messages()
        sql('select public.bot_tick();',role='service_role')
        assert sql(f"select status from public.auctions where id='{default_escrow}';")=='completed'
        pg_ctl('-l',str(Path(directory)/'postgres.log'),'-m','fast','-w','restart')
        assert sql(f"select row_to_json(a) from public.auctions a where id='{direct}';")==completed
        assert read_page('detail',id=direct)['rows'][0]['settlement_contacts'] is None
        assert pending_trades(SELLER)['total']==pages[0]['total']
        # Remove fixed price caps without changing any historical records/obligations.
        price_auctions_before=sql('select json_agg(a order by id) from public.auctions a;')
        price_deliveries_before=sql('select json_agg(d order by id) from khub_bot.deliveries d;')
        price_closet_before=sql('select json_agg(c order by id) from khub_bot.closet_transfers c;')
        sql(migration_sql('202610200025_auction_price_limits.sql'))
        assert sql('select json_agg(a order by id) from public.auctions a;')==price_auctions_before
        assert sql('select json_agg(d order by id) from khub_bot.deliveries d;')==price_deliveries_before
        assert sql('select json_agg(c order by id) from khub_bot.closet_transfers c;')==price_closet_before
        high_direct=sql("select public.create_auction('escrow item',2,50000000000,24,null,60000000000,1,false);",SELLER,'authenticated')
        sql(f"select public.place_bid('{high_direct}',50000000001);",BUYER,'authenticated')
        assert read_page('detail',id=high_direct)['rows'][0]['current_bid']==50000000001
        sql(f"select public.purchase_auction('{high_direct}');",competitor,'authenticated')
        assert sql(f"select final_price from public.auctions where id='{high_direct}';")=='60000000000'
        assert read_page('detail',id=high_direct)['rows'][0]['winner_id'] is None
        sql(f"select public.confirm_auction_trade('{high_direct}');",SELLER,'authenticated')
        sql(f"select public.confirm_auction_trade('{high_direct}');",competitor,'authenticated')
        assert sql(f"select status from public.auctions where id='{high_direct}';")=='completed'
        precision_lot=direct_create('9007199254740991')
        sql(f"select public.place_bid('{precision_lot}',9007199254740992);",BUYER,'authenticated',error='represented exactly')
        sql(f"select public.purchase_auction('{precision_lot}');",BUYER,'authenticated')
        assert read_page('detail',id=precision_lot)['rows'][0]['final_price']==9007199254740991
        sql("select public.create_auction('escrow item',2,9007199254740992,24,null,null,1,false);",SELLER,'authenticated',error='check constraint')
        high_escrow=escrow_create('60000000000')
        assert ingest(mail(9700,777,{'type':'list','auction_id':high_escrow},items=[{'id':1,'quantity':2}]))=='accepted'
        assert ingest(mail(9701,888,{'type':'bid','auction_id':high_escrow},meat=60000000000))=='accepted'
        assert sql(f"select status||':'||final_price||':'||fee_meat from public.auctions where id='{high_escrow}';")=='settling:60000000000:4500000000'
        assert sql(f"select sum(meat) from khub_bot.deliveries where auction_id='{high_escrow}' and kind='sale_meat';")=='55500000000'
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{high_escrow}' and meat>1000000000;")=='0'
        # Commission math must not overflow bigint when a large sale uses 100% fee.
        sql('update khub_bot.settings set fee_bps=10000;')
        overflow_fee=escrow_create('1000000000000000')
        sql('update khub_bot.settings set fee_bps=750;')
        assert ingest(mail(9702,777,{'type':'list','auction_id':overflow_fee},items=[{'id':1,'quantity':2}]))=='accepted'
        assert ingest(mail(9703,888,{'type':'bid','auction_id':overflow_fee},meat=1000000000000000))=='accepted'
        assert sql(f"select fee_meat from public.auctions where id='{overflow_fee}';")=='1000000000000000'
        assert '20 billion' not in sql("select khub_bot.friendly_reason('Send the full bid, meeting the minimum and exceeding the current bid.');")
        for role in ['anon','authenticated']:
            sql(f"select public.legacy_place_bid('{precision_lot}',1);",role=role,error='permission denied')
            sql("select khub_bot.ingest_mail_before_invalid_refunds('{}');",role=role,error='permission denied')
        assert ingest(mail(9701,888,{'type':'bid','auction_id':high_escrow},meat=60000000000))=='duplicate'
        # Private bug reports: transactional storage + durable, zero-asset KMail copies.
        from uuid import uuid4
        bugs_old_auctions=sql('select json_agg(a order by id) from public.auctions a;')
        bugs_old_deliveries=sql('select json_agg(d order by id) from khub_bot.deliveries d;')
        sql(migration_sql('202610200026_bug_reports.sql'))
        assert sql('select json_agg(a order by id) from public.auctions a;')==bugs_old_auctions
        assert sql('select json_agg(d order by id) from khub_bot.deliveries d;')==bugs_old_deliveries
        def literal(value): return "'"+value.replace("'","''")+"'"
        def report(request_id,body,uid=SELLER,error=None):
            raw=sql(f"select public.submit_bug_report('{request_id}',{literal(body)});",uid,'authenticated',error=error)
            return None if error else json.loads(raw)
        def inbox(uid,status='open',page=1,error=None):
            raw=sql(f"select public.read_bug_report_inbox('{status}',{page});",uid,'authenticated',error=error)
            return None if error else json.loads(raw)
        owner_job=prepare_account(account_mail(9800,sid=3552305,name='teres Minor'))
        provision(owner_job)
        owner_id=owner_job['user_id']
        assert sql('select public.khub_is_administrator();',owner_id,'authenticated')=='t'
        assert sql('select count(*) from khub_bot.administrators;')=='0'
        for uid in [SELLER,BUYER,competitor,OTHER]:
            assert sql('select public.khub_is_administrator();',uid,'authenticated')=='f'
            inbox(uid,error='Administrator access required')
        # A claimed username or an unverified owner ID is not administrator authority.
        sql(f"update public.profiles set kol_verified_at=null where id='{owner_id}';")
        assert sql('select public.khub_is_administrator();',owner_id,'authenticated')=='f'
        sql(f"update public.profiles set kol_verified_at=now() where id='{owner_id}';")
        for role in ['anon','authenticated']:
            sql('select * from khub_bot.bug_reports;',role=role,error='permission denied')
            sql('select * from khub_bot.administrators;',role=role,error='permission denied')
            sql('select * from khub_bot.bug_report_activity;',role=role,error='permission denied')
            sql('select khub_bot.is_administrator(null);',role=role,error='permission denied')
            sql(f"insert into khub_bot.administrators(user_id,note) values('{SELLER}','self promotion');",SELLER,role,error='permission denied')
        sql("select public.submit_bug_report(gen_random_uuid(),'Anonymous bug report');",role='anon',error='permission denied')
        report(str(uuid4()),'Restricted account report',OTHER,error='restricted')
        report(str(uuid4()),'short',error='10 to 2,000')
        report(str(uuid4()),'x'*2001,error='10 to 2,000')
        sql(f"update public.profiles set kol_verified_at=null where id='{competitor}';")
        report(str(uuid4()),'Unverified reporter test',competitor,error='Verify your KoL')
        sql(f"update public.profiles set kol_verified_at=now() where id='{competitor}';")
        first_bug=str(uuid4()); first_body='The listing preview lost the item selection.'
        liabilities_before_reports=sql('select public.bot_liabilities();',role='service_role')
        saved=report(first_bug,first_body)
        assert re.fullmatch(r'B-[0-9]+',saved['reference'])
        assert report(first_bug,first_body)==saved
        assert sql(f"select count(*) from khub_bot.bug_report_deliveries where report_id='{first_bug}';")=='1'
        report(first_bug,'A different body cannot replace the original.',error='cannot be reused')
        report(first_bug,first_body,BUYER,error='cannot be reused')
        report(str(uuid4()),'A second report too soon.',error='wait a minute')
        assert sql(f"select body from khub_bot.bug_reports where id='{first_bug}';")==first_body
        long_bug=str(uuid4()); long_body='<>&'*600
        report(long_bug,long_body,BUYER)
        bodies=json.loads(sql(f"select json_agg(d.display_message order by split_part(d.dedupe_key,':',3)::integer) from khub_bot.bug_report_deliveries l join khub_bot.deliveries d on d.id=l.delivery_id where l.report_id='{long_bug}';"))
        assert len(bodies)>1 and all(len(body)<1700 for body in bodies)
        assert ''.join(body.split('\n\n')[1] for body in bodies)=='&lt;&gt;&amp;'*600
        assert all('<>' not in body for body in bodies)
        assert sql('select public.bot_liabilities();',role='service_role')==liabilities_before_reports
        assert sql("select count(*) from khub_bot.bug_report_deliveries l join khub_bot.deliveries d on d.id=l.delivery_id where recipient_id<>3552305 or kind<>'notice' or meat<>0 or item_id is not null or quantity<>0 or auction_id is not null or receipt_id is not null;")=='0'
        # Concurrent retries insert exactly one report and one set of notifications.
        concurrent_bug=str(uuid4()); concurrent_body='Concurrent submit lost its acknowledgment.'
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            duplicate_results=list(pool.map(lambda _:report(concurrent_bug,concurrent_body,competitor),range(2)))
        assert duplicate_results[0]==duplicate_results[1]
        assert sql(f"select count(*) from khub_bot.bug_report_deliveries where report_id='{concurrent_bug}';")=='1'
        assert inbox(owner_id)['total']==3
        assert next(r for r in inbox(owner_id)['reports'] if r['id']==first_bug)['notification']=='queued'
        sql(f"select public.set_bug_report_status('{first_bug}','resolved');",BUYER,'authenticated',error='Administrator access required')
        sql(f"select public.set_bug_report_status('{first_bug}','resolved');",owner_id,'authenticated')
        sql(f"select public.set_bug_report_status('{first_bug}','resolved');",owner_id,'authenticated')
        assert inbox(owner_id,'resolved')['total']==1
        assert sql(f"select count(*) from khub_bot.bug_report_activity where report_id='{first_bug}';")=='1'
        sql(f"select public.set_bug_report_status('{first_bug}','open');",owner_id,'authenticated')
        assert sql(f"select count(*) from khub_bot.bug_report_activity where report_id='{first_bug}';")=='2'
        # Explicit grants work, revocation takes effect immediately, bans override grants.
        sql(f"insert into khub_bot.administrators(user_id,note) values('{competitor}','Isolated staff fixture'),('{OTHER}','Banned staff fixture');")
        assert sql('select public.khub_is_administrator();',competitor,'authenticated')=='t'
        assert inbox(competitor)['total']==3
        assert sql('select public.khub_is_administrator();',OTHER,'authenticated')=='f'
        sql(f"delete from khub_bot.administrators where user_id='{competitor}';")
        inbox(competitor,error='Administrator access required')
        # Exercise the existing claim/ack path, including durable uncertain sends.
        # Give NEW report notices priority within this fixture; leave old deliveries alone.
        sql(f"update khub_bot.deliveries d set created_at='1970-01-01' where id in(select delivery_id from khub_bot.bug_report_deliveries where report_id='{first_bug}');")
        notice=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert notice['recipient_id']==3552305 and notice['meat']==0 and notice['kind']=='notice'
        assert first_body in notice['display_message'] and notice['delivery_reference'].startswith('D-')
        sql(f"select public.bot_ack_delivery('{notice['id']}','{notice['attempt']}',false,'Isolated fixture: uncertain acknowledgment, no external request.');",role='service_role')
        assert next(r for r in inbox(owner_id)['reports'] if r['id']==first_bug)['notification']=='needs_review'
        frozen=sql(f"select display_message from khub_bot.deliveries where id='{notice['id']}';")
        pg_ctl('-l',str(Path(directory)/'postgres.log'),'-m','fast','-w','restart')
        sql('select public.bot_claim_delivery(2);',role='service_role',error='Uncertain delivery')
        assert report(first_bug,first_body)==saved
        assert sql(f"select display_message from khub_bot.deliveries where id='{notice['id']}';")==frozen
        sql(f"select public.bot_reconcile_delivery('{notice['id']}',false,'Fixture evidence: no external request was made; a resend is safe in this isolated test.');",role='service_role')
        retry=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert retry['id']==notice['id'] and retry['display_message']==frozen
        sql(f"select public.bot_ack_delivery('{retry['id']}','{retry['attempt']}',true,'Fixture acknowledgment only; no KMail was sent.');",role='service_role')
        assert next(r for r in inbox(owner_id)['reports'] if r['id']==first_bug)['notification']=='sent'
        # Hourly limit supplements the one-minute cooldown.
        for n in range(4):
            sql(f"update khub_bot.bug_reports set created_at=now()-interval '61 seconds' where reporter_id='{SELLER}';")
            report(str(uuid4()),'Distinct fixture report number '+str(n))
        sql(f"update khub_bot.bug_reports set created_at=now()-interval '61 seconds' where reporter_id='{SELLER}';")
        report(str(uuid4()),'A sixth report within an hour.',error='several reports')
        # Seed old fixture records for pagination without creating more outgoing mail.
        sql(f"insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,created_at) select gen_random_uuid(),'{SELLER}','Seller',777,'Pagination fixture '||n,now()-interval '2 days' from generate_series(1,24)n;")
        first_page=inbox(owner_id,'all',1); second_page=inbox(owner_id,'all',2)
        assert first_page['total']==second_page['total']==31
        assert len(first_page['reports'])==20 and len(second_page['reports'])==11
        assert len({r['id'] for r in first_page['reports']+second_page['reports']})==31
        assert all('reporter_id' not in r for r in first_page['reports'])
        # No report is discoverable through the public auction/profile reader.
        assert 'Distinct fixture report' not in json.dumps(read_page('seller',id=SELLER,status='all'))
        # Login prefix is separate from the public profile name; durable mail is immutable.
        prefix_job=prepare_account(account_mail(99001,sid=299001,name='Exact Player'))
        existing_mail=sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')
        existing_names=sql('select jsonb_agg(jsonb_build_array(id,khub_username) order by id) from public.profiles;')
        sql(migration_sql('202610200027_prefixed_login_names.sql'))
        assert sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')==existing_mail
        assert sql('select jsonb_agg(jsonb_build_array(id,khub_username) order by id) from public.profiles;')==existing_names
        provision(prefix_job)
        sql("select public.bot_finish_account_job('99001');",role='service_role')
        prefix_body=sql("select display_message from khub_bot.deliveries where receipt_id='99001';")
        assert 'kHub Username: KH_Exact Player' in prefix_body
        assert 'Log in with:' not in prefix_body and '\nUsername:' not in prefix_body
        for role in ['anon','authenticated']:
            assert sql("select public.khub_login_address(' kh_exact player ');",role=role)==prefix_job['login_email']
            assert sql("select public.khub_login_address('Exact Player');",role=role)==''
            assert sql("select public.khub_login_address('KH_Seller');",role=role)=='' # no legacy personal email disclosure
            sql("select public.bot_finish_account_job('99001');",role=role,error='permission denied')
        # A real KoL name starting KH_ must get its own additional login prefix.
        double_job=prepare_account(account_mail(99002,sid=299002,name='KH_Exact Player'))
        provision(double_job)
        sql("select public.bot_finish_account_job('99002');",role='service_role')
        assert sql("select public.khub_login_address('KH_KH_Exact Player');",role='anon')==double_job['login_email']
        assert sql("select public.khub_login_address('KH_Exact Player');",role='anon')==prefix_job['login_email']
        assert sql("select khub_username from public.profiles where kol_player_id=299001;")=='Exact Player'
        sql("update khub_bot.account_jobs set created_at=now()-interval '10 minutes' where mail_id='99001';")
        sql("update khub_bot.deliveries set created_at='1970-01-01' where receipt_id='99001';")
        credential_claim=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert credential_claim['receipt_id']=='99001'
        sql(f"select public.bot_ack_delivery('{credential_claim['id']}','{credential_claim['attempt']}',true,'Fixture acknowledgment; no external KMail sent.');",role='service_role')
        recovery_job=prepare_account(account_mail(99003,sid=299001,name='Exact Player',command='credentials'))
        sql(f"update auth.users set raw_app_meta_data=jsonb_build_object('khub_account_job','99003') where id='{recovery_job['user_id']}';")
        sql("select public.bot_finish_account_job('99003');",role='service_role')
        assert 'kHub Username: KH_Exact Player' in sql("select display_message from khub_bot.deliveries where receipt_id='99003';")
        sql(f"update public.profiles set is_banned=true where id='{prefix_job['user_id']}';")
        assert sql("select public.khub_login_address('KH_Exact Player');",role='anon')==''
        # Shared administrator inbox: server-filtered categories, audit trail and privacy.
        frozen_deliveries=sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')
        sql(migration_sql('202610200028_shared_administrator_inbox.sql'))
        assert sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')==frozen_deliveries
        def support_inbox(category='all',status='all',page=1,uid=owner_id,error=None):
            result=sql(f"select public.read_support_inbox('{category}','{status}',{page});",uid,'authenticated',error=error)
            return None if error else json.loads(result)
        assert support_inbox('bug')['total']==31
        assert support_inbox('trade')['total']==support_inbox('appeal')['total']==support_inbox('other')['total']==0
        for uid in [SELLER,BUYER]:
            support_inbox(uid=uid,error='Administrator access required')
            sql(f"select public.set_support_category('{first_bug}','trade');",uid,'authenticated',error='Administrator access required')
        sql('select public.read_support_inbox();',role='anon',error='permission denied')
        sql('select * from khub_bot.support_category_activity;',SELLER,'authenticated',error='permission denied')
        support_inbox('bad',error='valid inbox category')
        sql(f"select public.set_support_category('{first_bug}','bad');",owner_id,'authenticated',error='valid inbox category')
        ids=json.loads(sql('select jsonb_agg(id) from (select id from khub_bot.bug_reports order by report_number limit 3)s;'))
        for report_id,category in zip(ids,['trade','appeal','other']):
            sql(f"select public.set_support_category('{report_id}','{category}');",owner_id,'authenticated')
            sql(f"select public.set_support_category('{report_id}','{category}');",owner_id,'authenticated')
            assert support_inbox(category)['total']==1
            assert support_inbox(category)['reports'][0]['id']==report_id
            assert support_inbox(category)['reports'][0]['category']==category
        assert support_inbox('all')['total']==31 and support_inbox('bug')['total']==28
        assert len(support_inbox('bug',page=1)['reports'])==20
        assert len(support_inbox('bug',page=2)['reports'])==8
        assert sql('select count(*) from khub_bot.support_category_activity;')=='3'
        assert sql(f"select count(*) from khub_bot.support_category_activity where administrator_id='{owner_id}' and previous_category='bug';")=='3'
        assert sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')==frozen_deliveries
        # Appeals are authenticated and private, but ordinary site bans do not block them.
        prior_deliveries=sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')
        sql(migration_sql('202610200029_ban_appeals.sql'))
        assert sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')==prior_deliveries
        assert sql("select public.khub_login_address('KH_Exact Player');",role='anon')==''
        assert sql("select public.khub_appeal_login_address('KH_Exact Player');",role='anon')==prefix_job['login_email']
        assert sql("select public.khub_appeal_login_address('Exact Player');",role='anon')==''
        assert sql("select public.khub_appeal_login_address('KH_Seller');",role='anon')==''
        appeal_id=str(uuid4())
        appeal_body='Please review my ban. <example> & context.'
        def appeal(request_id,body,uid=prefix_job['user_id'],role='authenticated',error=None):
            result=sql(f"select public.submit_ban_appeal('{request_id}','{body}');",uid,role,error=error)
            return None if error else json.loads(result)
        appeal(appeal_id,appeal_body,role='anon',error='permission denied')
        result=appeal(appeal_id,appeal_body)
        assert result['reference'].startswith('B-')
        assert appeal(appeal_id,appeal_body)==result
        appeal(appeal_id,appeal_body+' Different.',error='cannot be reused')
        appeal(str(uuid4()),appeal_body,error='wait a minute')
        assert sql(f"select category from khub_bot.bug_reports where id='{appeal_id}';")=='appeal'
        assert sql(f"select reporter_kol_id from khub_bot.bug_reports where id='{appeal_id}';")=='299001'
        appeal_notice=json.loads(sql(f"select to_jsonb(d) from khub_bot.deliveries d join khub_bot.bug_report_deliveries l on l.delivery_id=d.id where l.report_id='{appeal_id}';"))
        assert appeal_notice['recipient_id']==3552305 and appeal_notice['kind']=='notice'
        assert 'Ban appeal '+result['reference'] in appeal_notice['display_message']
        assert '&lt;example&gt; &amp; context.' in appeal_notice['display_message']
        assert support_inbox('appeal')['total']==2
        support_inbox(uid=prefix_job['user_id'],error='Administrator access required')
        sql("select public.create_auction('escrow item',2,100,24,null,null,1);",prefix_job['user_id'],'authenticated',error='restricted')
        assert sql(f"select is_banned from public.profiles where id='{prefix_job['user_id']}';")=='t'
        sql(f"update public.profiles set kol_verified_at=null where id='{double_job['user_id']}';")
        appeal(str(uuid4()),appeal_body,uid=double_job['user_id'],error='verified kHub account')
        # Confirmation reminders are participant-specific and filtered before pagination.
        sql(migration_sql('202610200030_unconfirmed_trade_reminders.sql'))
        all_pending=pending_trades(SELLER)
        reminder=next(r['id'] for r in all_pending['rows'] if r['winner_id']==BUYER)
        reminder_winner=sql(f"select winner_id from public.auctions where id='{reminder}';")
        prior_total=all_pending['total']
        winner_total=pending_trades(reminder_winner)['total']
        sql(f"select public.confirm_auction_trade('{reminder}');",SELLER,'authenticated')
        assert pending_trades(SELLER)['total']==prior_total-1
        assert pending_trades(reminder_winner)['total']==winner_total
        seller_pages=[pending_trades(SELLER,p) for p in range(1,(prior_total-2)//12+2)]
        assert all(a['id']!=reminder for page in seller_pages for a in page['rows'])
        assert len({a['id'] for page in seller_pages for a in page['rows']})==prior_total-1
        assert sql(f"select status from public.auctions where id='{reminder}';")=='awaiting_trade'
        details=read_page('detail',SELLER,'authenticated',id=reminder)['rows'][0]
        assert details['seller_confirmed_at'] is not None and details['settlement_contacts'] is not None
        sql(f"select public.confirm_auction_trade('{reminder}');",reminder_winner,'authenticated')
        assert pending_trades(reminder_winner)['total']==winner_total-1
        assert sql(f"select status from public.auctions where id='{reminder}';")=='completed'
        assert pending_trades(None)['rows']==[]
        sql('select public.read_pending_trades();',role='anon',error='permission denied')
        # Negative participant responses require a private reason and cannot turn into success.
        sql(migration_sql('202610200031_trade_reports.sql'))
        trade_problem=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{trade_problem}');",BUYER,'authenticated')
        problem_key=str(uuid4()); problem_body='Received nothing. <proof> & timeline.'
        def trade_report(key,lot,body,uid=competitor,error=None):
            result=sql(f"select public.submit_trade_report('{key}','{lot}',{literal(body)});",uid,'authenticated',error=error)
            return None if error else json.loads(result)
        sql(f"select public.submit_trade_report('{problem_key}','{trade_problem}','Reason long enough.');",role='anon',error='permission denied')
        trade_report(problem_key,trade_problem,problem_body,uid=SELLER,error='Only the seller or winning buyer')
        trade_report(problem_key,default_escrow,problem_body,error='Only the seller or winning buyer')
        trade_report(problem_key,trade_problem,'short',error='10 to 2,000')
        sql(f"update khub_bot.bug_reports set created_at=now()-interval '2 hours' where reporter_id in ('{competitor}','{BUYER}');")
        saved_problem=trade_report(problem_key,trade_problem,problem_body)
        assert trade_report(problem_key,trade_problem,problem_body)==saved_problem
        trade_report(problem_key,trade_problem,problem_body+' Changed.',error='cannot be reused')
        trade_report(str(uuid4()),trade_problem,problem_body,error='already submitted')
        sql(f"select public.confirm_auction_trade('{trade_problem}');",competitor,'authenticated',error='already reported')
        assert trade_problem not in [r['id'] for r in pending_trades(competitor)['rows']]
        assert trade_problem in [r['id'] for page in range(1,10) for r in pending_trades(BUYER,page)['rows']]
        own=read_page('detail',competitor,'authenticated',id=trade_problem)['rows'][0]
        counterparty=read_page('detail',BUYER,'authenticated',id=trade_problem)['rows'][0]
        outsider=read_page('detail',SELLER,'authenticated',id=trade_problem)['rows'][0]
        assert own['own_trade_report']==saved_problem['reference'] and own['trade_reported']
        assert counterparty['own_trade_report'] is None and counterparty['trade_reported']
        assert outsider['own_trade_report'] is None and outsider['trade_reported'] is None
        assert problem_body not in json.dumps(read_page('detail',BUYER,'authenticated',id=trade_problem))
        admin_problem=next(r for r in support_inbox('trade')['reports'] if r['reference']==saved_problem['reference'])
        assert admin_problem['auction_id']==trade_problem and admin_problem['reporter_role']=='seller'
        assert admin_problem['body']==problem_body
        private_report_id=sql(f"select report_id from khub_bot.trade_reports where auction_id='{trade_problem}';")
        notice=json.loads(sql(f"select to_jsonb(d) from khub_bot.deliveries d join khub_bot.bug_report_deliveries l on l.delivery_id=d.id where l.report_id='{private_report_id}';"))
        assert notice['recipient_id']==3552305 and notice['kind']=='notice'
        assert '&lt;proof&gt; &amp; timeline.' in notice['display_message']
        sql(f"select public.confirm_auction_trade('{trade_problem}');",BUYER,'authenticated')
        assert sql(f"select status from public.auctions where id='{trade_problem}';")=='awaiting_trade'
        assert sql(f"select seller_confirmed_at is null and buyer_confirmed_at is not null from public.auctions where id='{trade_problem}';")=='t'
        trade_report(str(uuid4()),trade_problem,problem_body,uid=BUYER,error='already confirmed')
        for role in ['anon','authenticated']:
            sql('select * from khub_bot.trade_reports;',role=role,error='permission denied')
        # Buyer-negative and seller-positive have the same behavior.
        buyer_problem=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{buyer_problem}');",BUYER,'authenticated')
        trade_report(str(uuid4()),buyer_problem,problem_body,uid=BUYER)
        sql(f"select public.confirm_auction_trade('{buyer_problem}');",competitor,'authenticated')
        assert sql(f"select status from public.auctions where id='{buyer_problem}';")=='awaiting_trade'
        # Concurrent positive and negative responses by one participant cannot both win.
        sql(f"update khub_bot.bug_reports set created_at=now()-interval '61 seconds' where reporter_id='{competitor}';")
        response_race=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{response_race}');",BUYER,'authenticated')
        def race_response(negative):
            try:
                if negative: trade_report(str(uuid4()),response_race,problem_body)
                else: sql(f"select public.confirm_auction_trade('{response_race}');",competitor,'authenticated')
                return True
            except AssertionError as failure:
                assert 'already confirmed' in str(failure) or 'already reported' in str(failure)
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            assert sum(pool.map(race_response,[True,False]))==1
        assert sql(f"select (seller_confirmed_at is not null)::integer+(select count(*) from khub_bot.trade_reports where auction_id=a.id and reporter_id=a.seller_id) from public.auctions a where id='{response_race}';")=='1'
        # Immediate direct feedback, optional explanations, administrator corrections and public winners.
        old_messages=sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')
        old_bodies=sql('select jsonb_agg(jsonb_build_array(id,body) order by id) from khub_bot.bug_reports;')
        sql(migration_sql('202610200032_direct_feedback_and_public_winners.sql'))
        assert sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')==old_messages
        assert sql('select jsonb_agg(jsonb_build_array(id,body) order by id) from khub_bot.bug_reports;')==old_bodies
        new_buyer_job=prepare_account(account_mail(99032,sid=399032,name='Feedback Buyer'))
        provision(new_buyer_job)
        sql("select public.bot_finish_account_job('99032');",role='service_role')
        fresh_buyer=new_buyer_job['user_id']
        def feedback(uid):
            return read_page('seller',id=uid,status='all')['seller']['stats']
        baseline=feedback(competitor)
        feedback_sale=direct_create('500',uid=competitor)
        # An expired UI timer alone cannot publish a winner.
        still_open=read_page('detail',id=feedback_sale)['rows'][0]
        assert still_open['winner_public'] is False and still_open['winner_id'] is None
        sql(f"select public.purchase_auction('{feedback_sale}');",fresh_buyer,'authenticated')
        closed_public=read_page('detail',id=feedback_sale)['rows'][0]
        assert closed_public['winner_public'] and closed_public['winner_id']==fresh_buyer
        assert closed_public['winner_username']=='Feedback Buyer'
        assert closed_public['settlement_contacts'] is None and closed_public['highest_bidder_id'] is None
        public_bids=read_page('detail',id=feedback_sale)['bids']
        assert all(row['bidder_id'] is None and row['bidder_username'].startswith('Bidder ') for row in public_bids)
        buyer_only=read_page('seller',id=fresh_buyer,status='all')
        assert buyer_only['seller']['username']=='Feedback Buyer' and buyer_only['total']==0 and buyer_only['rows']==[]
        silent_key=str(uuid4())
        notices_before=sql('select count(*) from khub_bot.deliveries;')
        silent=trade_report(silent_key,feedback_sale,'',uid=fresh_buyer)
        assert silent['notification']=='not_queued'
        assert trade_report(silent_key,feedback_sale,'   ',uid=fresh_buyer)==silent
        assert sql('select count(*) from khub_bot.deliveries;')==notices_before
        assert feedback(competitor)['seller_negative']==baseline['seller_negative']+1
        assert feedback(fresh_buyer)['buyer_negative']==0
        silent_id=sql(f"select report_id from khub_bot.trade_reports where auction_id='{feedback_sale}' and reporter_id='{fresh_buyer}';")
        admin_silent=next(r for r in support_inbox('trade')['reports'] if r['id']==silent_id)
        assert admin_silent['negative_counted'] is True and admin_silent['has_explanation'] is False
        assert admin_silent['target_username']=='Actual Long KoL Character Name'
        assert admin_silent['body']=='No explanation provided.' and admin_silent['notification']=='not_queued'
        def review_rating(counted,uid=owner_id,reason='Reviewed the available evidence.',error=None):
            sql(f"select public.review_trade_rating('{silent_id}',{str(counted).lower()},{literal(reason)});",uid,'authenticated',error=error)
        review_rating(False,uid=fresh_buyer,error='Administrator access required')
        sql(f"select public.review_trade_rating('{silent_id}',false,'Reason given');",role='anon',error='permission denied')
        review_rating(False,reason='',error='review reason')
        review_rating(False)
        assert feedback(competitor)['seller_negative']==baseline['seller_negative']
        assert sql(f"select count(*) from khub_bot.trade_reports where report_id='{silent_id}';")=='1'
        assert sql(f"select count(*) from khub_bot.trade_rating_reviews where report_id='{silent_id}';")=='1'
        review_rating(False)
        assert sql(f"select count(*) from khub_bot.trade_rating_reviews where report_id='{silent_id}';")=='1'
        review_rating(True)
        assert feedback(competitor)['seller_negative']==baseline['seller_negative']+1
        assert sql(f"select count(*) from khub_bot.trade_rating_reviews where report_id='{silent_id}';")=='2'
        # Closing an inbox item is separate from whether its rating counts.
        sql(f"select public.set_bug_report_status('{silent_id}','resolved');",owner_id,'authenticated')
        assert feedback(competitor)['seller_negative']==baseline['seller_negative']+1
        # One positive reply remains a positive response, not a completed sale.
        sql(f"select public.confirm_auction_trade('{feedback_sale}');",competitor,'authenticated')
        assert feedback(fresh_buyer)['buyer_positive']==1
        assert sql(f"select status from public.auctions where id='{feedback_sale}';")=='awaiting_trade'
        # A seller's negative response counts against the buyer role only, without notification spam.
        buyer_feedback_sale=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{buyer_feedback_sale}');",fresh_buyer,'authenticated')
        trade_report(str(uuid4()),buyer_feedback_sale,'',uid=competitor)
        assert feedback(fresh_buyer)['buyer_negative']==1 and feedback(fresh_buyer)['seller_negative']==0
        assert sql('select count(*) from khub_bot.deliveries;')==notices_before
        # Optional short explanations are accepted; only explained reports queue KMail.
        explained_sale=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{explained_sale}');",fresh_buyer,'authenticated')
        explained=trade_report(str(uuid4()),explained_sale,'x',uid=fresh_buyer)
        assert explained['notification']=='queued'
        assert sql('select count(*) from khub_bot.deliveries;')==str(int(notices_before)+1)
        trade_report(str(uuid4()),explained_sale,'x'*2001,uid=competitor,error='optional explanation')
        for role in ['anon','authenticated']:
            sql('select * from khub_bot.trade_rating_reviews;',role=role,error='permission denied')
            sql(f"select khub_bot.profile_feedback('{fresh_buyer}');",role=role,error='permission denied')
        # Escrow winners are also public after server close; private contact/player IDs stay hidden.
        escrow_finished=sql("select id from public.auctions where escrow_mode and finalized_at is not null and winner_id is not null and status in ('settling','completed') order by id limit 1;")
        assert escrow_finished
        escrow_public=read_page('detail',id=escrow_finished)['rows'][0]
        assert escrow_public['winner_public'] and escrow_public['winner_id'] is not None
        assert escrow_public['settlement_contacts'] is None
        assert 'kol_player_id' not in escrow_public
        # Rating KMail is transactional, correctly addressed and exactly once per response.
        notifications_before=sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')
        sql(migration_sql('202610200033_rating_notifications.sql'))
        assert sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')==notifications_before
        assert sql('select count(*) from khub_bot.rating_notifications;')=='0'
        def rating_notices(lot):
            return json.loads(sql(f"select coalesce(jsonb_agg(jsonb_build_object('actor',n.actor_id,'recipient',n.recipient_id,'positive',n.positive,'role',n.recipient_role,'delivery',n.delivery_id,'kol_id',d.recipient_id,'body',d.display_message,'kind',d.kind,'meat',d.meat,'item_id',d.item_id,'auction_id',d.auction_id)),'[]') from khub_bot.rating_notifications n join khub_bot.deliveries d on d.id=n.delivery_id where n.auction_id='{lot}';"))
        notice_trade=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{notice_trade}');",fresh_buyer,'authenticated')
        sql(f"select public.confirm_auction_trade('{notice_trade}');",fresh_buyer,'authenticated')
        first_notice=rating_notices(notice_trade)[0]
        assert first_notice['actor']==fresh_buyer and first_notice['recipient']==competitor
        assert first_notice['role']=='seller' and first_notice['positive'] is True
        assert first_notice['kol_id']==101015
        assert 'Feedback Buyer was satisfied' in first_notice['body']
        assert 'Positive rating has been added to your profile as a seller' in first_notice['body']
        assert first_notice['kind']=='notice' and first_notice['meat']==0 and first_notice['item_id'] is None and first_notice['auction_id'] is None
        sql(f"select public.confirm_auction_trade('{notice_trade}');",fresh_buyer,'authenticated')
        assert len(rating_notices(notice_trade))==1
        sql(f"select public.confirm_auction_trade('{notice_trade}');",competitor,'authenticated')
        both_notices=rating_notices(notice_trade)
        assert len(both_notices)==2
        buyer_notice=next(r for r in both_notices if r['role']=='buyer')
        assert buyer_notice['recipient']==fresh_buyer and buyer_notice['positive'] and buyer_notice['kol_id']==399032
        assert 'as a buyer' in buyer_notice['body']
        assert sql(f"select status from public.auctions where id='{notice_trade}';")=='completed'
        sql(f"select public.confirm_auction_trade('{notice_trade}');",competitor,'authenticated')
        assert len(rating_notices(notice_trade))==2
        # Mixed responses notify both rated players even though the sale remains pending.
        mixed=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{mixed}');",fresh_buyer,'authenticated')
        sql(f"select public.confirm_auction_trade('{mixed}');",fresh_buyer,'authenticated')
        admin_notices_before=sql('select count(*) from khub_bot.deliveries where recipient_id=3552305;')
        trade_report(str(uuid4()),mixed,'',uid=competitor)
        mixed_notices=rating_notices(mixed)
        assert len(mixed_notices)==2
        negative_notice=next(r for r in mixed_notices if not r['positive'])
        assert negative_notice['recipient']==fresh_buyer and negative_notice['role']=='buyer'
        assert 'was not satisfied with the trade' in negative_notice['body']
        assert 'Negative rating has been added to your profile as a buyer' in negative_notice['body']
        assert sql(f"select status from public.auctions where id='{mixed}';")=='awaiting_trade'
        assert sql('select count(*) from khub_bot.deliveries where recipient_id=3552305;')==admin_notices_before
        # Optional private explanations never go into the recipient notification.
        sql(f"update khub_bot.bug_reports set created_at=now()-interval '2 hours' where reporter_id='{fresh_buyer}';")
        explained_notice_trade=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{explained_notice_trade}');",fresh_buyer,'authenticated')
        trade_report(str(uuid4()),explained_notice_trade,'SECRET_REPORT_ONLY private explanation.',uid=fresh_buyer)
        assert 'SECRET_REPORT_ONLY' not in rating_notices(explained_notice_trade)[0]['body']
        assert sql('select count(*) from khub_bot.deliveries where recipient_id=3552305;')==str(int(admin_notices_before)+1)
        # Administrator-initiated reconciliation can notify older feedback, without a bulk resend.
        sql(f"select public.notify_auction_ratings('{feedback_sale}');",fresh_buyer,'authenticated',error='Administrator access required')
        sql(f"select public.notify_auction_ratings('{feedback_sale}');",role='anon',error='permission denied')
        queued=json.loads(sql(f"select public.notify_auction_ratings('{feedback_sale}');",owner_id,'authenticated'))
        assert queued=={'queued':2,'remaining':0}
        assert json.loads(sql(f"select public.notify_auction_ratings('{feedback_sale}');",owner_id,'authenticated'))=={'queued':0,'remaining':0}
        assert len(rating_notices(feedback_sale))==2
        admin_delivery=next(r for r in support_inbox('trade',status='all')['reports'] if r['id']==silent_id)
        assert admin_delivery['rating_notification']=='queued' and admin_delivery['missing_rating_notices']==0
        sql(f"select public.notify_auction_ratings('{escrow_finished}');",owner_id,'authenticated',error='direct-settlement')
        # Missing recipient verification cannot block feedback or guess a destination.
        unverifiable=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{unverifiable}');",fresh_buyer,'authenticated')
        sql(f"update public.profiles set kol_verified_at=null where id='{competitor}';")
        sql(f"select public.confirm_auction_trade('{unverifiable}');",fresh_buyer,'authenticated')
        assert rating_notices(unverifiable)==[]
        assert json.loads(sql(f"select public.notify_auction_ratings('{unverifiable}');",owner_id,'authenticated'))=={'queued':0,'remaining':1}
        sql(f"update public.profiles set kol_verified_at=now() where id='{competitor}';")
        assert json.loads(sql(f"select public.notify_auction_ratings('{unverifiable}');",owner_id,'authenticated'))=={'queued':1,'remaining':0}
        for role in ['anon','authenticated']:
            sql('select * from khub_bot.rating_notifications;',role=role,error='permission denied')
            sql(f"select khub_bot.queue_rating_notice('{notice_trade}','{fresh_buyer}');",role=role,error='permission denied')
        # An uncertain notification keeps its original body and cannot be re-queued.
        test_notice=rating_notices(unverifiable)[0]
        sql(f"update khub_bot.deliveries set created_at='1960-01-01' where id='{test_notice['delivery']}';")
        claimed_notice=json.loads(sql('select public.bot_claim_delivery(2);',role='service_role'))
        assert claimed_notice['id']==test_notice['delivery']
        pg_ctl('-l',str(Path(directory)/'postgres.log'),'-m','fast','-w','restart')
        sql('select public.bot_claim_delivery(2);',role='service_role',error='Uncertain delivery')
        assert json.loads(sql(f"select public.notify_auction_ratings('{unverifiable}');",owner_id,'authenticated'))=={'queued':0,'remaining':0}
        assert len(rating_notices(unverifiable))==1 and rating_notices(unverifiable)[0]['body']==test_notice['body']
        # Author resolution retains the original response and clears its negative count/inbox clutter.
        frozen_notice_bodies=sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')
        sql(migration_sql('202610200034_trade_resolution.sql'))
        assert sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')==frozen_notice_bodies
        mixed_report=sql(f"select report_id from khub_bot.trade_reports where auction_id='{mixed}' and reporter_id='{competitor}';")
        before_negative=feedback(fresh_buyer)['buyer_negative']
        sql(f"select public.withdraw_trade_rating('{mixed}');",fresh_buyer,'authenticated',error='Only the author')
        sql(f"select public.withdraw_trade_rating('{mixed}');",role='anon',error='permission denied')
        sql(f"select public.withdraw_trade_rating('{mixed}');",competitor,'authenticated')
        assert feedback(fresh_buyer)['buyer_negative']==before_negative-1
        assert sql(f"select status||':'||resolution_kind from khub_bot.bug_reports where id='{mixed_report}';")=='resolved:participant_resolved'
        assert sql(f"select withdrawn_by from khub_bot.trade_rating_withdrawals where report_id='{mixed_report}';")==competitor
        assert sql(f"select body from khub_bot.bug_reports where id='{mixed_report}';")=='No explanation provided.'
        assert mixed_report not in [r['id'] for r in support_inbox('trade',status='open')['reports']]
        assert mixed_report in [r['id'] for r in support_inbox('trade',status='self_resolved')['reports']]
        withdrawal_count=sql('select count(*) from khub_bot.deliveries;')
        sql(f"select public.withdraw_trade_rating('{mixed}');",competitor,'authenticated')
        assert sql('select count(*) from khub_bot.deliveries;')==withdrawal_count
        assert sql(f"select count(*) from khub_bot.trade_rating_withdrawals where report_id='{mixed_report}';")=='1'
        sql(f"select public.review_trade_rating('{mixed_report}',true,'Attempted restoration after author withdrawal.');",owner_id,'authenticated',error='withdrawn by its author')
        own_withdrawn=read_page('detail',competitor,'authenticated',id=mixed)['rows'][0]
        assert own_withdrawn['own_trade_report_withdrawn'] and not own_withdrawn['trade_reported']
        assert mixed in [r['id'] for page in range(1,10) for r in pending_trades(competitor,page)['rows']]
        before_positive=feedback(fresh_buyer)['buyer_positive']
        sql(f"select public.confirm_auction_trade('{mixed}');",competitor,'authenticated')
        assert sql(f"select status from public.auctions where id='{mixed}';")=='completed'
        assert feedback(fresh_buyer)['buyer_positive']==before_positive+1
        revised_notices=rating_notices(mixed)
        assert len(revised_notices)==3 and len([r for r in revised_notices if r['actor']==competitor])==2
        sql(f"select public.confirm_auction_trade('{mixed}');",competitor,'authenticated')
        assert len(rating_notices(mixed))==3
        # Trade-query messages are separate from ratings and remain private to admins.
        sql(f"update khub_bot.bug_reports set created_at=now()-interval '2 hours' where reporter_id='{fresh_buyer}';")
        query_key=str(uuid4()); query_body='Please review my remaining concern about this trade.'
        def trade_query(key,lot,body,uid=fresh_buyer,error=None):
            result=sql(f"select public.submit_trade_query('{key}','{lot}',{literal(body)});",uid,'authenticated',error=error)
            return None if error else json.loads(result)
        feedback_before_query=feedback(fresh_buyer)
        query_result=trade_query(query_key,mixed,query_body)
        assert trade_query(query_key,mixed,query_body)==query_result
        assert feedback(fresh_buyer)==feedback_before_query
        trade_query(str(uuid4()),mixed,query_body,uid=SELLER,error='Only the seller or winner')
        query_admin=next(r for r in support_inbox('trade')['reports'] if r['id']==query_key)
        assert query_admin['message_type']=='trade_query' and query_admin['auction_id']==mixed
        assert query_admin['reporter_role']=='buyer' and query_admin['negative_counted'] is None
        assert query_body not in json.dumps(read_page('detail',competitor,'authenticated',id=mixed))
        # Newly generated negative notices explain peer resolution and the auction's query link.
        resolving_sale=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{resolving_sale}');",fresh_buyer,'authenticated')
        trade_report(str(uuid4()),resolving_sale,'',uid=competitor)
        resolving_notice=rating_notices(resolving_sale)[0]['body']
        assert 'try to resolve this with them' in resolving_notice and 'withdraw their negative rating' in resolving_notice
        assert 'As a last resort' in resolving_notice and 'Ask an administrator about this trade' in resolving_notice
        for role in ['anon','authenticated']:
            sql('select * from khub_bot.trade_rating_withdrawals;',role=role,error='permission denied')
            sql('select * from khub_bot.trade_queries;',role=role,error='permission denied')
        # Account names are returned only to signed-in, unrestricted viewers.
        sql(migration_sql('202610200035_authenticated_name_visibility.sql'))
        public_identity=read_page('detail',id=mixed)['rows'][0]
        assert public_identity['seller_username']=='Seller' and public_identity['winner_username']=='Winner'
        assert public_identity['usernames_visible'] is False and not public_identity['winner_public']
        assert public_identity['winner_id'] is None and public_identity['settlement_contacts'] is None
        public_profile=read_page('seller',id=fresh_buyer,status='all')['seller']
        assert public_profile['username']=='Player profile' and public_profile['usernames_visible'] is False
        assert public_profile['stats']['buyer_positive']>=1
        valid_view=read_page('detail',fresh_buyer,'authenticated',id=mixed)['rows'][0]
        assert valid_view['usernames_visible'] and valid_view['winner_username']=='Feedback Buyer'
        assert valid_view['seller_username']=='Actual Long KoL Character Name'
        assert valid_view['settlement_contacts'] is not None
        spectator=read_page('detail',SELLER,'authenticated',id=mixed)['rows'][0]
        assert spectator['winner_username']=='Feedback Buyer' and spectator['settlement_contacts'] is None
        # Auth-level bans are checked even when a browser still holds an old JWT.
        sql(f"update auth.users set banned_until=now()+interval '1 day' where id='{fresh_buyer}';")
        auth_banned=read_page('detail',fresh_buyer,'authenticated',id=mixed)['rows'][0]
        assert not auth_banned['usernames_visible'] and auth_banned['winner_username']=='Winner' and auth_banned['seller_username']=='Seller'
        assert auth_banned['settlement_contacts'] is None
        sql(f"update auth.users set banned_until=null where id='{fresh_buyer}';")
        # Profile bans and active identity bans independently deny names.
        sql(f"update public.profiles set is_banned=true where id='{fresh_buyer}';")
        assert not read_page('detail',fresh_buyer,'authenticated',id=mixed)['rows'][0]['usernames_visible']
        sql(f"update public.profiles set is_banned=false where id='{fresh_buyer}';")
        assert not read_page('detail',fresh_buyer,'authenticated',id=mixed)['rows'][0]['usernames_visible']
        assert read_page('seller',fresh_buyer,'authenticated',id=competitor,status='all')['seller']['username']=='Player profile'
        # Explicitly remove the identity ban in the isolated fixture to restore healthy access.
        sql("update khub_bot.account_bans set active=false where kol_player_id=399032;")
        assert read_page('detail',fresh_buyer,'authenticated',id=mixed)['rows'][0]['usernames_visible']
        # Public gallery entries also avoid leaking usernames, player IDs or identifying reason text.
        gallery_public=json.loads(sql('select public.khub_wall_of_shame();',role='anon'))
        assert not gallery_public['usernames_visible']
        for entry in gallery_public['entries']:
            assert entry['kol_player_name']=='Banned player' and entry['kol_player_id'] is None
            assert entry['public_reason']=='Log in with an unrestricted account to view this reviewed ban.'
        for role in ['anon','authenticated']:
            sql('select khub_bot.can_view_usernames();',role=role,error='permission denied')
        sql(f"update auth.users set banned_until=now()+interval '1 day' where id='{owner_id}';")
        assert sql('select public.khub_is_administrator();',owner_id,'authenticated')=='f'
        support_inbox(uid=owner_id,error='Administrator access required')
        sql(f"update auth.users set banned_until=null where id='{owner_id}';")
        assert sql('select public.khub_is_administrator();',owner_id,'authenticated')=='t'
        # Administrator conversations group all auction messages before pagination.
        preserved_deliveries=sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')
        sql(migration_sql('202610200036_support_threads.sql'))
        assert sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')==preserved_deliveries
        def threads(category='all',status='all',page=1,uid=owner_id,error=None):
            value=sql(f"select public.read_support_threads('{category}','{status}',{page});",uid,'authenticated',error=error)
            return None if error else json.loads(value)
        def update_thread(thread_id,is_trade=True,status=None,category=None,uid=owner_id,error=None):
            sql(f"select public.update_support_thread('{thread_id}',{str(is_trade).lower()},{literal(status) if status else 'null'},{literal(category) if category else 'null'});",uid,'authenticated',error=error)
        for uid in [SELLER,fresh_buyer,competitor]:
            threads(uid=uid,error='Administrator access required')
            update_thread(mixed,status='resolved',uid=uid,error='Administrator access required')
        sql('select public.read_support_threads();',role='anon',error='permission denied')
        sql(f"select public.update_support_thread('{mixed}',true,'resolved',null);",role='anon',error='permission denied')
        threads(category='invalid',error='valid inbox category')
        threads(status='invalid',error='valid inbox page')
        threads(page=0,error='valid inbox page')
        update_thread(mixed,status='bad',error='valid report status')
        update_thread(mixed,status='resolved',category='trade',error='one inbox update')
        # More than a page of messages for one auction must still form exactly one row.
        sql("update khub_bot.bug_reports set created_at=now()-interval '2 days';")
        extra_queries=[]
        for index in range(23):
            report=str(uuid4()); extra_queries.append(report)
            sql(f"insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category) values('{report}','{fresh_buyer}','Feedback Buyer',399032,'Grouped query number {index}.','trade');")
            sql(f"insert into khub_bot.trade_queries(report_id,auction_id,requester_id) values('{report}','{mixed}','{fresh_buyer}');")
        for index in range(21):
            report=str(uuid4())
            sql(f"insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category) values('{report}','{fresh_buyer}','Feedback Buyer',399032,'Separate bug number {index}.','bug');")
        thread_pages=[threads(page=page) for page in range(1,20)]
        all_threads=[t for page in thread_pages for t in page['threads']]
        assert len(all_threads)==thread_pages[0]['total']
        assert len({(t['id'],t['is_trade']) for t in all_threads})==len(all_threads)
        assert len(thread_pages[0]['threads'])==20
        grouped=next(t for t in all_threads if t['is_trade'] and t['id']==mixed)
        assert len(grouped['messages'])==25
        assert grouped['status']=='open' and grouped['auction']['id']==mixed
        assert grouped['auction']['buyer']['name']=='Feedback Buyer'
        assert grouped['auction']['seller']['confirmed_at'] is not None
        assert {m['id'] for m in grouped['messages']}=={mixed_report,query_key,*extra_queries}
        assert {m['message_type'] for m in grouped['messages']}=={'trade_rating','trade_query'}
        assert len({m['id'] for m in grouped['messages']})==25
        feedback_before_threads=feedback(fresh_buyer)
        update_thread(mixed,status='resolved')
        assert sql(f"select count(*) from khub_bot.bug_reports where id in (select report_id from khub_bot.trade_queries where auction_id='{mixed}') and status='open';")=='0'
        assert sql(f"select resolution_kind from khub_bot.bug_reports where id='{mixed_report}';")=='participant_resolved'
        assert not any(t['id']==mixed for t in threads(status='open')['threads'])
        assert feedback(fresh_buyer)==feedback_before_threads
        update_thread(mixed,status='open')
        assert sql(f"select status||':'||resolution_kind from khub_bot.bug_reports where id='{mixed_report}';")=='resolved:participant_resolved'
        assert sql(f"select count(*) from khub_bot.bug_report_activity where report_id='{query_key}';")=='2'
        update_thread(mixed,category='other')
        moved=next(t for t in threads(category='other')['threads'] if t['id']==mixed)
        assert len(moved['messages'])==25 and all(m['category']=='other' for m in moved['messages'])
        assert not any(t['id']==mixed for page in range(1,10) for t in threads(category='trade',page=page)['threads'])
        # A differently categorized message still returns the entire auction history.
        sql(f"select public.set_support_category('{query_key}','trade');",owner_id,'authenticated')
        split=next(t for t in threads(category='trade')['threads'] if t['id']==mixed)
        assert len(split['messages'])==25 and any(m['category']=='other' for m in split['messages'])
        # Each side's independent negative count remains available to review.
        sql(f"update khub_bot.bug_reports set created_at=now()-interval '2 hours' where reporter_id='{fresh_buyer}';")
        buyer_report=str(uuid4())
        trade_report(buyer_report,resolving_sale,'The delivery did not arrive.',uid=fresh_buyer)
        dual=next(t for t in threads(category='trade')['threads'] if t['id']==resolving_sale)
        assert {m['reporter_role'] for m in dual['messages'] if m['negative_counted']}=={'seller','buyer'}
        sql(f"select public.review_trade_rating('{buyer_report}',false,'Reviewed the buyer explanation.');",owner_id,'authenticated')
        dual=next(t for t in threads(category='trade')['threads'] if t['id']==resolving_sale)
        assert next(m for m in dual['messages'] if m['id']==buyer_report)['negative_counted'] is False
        assert any(m['reporter_role']=='seller' and m['negative_counted'] for m in dual['messages'])
        update_thread(resolving_sale,status='resolved')
        # New messages reopen a conversation through its derived state, without rewriting history.
        report=str(uuid4())
        sql(f"insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category) values('{report}','{fresh_buyer}','Feedback Buyer',399032,'A new follow-up after resolution.','trade');")
        sql(f"insert into khub_bot.trade_queries(report_id,auction_id,requester_id) values('{report}','{resolving_sale}','{fresh_buyer}');")
        reopened=next(t for t in threads(status='open')['threads'] if t['id']==resolving_sale)
        assert reopened['status']=='open' and any(m['status']=='resolved' for m in reopened['messages'])
        # Standalone issues remain separate and use the same audited actions.
        single=next(t for t in all_threads if not t['is_trade'])
        update_thread(single['id'],is_trade=False,status='resolved')
        assert sql(f"select status from khub_bot.bug_reports where id='{single['id']}';")=='resolved'
        update_thread(query_key,is_trade=False,status='open',error='Conversation not found')
        # Completion after withdrawing an incomplete report is neutral, never positive.
        frozen_messages=sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')
        sql(migration_sql('202610200037_neutral_trade_resolution.sql'))
        assert sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')==frozen_messages
        assert sql(f"select seller_resolved_at is null and buyer_resolved_at is null from public.auctions where id='{mixed}';")=='t'
        neutral_lot=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{neutral_lot}');",fresh_buyer,'authenticated')
        neutral_report=str(uuid4())
        trade_report(neutral_report,neutral_lot,'',uid=competitor)
        before_neutral_buyer=feedback(fresh_buyer)
        before_neutral_seller=feedback(competitor)
        for uid in [competitor,fresh_buyer]:
            view=read_page('detail',uid,'authenticated',id=neutral_lot)['rows'][0]
            assert view['seller_reported_incomplete'] is True and view['buyer_reported_incomplete'] is False
        for uid,role in [(None,'anon'),(SELLER,'authenticated')]:
            view=read_page('detail',uid,role,id=neutral_lot)['rows'][0]
            assert view['seller_reported_incomplete'] is None and view['buyer_reported_incomplete'] is None
        sql(f"select public.withdraw_trade_rating('{neutral_lot}');",fresh_buyer,'authenticated',error='Only the author')
        sql(f"select public.withdraw_trade_rating('{neutral_lot}');",role='anon',error='permission denied')
        sql(f"update public.auctions set seller_resolved_at=now() where id='{neutral_lot}';",competitor,'authenticated',error='permission denied')
        sql(f"select public.withdraw_trade_rating('{neutral_lot}');",competitor,'authenticated')
        view=read_page('detail',competitor,'authenticated',id=neutral_lot)['rows'][0]
        assert view['seller_resolved_at'] is not None and view['seller_confirmed_at'] is None
        assert view['own_trade_report_withdrawn'] and not view['seller_reported_incomplete']
        assert view['status']=='awaiting_trade'
        assert feedback(fresh_buyer)['buyer_negative']==before_neutral_buyer['buyer_negative']-1
        assert feedback(fresh_buyer)['buyer_positive']==before_neutral_buyer['buyer_positive']
        assert feedback(competitor)==before_neutral_seller
        assert not any(r['id']==neutral_lot for page in range(1,10) for r in pending_trades(competitor,page)['rows'])
        assert any(r['id']==neutral_lot for page in range(1,10) for r in pending_trades(fresh_buyer,page)['rows'])
        sql(f"select public.confirm_auction_trade('{neutral_lot}');",competitor,'authenticated',error='No positive rating can be added')
        notice_count=sql('select count(*) from khub_bot.deliveries;')
        sql(f"select public.withdraw_trade_rating('{neutral_lot}');",competitor,'authenticated')
        assert sql('select count(*) from khub_bot.deliveries;')==notice_count
        withdrawal_notice=sql(f"select display_message from khub_bot.deliveries where dedupe_key='rating-withdrawal:{neutral_lot}:{competitor}';")
        assert 'trade was successfully completed' in withdrawal_notice and 'No positive rating was added' in withdrawal_notice
        # The other participant can still confirm normally; neither action changes the neutral response.
        sql(f"select public.confirm_auction_trade('{neutral_lot}');",fresh_buyer,'authenticated')
        assert sql(f"select status from public.auctions where id='{neutral_lot}';")=='completed'
        assert feedback(fresh_buyer)['buyer_positive']==before_neutral_buyer['buyer_positive']
        assert feedback(competitor)['seller_positive']==before_neutral_seller['seller_positive']+1
        neutral_admin=next(t for t in threads()['threads'] if t['id']==neutral_lot)
        assert neutral_admin['auction']['seller']['resolved_at'] is not None
        assert neutral_admin['auction']['seller']['confirmed_at'] is None
        assert 'Confirmed Complete' in rating_notices(neutral_lot)[-1]['body']
        # Both sides can withdraw independent reports; no positive confirmations/notices are created.
        both_neutral=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{both_neutral}');",fresh_buyer,'authenticated')
        trade_report(str(uuid4()),both_neutral,'',uid=competitor)
        trade_report(str(uuid4()),both_neutral,'',uid=fresh_buyer)
        both_before={uid:feedback(uid) for uid in [competitor,fresh_buyer]}
        for uid in [competitor,fresh_buyer]:
            sql(f"select public.withdraw_trade_rating('{both_neutral}');",uid,'authenticated')
        assert sql(f"select status from public.auctions where id='{both_neutral}';")=='completed'
        assert sql(f"select seller_confirmed_at is null and buyer_confirmed_at is null and seller_resolved_at is not null and buyer_resolved_at is not null from public.auctions where id='{both_neutral}';")=='t'
        assert sql(f"select count(*) from khub_bot.rating_notifications where auction_id='{both_neutral}' and positive;")=='0'
        for uid in [competitor,fresh_buyer]:
            now_feedback=feedback(uid)
            assert now_feedback['seller_positive']==both_before[uid]['seller_positive']
            assert now_feedback['buyer_positive']==both_before[uid]['buyer_positive']
            sql(f"select public.confirm_auction_trade('{both_neutral}');",uid,'authenticated',error='No positive rating can be added')
        # Buyer withdrawal also completes a trade whose seller confirmed earlier.
        buyer_neutral=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{buyer_neutral}');",fresh_buyer,'authenticated')
        sql(f"select public.confirm_auction_trade('{buyer_neutral}');",competitor,'authenticated')
        trade_report(str(uuid4()),buyer_neutral,'',uid=fresh_buyer)
        seller_before=feedback(competitor)
        sql(f"select public.withdraw_trade_rating('{buyer_neutral}');",fresh_buyer,'authenticated')
        assert sql(f"select status from public.auctions where id='{buyer_neutral}';")=='completed'
        assert feedback(competitor)['seller_positive']==seller_before['seller_positive']
        assert feedback(competitor)['seller_negative']==seller_before['seller_negative']-1
        # Publish only response statuses for closed direct sales; retain identity and contact privacy.
        frozen_messages=sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')
        sql(migration_sql('202610200038_public_trade_responses.sql'))
        assert sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')==frozen_messages
        public_lot=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{public_lot}');",fresh_buyer,'authenticated')
        sql(f"select public.confirm_auction_trade('{public_lot}');",fresh_buyer,'authenticated')
        sql(f"update khub_bot.bug_reports set created_at=now()-interval '2 hours' where reporter_id='{competitor}';")
        private_report=str(uuid4()); private_body='Private explanation for administrators only.'
        trade_report(private_report,public_lot,private_body,uid=competitor)
        for uid,role in [(competitor,'authenticated'),(fresh_buyer,'authenticated'),(SELLER,'authenticated'),(None,'anon')]:
            page_view=read_page('detail',uid,role,id=public_lot)
            view=page_view['rows'][0]
            assert view['seller_reported_incomplete'] is True and view['buyer_reported_incomplete'] is False
            assert view['trade_reported'] is True and view['buyer_confirmed_at'] is not None
            assert private_body not in json.dumps(page_view)
            if uid not in [competitor,fresh_buyer]:
                assert view['settlement_contacts'] is None and view['own_trade_report'] is None
                assert view['own_trade_report_withdrawn'] is None
                assert all(bid['bidder_id'] is None for bid in page_view['bids'])
            if uid is None:
                assert view['seller_username']=='Seller' and view['winner_username']=='Winner'
                assert view['winner_id'] is None and view['usernames_visible'] is False
            else:
                assert view['seller_username']=='Actual Long KoL Character Name' and view['winner_username']=='Feedback Buyer'
        # Restricting the account masks names and contacts, while public response facts remain visible.
        sql(f"update auth.users set banned_until=now()+interval '1 day' where id='{fresh_buyer}';")
        restricted=read_page('detail',fresh_buyer,'authenticated',id=public_lot)['rows'][0]
        assert restricted['trade_reported'] is True and restricted['seller_reported_incomplete'] is True
        assert restricted['seller_username']=='Seller' and restricted['winner_username']=='Winner'
        assert restricted['settlement_contacts'] is None
        sql(f"update auth.users set banned_until=null where id='{fresh_buyer}';")
        # Withdrawing the report updates the public warning and badges without changing positive counts.
        target_before=feedback(fresh_buyer)
        sql(f"select public.withdraw_trade_rating('{public_lot}');",competitor,'authenticated')
        for uid,role in [(SELLER,'authenticated'),(None,'anon')]:
            view=read_page('detail',uid,role,id=public_lot)['rows'][0]
            assert not view['trade_reported'] and not view['seller_reported_incomplete']
            assert view['seller_resolved_at'] is not None and view['buyer_confirmed_at'] is not None
            assert view['status']=='completed' and view['settlement_contacts'] is None
        assert feedback(fresh_buyer)['buyer_positive']==target_before['buyer_positive']
        active_lot=direct_create('500',uid=competitor)
        active_public=read_page('detail',id=active_lot)['rows'][0]
        assert active_public['trade_reported'] is None and active_public['seller_reported_incomplete'] is None
        # Independent optional feedback: no historical responses become thumb votes.
        frozen_messages=sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')
        sql(migration_sql('202610200039_independent_trade_feedback.sql'))
        assert sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')==frozen_messages
        sql(migration_sql('202610210040_final_trade_feedback.sql'))
        assert sql('select count(*) from khub_bot.trade_feedback;')=='0'
        for uid in [competitor,fresh_buyer]:
            assert all(feedback(uid)[key]==0 for key in ['seller_positive','seller_negative','buyer_positive','buyer_negative'])
        separate=direct_create('500',uid=competitor)
        for uid in [competitor,fresh_buyer]:
            sql(f"select public.rate_trade_partner('{separate}',1);",uid,'authenticated',error='closed direct sale')
        sql(f"select public.purchase_auction('{separate}');",fresh_buyer,'authenticated')
        sql(f"select public.rate_trade_partner('{separate}',1);",competitor,'authenticated',error='before rating')
        baseline_buyer=feedback(fresh_buyer); baseline_seller=feedback(competitor)
        sql(f"select public.confirm_auction_trade('{separate}');",competitor,'authenticated')
        assert feedback(fresh_buyer)['buyer_positive']==0
        assert feedback(fresh_buyer)['buyer_confirmed']==baseline_buyer['buyer_confirmed']+1
        # A completed response notifies the partner without awarding feedback.
        latest_body=sql(f"select d.display_message from khub_bot.rating_notifications n join khub_bot.deliveries d on d.id=n.delivery_id where n.auction_id='{separate}' and n.actor_id='{competitor}';")
        assert 'does not change your feedback score' in latest_body and 'rating has been added' not in latest_body
        sql(f"select public.rate_trade_partner('{separate}',-1);",competitor,'authenticated')
        sql(f"select public.rate_trade_partner('{separate}',-1);",competitor,'authenticated')
        assert feedback(fresh_buyer)['buyer_negative']==1 and feedback(fresh_buyer)['buyer_positive']==0
        assert feedback(fresh_buyer)['buyer_confirmed']==baseline_buyer['buyer_confirmed']+1
        assert sql(f"select count(*) from khub_bot.trade_feedback where auction_id='{separate}';")=='1'
        # Votes are private to their author; recipients and spectators see only profile totals.
        for uid,role in [(competitor,'authenticated'),(fresh_buyer,'authenticated'),(SELLER,'authenticated'),(None,'anon')]:
            row=read_page('detail',uid,role,id=separate)['rows'][0]
            assert row['own_feedback']==(-1 if uid==competitor else None)
        sql(f"select public.rate_trade_partner('{separate}',1);",SELLER,'authenticated',error='closed direct sale')
        sql(f"select public.rate_trade_partner('{separate}',1);",role='anon',error='permission denied')
        sql(f"select public.rate_trade_partner('{separate}',0);",competitor,'authenticated',error='thumbs')
        sql(f"select public.rate_trade_partner('{separate}',null);",competitor,'authenticated',error='thumbs')
        sql(f"update auth.users set banned_until=now()+interval '1 day' where id='{competitor}';")
        sql(f"select public.rate_trade_partner('{separate}',1);",competitor,'authenticated',error='unrestricted')
        assert read_page('detail',competitor,'authenticated',id=separate)['rows'][0]['own_feedback'] is None
        sql(f"update auth.users set banned_until=null where id='{competitor}';")
        sql('select * from khub_bot.trade_feedback;',competitor,'authenticated',error='permission denied')
        # An incomplete response neither creates feedback nor restricts its polarity.
        trade_report(str(uuid4()),separate,'',uid=fresh_buyer)
        assert feedback(competitor)['seller_negative']==0
        assert feedback(competitor)['seller_incomplete']==baseline_seller['seller_incomplete']+1
        sql(f"select public.rate_trade_partner('{separate}',1);",fresh_buyer,'authenticated')
        assert feedback(competitor)['seller_positive']==1
        assert feedback(competitor)['seller_incomplete']==baseline_seller['seller_incomplete']+1
        # Resolve the issue: completion changes while both explicit votes stay intact.
        sql(f"select public.withdraw_trade_rating('{separate}');",fresh_buyer,'authenticated')
        assert feedback(competitor)['seller_incomplete']==baseline_seller['seller_incomplete']
        assert feedback(competitor)['seller_confirmed']==baseline_seller['seller_confirmed']+1
        assert feedback(competitor)['seller_positive']==1 and feedback(fresh_buyer)['buyer_negative']==1
        assert sql(f"select status from public.auctions where id='{separate}';")=='completed'
        # Ratings are final, including after completion. Identical retries stay idempotent.
        sql(f"select public.rate_trade_partner('{separate}',1);",competitor,'authenticated',error='cannot be changed')
        sql(f"select public.rate_trade_partner('{separate}',-1);",competitor,'authenticated')
        assert feedback(fresh_buyer)['buyer_positive']==0 and feedback(fresh_buyer)['buyer_negative']==1
        assert sql(f"select count(*) from khub_bot.trade_feedback where auction_id='{separate}';")=='2'
        assert sql(f"select status from public.auctions where id='{separate}';")=='completed'
        # Existing resolved trades are also eligible; escrow/unsold/cancelled sales are not.
        sql(f"select public.rate_trade_partner('{public_lot}',-1);",competitor,'authenticated')
        sql(f"select public.rate_trade_partner('{active_lot}',1);",competitor,'authenticated',error='closed direct sale')
        # Commas belong only in generated display amounts/quantities, never identifiers or ledgers.
        frozen_messages=sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')
        sql(migration_sql('202610210041_comma_formatted_bot_numbers.sql'))
        assert sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')==frozen_messages
        for value in [0,19,999,1000,99000000000,9007199254740993,9223372036854775807]:
            assert sql(f'select khub_bot.format_message_number({value}::bigint);')==f'{value:,}'
        formatted=direct_create('99000000000',uid=competitor)
        sql(f"update public.auctions set quantity=12345 where id='{formatted}';")
        sql(f"select public.purchase_auction('{formatted}');",fresh_buyer,'authenticated')
        sql(f"select public.confirm_auction_trade('{formatted}');",fresh_buyer,'authenticated')
        body=sql(f"select d.display_message from khub_bot.rating_notifications n join khub_bot.deliveries d on d.id=n.delivery_id where n.auction_id='{formatted}' and n.actor_id='{fresh_buyer}';")
        assert 'Agreed total: 99,000,000,000 Meat' in body and '12,345 x escrow item' in body
        auction_number=sql(f"select auction_number from public.auctions where id='{formatted}';")
        assert f'Auction #{auction_number}' in body
        assert sql(f"select final_price from public.auctions where id='{formatted}';")=='99000000000'
        # Friendly escrow deliveries use the same grouped quantities and preserve item-name digits.
        sql(f"update public.auctions set item='item 1234567' where id='{formatted}';")
        friendly=sql(f"select khub_bot.friendly_message(jsonb_populate_record(null::khub_bot.deliveries,jsonb_build_object('auction_id','{formatted}'::uuid,'kind','sale_item')));")
        assert 'item 1234567 × 12,345' in friendly
        # Administrator report headers are formatted; private user-entered text and player IDs remain exact.
        sql(f"update khub_bot.bug_reports set created_at=now()-interval '2 hours' where reporter_id='{competitor}';")
        format_report=str(uuid4())
        trade_report(format_report,formatted,'Keep my number 1234567 unchanged.',uid=competitor)
        report_body=sql(f"select d.display_message from khub_bot.bug_report_deliveries r join khub_bot.deliveries d on d.id=r.delivery_id where r.report_id='{format_report}';")
        assert 'Agreed total: 99,000,000,000 Meat' in report_body and 'Keep my number 1234567 unchanged.' in report_body
        player_number=sql(f"select kol_player_id from public.profiles where id='{competitor}';")
        assert f'(#{player_number})' in report_body
        # Purchase totals count completed auctions only, separately for each settlement mode.
        source_before=sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')
        sql(migration_sql('202610210042_profile_purchase_totals.sql'))
        assert sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')==source_before
        for uid in [competitor,fresh_buyer,SELLER,BUYER]:
            stats=feedback(uid)
            for escrow,key in [('false','direct_bought_value'),('true','escrow_bought_value')]:
                expected=sql(f"select coalesce(sum(final_price),0)::text from public.auctions where winner_id='{uid}' and escrow_mode={escrow} and status='completed' and finalized_at is not null;")
                assert stats[key]==expected and isinstance(stats[key],str)
        before_purchase=feedback(fresh_buyer)
        # The 99b formatted sale is awaiting resolution; it contributes only once both parties complete.
        assert sql(f"select status from public.auctions where id='{formatted}';")=='awaiting_trade'
        sql(f"select public.withdraw_trade_rating('{formatted}');",competitor,'authenticated')
        after_purchase=feedback(fresh_buyer)
        assert int(after_purchase['direct_bought_value'])==int(before_purchase['direct_bought_value'])+99000000000
        assert after_purchase['escrow_bought_value']==before_purchase['escrow_bought_value']
        assert sql(f"select status from public.auctions where id='{formatted}';")=='completed'
        public_stats=read_page('seller',None,'anon',id=fresh_buyer)['seller']['stats']
        assert public_stats['direct_bought_value']==after_purchase['direct_bought_value']
        assert public_stats['escrow_bought_value']==after_purchase['escrow_bought_value']
        # Admin exclusion clears public bad marks while retaining evidence and separate votes.
        frozen_messages=sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')
        sql(migration_sql('202610210043_excluded_trade_report_status.sql'))
        assert sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')==frozen_messages
        disputed=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{disputed}');",fresh_buyer,'authenticated')
        seller_dispute=str(uuid4()); buyer_dispute=str(uuid4())
        trade_report(seller_dispute,disputed,'',uid=competitor)
        trade_report(buyer_dispute,disputed,'',uid=fresh_buyer)
        sql(f"select public.rate_trade_partner('{disputed}',-1);",competitor,'authenticated')
        sql(f"select public.rate_trade_partner('{disputed}',1);",fresh_buyer,'authenticated')
        before_review={uid:feedback(uid) for uid in [competitor,fresh_buyer]}
        auction_before_review=sql(f"select to_jsonb(a) from public.auctions a where id='{disputed}';")
        first_view=read_page('detail',id=disputed)['rows'][0]
        assert first_view['trade_reported'] and first_view['seller_reported_incomplete'] and first_view['buyer_reported_incomplete']
        sql(f"select public.review_trade_rating('{seller_dispute}',false,'Reviewed evidence: excluded seller report.');",owner_id,'authenticated')
        # One legitimate report still keeps the auction warning active.
        one_view=read_page('detail',id=disputed)['rows'][0]
        assert one_view['trade_reported'] and one_view['buyer_reported_incomplete']
        assert not one_view['seller_reported_incomplete'] and one_view['seller_report_excluded']
        sql(f"select public.review_trade_rating('{buyer_dispute}',false,'Reviewed evidence: excluded buyer report.');",owner_id,'authenticated')
        for uid,role in [(competitor,'authenticated'),(fresh_buyer,'authenticated'),(SELLER,'authenticated'),(None,'anon')]:
            view=read_page('detail',uid,role,id=disputed)['rows'][0]
            assert not view['trade_reported'] and not view['seller_reported_incomplete'] and not view['buyer_reported_incomplete']
            assert view['seller_report_excluded'] and view['buyer_report_excluded']
            assert view['status']=='awaiting_trade' and view['seller_confirmed_at'] is None and view['buyer_confirmed_at'] is None
            if uid in [competitor,fresh_buyer]:
                assert view['own_trade_report_excluded'] is True and view['own_trade_report'] is not None
                assert view['own_feedback']==(-1 if uid==competitor else 1)
            else:
                assert view['own_trade_report_excluded'] is None and view['own_trade_report'] is None and view['own_feedback'] is None
        assert sql(f"select to_jsonb(a) from public.auctions a where id='{disputed}';")==auction_before_review
        for uid,removed_key in [(competitor,'seller_incomplete'),(fresh_buyer,'buyer_incomplete')]:
            after=feedback(uid)
            assert after[removed_key]==before_review[uid][removed_key]-1
            for key in ['seller_confirmed','buyer_confirmed','seller_positive','seller_negative','buyer_positive','buyer_negative','direct_bought_value']:
                assert after[key]==before_review[uid][key]
        assert sql(f"select count(*) from khub_bot.trade_reports where auction_id='{disputed}';")=='2'
        assert sql(f"select count(*) from khub_bot.trade_rating_reviews where report_id in ('{seller_dispute}','{buyer_dispute}');")=='2'
        # Closing the support thread doesn't complete the trade or restore excluded marks.
        sql(f"select public.update_support_thread('{disputed}',true,'resolved',null);",owner_id,'authenticated')
        assert sql(f"select to_jsonb(a) from public.auctions a where id='{disputed}';")==auction_before_review
        assert not read_page('detail',id=disputed)['rows'][0]['trade_reported']
        # An audited restoration returns only that report's mark and counter.
        sql(f"select public.review_trade_rating('{seller_dispute}',true,'Further evidence supports this report.');",owner_id,'authenticated')
        restored=read_page('detail',id=disputed)['rows'][0]
        assert restored['trade_reported'] and restored['seller_reported_incomplete'] and not restored['seller_report_excluded']
        assert not restored['buyer_reported_incomplete'] and restored['buyer_report_excluded']
        assert feedback(fresh_buyer)['buyer_incomplete']==before_review[fresh_buyer]['buyer_incomplete']
        # Excluded reports remain withdrawable only by their original author to acknowledge completion.
        sql(f"select public.withdraw_trade_rating('{disputed}');",fresh_buyer,'authenticated')
        resolved_view=read_page('detail',fresh_buyer,'authenticated',id=disputed)['rows'][0]
        assert not resolved_view['buyer_report_excluded'] and resolved_view['buyer_resolved_at'] is not None
        assert resolved_view['trade_reported'] and resolved_view['status']=='awaiting_trade'
        # A profile's completed points wait for BOTH acknowledgements of completion.
        all_auctions_before=sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')
        reports_before=sql('select jsonb_agg(to_jsonb(t) order by report_id) from khub_bot.trade_reports t;')
        votes_before=sql('select jsonb_agg(to_jsonb(f) order by auction_id,actor_id) from khub_bot.trade_feedback f;')
        sql(migration_sql('202610210044_completed_trade_counts.sql'))
        assert sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')==all_auctions_before
        assert sql('select jsonb_agg(to_jsonb(t) order by report_id) from khub_bot.trade_reports t;')==reports_before
        assert sql('select jsonb_agg(to_jsonb(f) order by auction_id,actor_id) from khub_bot.trade_feedback f;')==votes_before
        for uid in [competitor,fresh_buyer,SELLER,BUYER]:
            stats=feedback(uid)
            assert stats['seller_confirmed']==int(sql(f"select count(*) from public.auctions where seller_id='{uid}' and not escrow_mode and status='completed' and winner_id is not null and finalized_at is not null;"))
            assert stats['buyer_confirmed']==int(sql(f"select count(*) from public.auctions where winner_id='{uid}' and not escrow_mode and status='completed' and finalized_at is not null;"))
        # One confirmation, a conflicting response, and an admin exclusion each leave completed points unchanged.
        wait_both=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{wait_both}');",fresh_buyer,'authenticated')
        seller_base=feedback(competitor); buyer_base=feedback(fresh_buyer)
        sql(f"select public.confirm_auction_trade('{wait_both}');",fresh_buyer,'authenticated')
        assert feedback(competitor)['seller_confirmed']==seller_base['seller_confirmed']
        assert feedback(fresh_buyer)['buyer_confirmed']==buyer_base['buyer_confirmed']
        late_report=str(uuid4())
        trade_report(late_report,wait_both,'',uid=competitor)
        assert feedback(competitor)['seller_confirmed']==seller_base['seller_confirmed']
        assert feedback(fresh_buyer)['buyer_confirmed']==buyer_base['buyer_confirmed']
        sql(f"select public.review_trade_rating('{late_report}',false,'Report dismissed after reviewing evidence.');",owner_id,'authenticated')
        assert feedback(competitor)['seller_confirmed']==seller_base['seller_confirmed']
        assert feedback(fresh_buyer)['buyer_confirmed']==buyer_base['buyer_confirmed']
        sql(f"select public.withdraw_trade_rating('{wait_both}');",competitor,'authenticated')
        for _ in range(2):
            assert feedback(competitor)['seller_confirmed']==seller_base['seller_confirmed']+1
            assert feedback(fresh_buyer)['buyer_confirmed']==buyer_base['buyer_confirmed']+1
            sql(f"select public.withdraw_trade_rating('{wait_both}');",competitor,'authenticated')
        # The ordinary confirmation path also waits for both, regardless of who responds first.
        plain=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{plain}');",fresh_buyer,'authenticated')
        seller_base=feedback(competitor); buyer_base=feedback(fresh_buyer)
        sql(f"select public.confirm_auction_trade('{plain}');",competitor,'authenticated')
        sql(f"select public.rate_trade_partner('{plain}',1);",competitor,'authenticated')
        assert feedback(competitor)['seller_confirmed']==seller_base['seller_confirmed']
        assert feedback(fresh_buyer)['buyer_confirmed']==buyer_base['buyer_confirmed']
        assert feedback(fresh_buyer)['buyer_positive']==buyer_base['buyer_positive']+1
        sql(f"select public.confirm_auction_trade('{plain}');",fresh_buyer,'authenticated')
        assert feedback(competitor)['seller_confirmed']==seller_base['seller_confirmed']+1
        assert feedback(fresh_buyer)['buyer_confirmed']==buyer_base['buyer_confirmed']+1
        public_stats=read_page('seller',None,'anon',id=competitor)['seller']['stats']
        assert public_stats['seller_confirmed']==seller_base['seller_confirmed']+1
        # Incomplete values use the agreed lot price and mirror the reviewed per-role counts.
        all_auctions_before=sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')
        sql(migration_sql('202610210045_incomplete_trade_values.sql'))
        assert sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')==all_auctions_before
        for uid in [competitor,fresh_buyer,SELLER,BUYER]:
            stats=feedback(uid)
            for reported_role,target_column,key in [('buyer','seller_id','seller_incomplete_value'),('seller','winner_id','buyer_incomplete_value')]:
                expected=sql(f"select coalesce(sum(a.final_price),0)::text from khub_bot.trade_reports t join public.auctions a on a.id=t.auction_id where t.counts_negative and t.withdrawn_at is null and not a.escrow_mode and t.reporter_role='{reported_role}' and a.{target_column}='{uid}';")
                assert stats[key]==expected and isinstance(stats[key],str)
        seller_value_base=feedback(competitor); buyer_value_base=feedback(fresh_buyer)
        cheap=direct_create('10000',uid=competitor)
        costly=direct_create('10000000000',uid=competitor)
        cheap_report=str(uuid4()); costly_buyer_report=str(uuid4()); costly_seller_report=str(uuid4())
        for lot in [cheap,costly]:
            sql(f"select public.purchase_auction('{lot}');",fresh_buyer,'authenticated')
        trade_report(cheap_report,cheap,'',uid=fresh_buyer)
        trade_report(costly_buyer_report,costly,'',uid=fresh_buyer)
        trade_report(costly_seller_report,costly,'',uid=competitor)
        assert int(feedback(competitor)['seller_incomplete_value'])==int(seller_value_base['seller_incomplete_value'])+10000+10000000000
        assert int(feedback(fresh_buyer)['buyer_incomplete_value'])==int(buyer_value_base['buyer_incomplete_value'])+10000000000
        # Quantity is two, but the final price already covers the entire lot: no double multiplication.
        sql(f"select public.review_trade_rating('{costly_buyer_report}',false,'Dismissed after administrator review.');",owner_id,'authenticated')
        assert int(feedback(competitor)['seller_incomplete_value'])==int(seller_value_base['seller_incomplete_value'])+10000
        assert int(feedback(fresh_buyer)['buyer_incomplete_value'])==int(buyer_value_base['buyer_incomplete_value'])+10000000000
        sql(f"select public.review_trade_rating('{costly_buyer_report}',true,'Restored after additional evidence.');",owner_id,'authenticated')
        assert int(feedback(competitor)['seller_incomplete_value'])==int(seller_value_base['seller_incomplete_value'])+10000+10000000000
        sql(f"select public.withdraw_trade_rating('{costly}');",fresh_buyer,'authenticated')
        assert int(feedback(competitor)['seller_incomplete_value'])==int(seller_value_base['seller_incomplete_value'])+10000
        assert int(feedback(fresh_buyer)['buyer_incomplete_value'])==int(buyer_value_base['buyer_incomplete_value'])+10000000000
        sql(f"select public.withdraw_trade_rating('{costly}');",competitor,'authenticated')
        assert feedback(fresh_buyer)['buyer_incomplete_value']==buyer_value_base['buyer_incomplete_value']
        assert int(feedback(fresh_buyer)['direct_bought_value'])==int(buyer_value_base['direct_bought_value'])+10000000000
        for uid,expected in [(competitor,feedback(competitor)),(fresh_buyer,feedback(fresh_buyer))]:
            stats=read_page('seller',None,'anon',id=uid)['seller']['stats']
            assert stats['seller_incomplete_value']==expected['seller_incomplete_value']
            assert stats['buyer_incomplete_value']==expected['buyer_incomplete_value']
            for key in ['seller_positive','seller_negative','buyer_positive','buyer_negative']:
                assert expected[key]==(seller_value_base if uid==competitor else buyer_value_base)[key]
        # Escrow winning-bid counts use completed deliveries, independently of direct trades.
        all_auctions_before=sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')
        sql(migration_sql('202610210046_escrow_purchase_counts.sql'))
        assert sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')==all_auctions_before
        for uid in [competitor,fresh_buyer,SELLER,BUYER]:
            expected=int(sql(f"select count(*) from public.auctions where winner_id='{uid}' and escrow_mode and status='completed' and finalized_at is not null;"))
            assert feedback(uid)['escrow_buys']==expected
        escrow_before=feedback(BUYER)
        pending_escrow_purchase=privacy_lot('active',True)
        assert feedback(BUYER)['escrow_buys']==escrow_before['escrow_buys']
        sql(f"update public.auctions set status='settling',winner_id='{BUYER}',winner_username='Buyer',final_price=300,finalized_at=now(),settlement_outcome='completed' where id='{pending_escrow_purchase}';")
        assert feedback(BUYER)['escrow_buys']==escrow_before['escrow_buys']
        sql(f"update public.auctions set status='completed',settled_at=now(),completed_at=now() where id='{pending_escrow_purchase}';")
        escrow_after=feedback(BUYER)
        assert escrow_after['escrow_buys']==escrow_before['escrow_buys']+1
        assert int(escrow_after['escrow_bought_value'])==int(escrow_before['escrow_bought_value'])+300
        assert escrow_after['buyer_confirmed']==escrow_before['buyer_confirmed']
        assert read_page('seller',None,'anon',id=BUYER)['seller']['stats']['escrow_buys']==escrow_after['escrow_buys']
        # The inbox shows actual reporter withdrawals even when the original report had no explanation.
        frozen_messages=sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')
        sql(migration_sql('202610210047_support_withdrawal_updates.sql'))
        assert sql('select jsonb_agg(jsonb_build_array(id,display_message,state) order by id) from khub_bot.deliveries;')==frozen_messages
        threads(uid=competitor,error='Administrator access required')
        sql('select public.read_support_threads();',role='anon',error='permission denied')
        silent_withdrawal=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{silent_withdrawal}');",fresh_buyer,'authenticated')
        silent_withdrawal_report=str(uuid4())
        trade_report(silent_withdrawal_report,silent_withdrawal,'',uid=competitor)
        before_withdrawal=next(t for t in threads()['threads'] if t['id']==silent_withdrawal)
        assert len(before_withdrawal['messages'])==1
        original=before_withdrawal['messages'][0]
        assert original['body']=='No explanation provided.' and original['withdrawn_at'] is None
        assert original['withdrawal_confirmed_complete'] is False
        sql(f"select public.withdraw_trade_rating('{silent_withdrawal}');",competitor,'authenticated')
        after_withdrawal=next(t for t in threads(status='self_resolved')['threads'] if t['id']==silent_withdrawal)
        saved=after_withdrawal['messages'][0]
        assert saved['feedback_withdrawn'] and saved['withdrawn_at'] is not None and saved['withdrawal_confirmed_complete'] is True
        assert saved['reporter_username']==original['reporter_username'] and saved['reference']==original['reference']
        assert saved['created_at']==original['created_at'] and saved['body']==original['body']
        assert after_withdrawal['updated_at']==saved['withdrawn_at']
        assert after_withdrawal['auction']['seller']['resolved_at']==saved['withdrawn_at']
        assert after_withdrawal['auction']['status']=='awaiting_trade'
        sql(f"select public.withdraw_trade_rating('{silent_withdrawal}');",competitor,'authenticated')
        repeated=next(t for t in threads()['threads'] if t['id']==silent_withdrawal)
        assert len(repeated['messages'])==1 and repeated['messages'][0]['withdrawn_at']==saved['withdrawn_at']
        assert sql(f"select count(*) from khub_bot.trade_rating_withdrawals where report_id='{silent_withdrawal_report}';")=='1'
        # The other party can withdraw their own report later; both events retain distinct timestamps.
        silent_buyer_report=str(uuid4())
        trade_report(silent_buyer_report,silent_withdrawal,'',uid=fresh_buyer)
        sql(f"select public.withdraw_trade_rating('{silent_withdrawal}');",fresh_buyer,'authenticated')
        both_updates=next(t for t in threads()['threads'] if t['id']==silent_withdrawal)
        assert len(both_updates['messages'])==2 and both_updates['auction']['status']=='completed'
        assert all(m['withdrawal_confirmed_complete'] and m['withdrawn_at'] is not None for m in both_updates['messages'])
        assert both_updates['updated_at']==max(m['withdrawn_at'] for m in both_updates['messages'])
        # An administrator closing a conversation is never described as the reporter confirming completion.
        no_withdrawal=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{no_withdrawal}');",fresh_buyer,'authenticated')
        no_withdrawal_report=str(uuid4())
        trade_report(no_withdrawal_report,no_withdrawal,'',uid=competitor)
        update_thread(no_withdrawal,status='resolved')
        admin_closed=next(t for t in threads()['threads'] if t['id']==no_withdrawal)
        assert admin_closed['messages'][0]['withdrawn_at'] is None
        assert not admin_closed['messages'][0]['withdrawal_confirmed_complete']
        # Older withdrawals that never acknowledged completion retain their original meaning.
        legacy_message=next(m for page in range(1,(threads()['total']+19)//20+1) for t in threads(page=page)['threads'] for m in t['messages'] if m['message_type']=='trade_rating' and m['feedback_withdrawn'] and not m['withdrawal_confirmed_complete'])
        assert legacy_message['withdrawn_at'] is not None
        public=read_page('detail',None,'anon',id=silent_withdrawal)
        assert 'withdrawal_confirmed_complete' not in json.dumps(public) and 'withdrawn_at' not in json.dumps(public)
        # Account restrictions preserve password authentication for appeals while blocking trade APIs.
        sql(f"update auth.users set banned_until=now()+interval '3 days' where id='{fresh_buyer}';")
        sql(migration_sql('202610210048_restricted_accounts_and_appeal_evidence.sql'))
        sql(migration_sql('202610210049_administrator_account_controls.sql'))
        def access(uid):
            return json.loads(sql('select public.read_my_account_access();',uid,'authenticated'))
        assert access(fresh_buyer)['is_banned'] and access(fresh_buyer)['ban_expires_at'] is not None
        assert sql(f"select banned_until is null from auth.users where id='{fresh_buyer}';")=='t'
        assert access(prefix_job['user_id'])['is_banned'] # pre-existing permanent bans survive
        assert not access(competitor)['is_banned']
        assert 'reason' not in access(fresh_buyer)
        sql('select public.read_my_account_access();',role='anon',error='permission denied')
        sql("select public.read_admin_accounts('Feedback');",competitor,'authenticated',error='Administrator access required')
        sql("select public.read_admin_accounts('Feedback');",role='anon',error='permission denied')
        def ban(uid,expiry='null',actor=owner_id,error=None):
            return sql(f"select public.set_account_restriction('{uid}','Reviewed failure to honor trade',{expiry});",actor,'authenticated',error=error)
        def lift(uid,actor=owner_id,error=None):
            return sql(f"select public.lift_account_restriction('{uid}','Reviewed and lifted restriction');",actor,'authenticated',error=error)
        ban(competitor,actor=fresh_buyer,error='Administrator access required')
        ban(owner_id,error='own administrator')
        ban(competitor,"now()-interval '1 minute'",error='future expiry')
        lift(fresh_buyer)
        assert not access(fresh_buyer)['is_banned']
        restriction_lot=direct_create('500',uid=competitor)
        sql(f"select public.purchase_auction('{restriction_lot}');",fresh_buyer,'authenticated')
        ban(competitor,"now()+interval '1 day'")
        assert access(competitor)['is_banned'] and access(competitor)['ban_expires_at'] is not None
        target_username=sql(f"select khub_username from public.profiles where id='{competitor}';")
        assert sql(f"select public.khub_login_address('KH_{target_username}');",role='anon').endswith('@login.khub.invalid')
        # An already-issued authenticated token cannot bypass a new ban.
        before_incomplete=feedback(fresh_buyer)['buyer_incomplete']
        trade_report(str(uuid4()),restriction_lot,'',uid=competitor,error='restricted')
        assert feedback(fresh_buyer)['buyer_incomplete']==before_incomplete
        sql(f"select public.confirm_auction_trade('{restriction_lot}');",competitor,'authenticated',error='restricted')
        direct_create(uid=competitor,error='restricted')
        sql(f"select public.submit_trade_query('{uuid4()}','{restriction_lot}','Please review this exchange.');",competitor,'authenticated',error='restricted')
        sql(f"select public.submit_bug_report('{uuid4()}','Please review my account.');",competitor,'authenticated',error='restricted')
        # Bounded private evidence is saved atomically with the appeal and can only be read by admins.
        sql(f"update khub_bot.bug_reports set created_at=now()-interval '2 hours' where reporter_id='{competitor}';")
        evidence_id=str(uuid4())
        png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII='
        evidence_call=f"select public.submit_ban_appeal_with_evidence('{evidence_id}','Please review my ban and attached evidence.','{png}','image/png');"
        first_evidence=sql(evidence_call,competitor,'authenticated')
        assert sql(evidence_call,competitor,'authenticated')==first_evidence
        assert sql(f"select count(*) from khub_bot.appeal_evidence where report_id='{evidence_id}';")=='1'
        sql(f"select public.read_appeal_evidence('{evidence_id}');",competitor,'authenticated',error='Administrator access required')
        sql(f"select public.read_appeal_evidence('{evidence_id}');",role='anon',error='permission denied')
        image=json.loads(sql(f"select public.read_appeal_evidence('{evidence_id}');",owner_id,'authenticated'))
        assert image=={'mime_type':'image/png','base64':png}
        sql('select * from khub_bot.appeal_evidence;',competitor,'authenticated',error='permission denied')
        sql(f"select public.submit_ban_appeal_with_evidence('{evidence_id}','Please review my ban and attached evidence.');",competitor,'authenticated',error='different evidence')
        invalid_id=str(uuid4())
        sql(f"select public.submit_ban_appeal_with_evidence('{invalid_id}','Please review my ban and attached evidence.','PHN2Zz48L3N2Zz4=','image/svg+xml');",competitor,'authenticated',error='PNG, JPEG or WebP')
        sql(f"select public.submit_ban_appeal_with_evidence('{invalid_id}','Please review my ban and attached evidence.','PHN2Zz48L3N2Zz4=','image/png');",competitor,'authenticated',error='valid PNG')
        sql(f"select public.submit_ban_appeal_with_evidence('{invalid_id}','Please review my ban and attached evidence.',repeat('A',2796205),'image/png');",competitor,'authenticated',error='up to 2 MB')
        assert sql(f"select count(*) from khub_bot.bug_reports where id='{invalid_id}';")=='0'
        evidence_thread=next(t for t in threads(category='appeal')['threads'] if any(m['id']==evidence_id for m in t['messages']))
        assert next(m for m in evidence_thread['messages'] if m['id']==evidence_id)['has_evidence']
        assert png not in json.dumps(evidence_thread)
        account_result=json.loads(sql(f"select public.read_admin_accounts('{target_username}');",owner_id,'authenticated'))
        account_row=next(r for r in account_result if r['id']==competitor)
        assert account_row['is_banned'] and account_row['expires_at'] and account_row['reason']
        prefixed_result=json.loads(sql(f"select public.read_admin_accounts('KH_{target_username}');",owner_id,'authenticated'))
        assert any(r['id']==competitor for r in prefixed_result)
        # Expired bans stop restricting the account without a manual cleanup job.
        sql(f"update khub_bot.account_bans set expires_at=now()-interval '1 second' where active and kol_player_id=(select kol_player_id from public.profiles where id='{competitor}');")
        assert not access(competitor)['is_banned']
        assert direct_create(uid=competitor)
        ban(competitor)
        assert access(competitor)['is_banned'] and access(competitor)['ban_expires_at'] is None
        lift(competitor)
        assert not access(competitor)['is_banned']
        # Later native Auth bans are mirrored before they can prevent appeal sign-in.
        sql(f"update auth.users set banned_until=now()+interval '2 days' where id='{competitor}';")
        assert access(competitor)['is_banned'] and access(competitor)['ban_expires_at']
        assert sql(f"select banned_until is null from auth.users where id='{competitor}';")=='t'
        lift(competitor)
        assert not access(competitor)['is_banned']
        assert int(sql(f"select count(*) from khub_bot.account_ban_activity where administrator_id='{owner_id}';"))>=5
        sql('select * from khub_bot.account_ban_activity;',competitor,'authenticated',error='permission denied')
        # The early-access ceiling applies only to minimum bids on newly created escrow listings.
        legacy_large_escrow=sql("select public.create_auction('escrow item',2,2000000,24,null,null,1,true);",competitor,'authenticated')
        prior_auctions=sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')
        sql(migration_sql('202610210050_early_access_escrow_minimum_limit.sql'))
        assert sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')==prior_auctions
        assert sql(f"select min_bid_meat from public.auctions where id='{legacy_large_escrow}';")=='2000000'
        before_limit_count=sql('select count(*) from public.auctions;')
        for mode in ['', ',true']:
            sql(f"select public.create_auction('escrow item',2,1000001,24,null,null,1{mode});",competitor,'authenticated',error='Choose Direct')
        assert sql('select count(*) from public.auctions;')==before_limit_count
        for minimum in [999999,1000000]:
            allowed=sql(f"select public.create_auction('escrow item',2,{minimum},24,null,2000000,1,true);",competitor,'authenticated')
            assert sql(f"select status from public.auctions where id='{allowed}';")=='pending_escrow'
            assert sql(f"select instant_purchase_price from public.auctions where id='{allowed}';")=='2000000'
        unrestricted_direct=sql("select public.create_auction('escrow item',2,1000001,24,null,null,1,false);",competitor,'authenticated')
        assert sql(f"select status from public.auctions where id='{unrestricted_direct}';")=='active'
        sql("select public.create_auction('escrow item',2,1000000,24,null,null,1,true);",role='anon',error='permission denied')
        # Give the isolated Auth stub the columns used by Supabase email/password users.
        sql('''alter table auth.users
            add column instance_id uuid, add column aud text, add column role text,
            add column encrypted_password text, add column is_super_admin boolean,
            add column created_at timestamptz, add column updated_at timestamptz,
            add column confirmation_token text, add column recovery_token text,
            add column email_change_token_current text, add column email_change_token_new text,
            add column email_change text, add column phone_change_token text,
            add column phone_change text, add column reauthentication_token text;
            create table auth.identities(id uuid primary key,provider_id text not null,user_id uuid not null references auth.users(id),
                identity_data jsonb not null,provider text not null,created_at timestamptz,updated_at timestamptz,unique(provider_id,provider));
        ''')
        sql("insert into khub_bot.catalog(id,name) values(364,'asbestos ore'),(2,'seal tooth'),(3,'helmet turtle'),(10,'disco ball'),(8684,'Cold Fang') on conflict(id) do update set name=excluded.name;")
        seed_sql=(ROOT/'supabase/testing/seed_test_accounts.sql').read_text()
        original_financial=sql("select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d where kind<>'notice';")
        deliveries_before=set(json.loads(sql('select coalesce(jsonb_agg(id),\'[]\') from khub_bot.deliveries;')))
        sql(seed_sql)
        assert sql('select count(*) from khub_bot.test_accounts;')=='6'
        assert sql('select count(*) from khub_bot.test_auction_fixtures;')=='11'
        assert sql("select count(*) from auth.identities where user_id in (select user_id from khub_bot.test_accounts);")=='6'
        assert sql("select count(*) from auth.users u join khub_bot.test_accounts t on t.user_id=u.id where u.encrypted_password=crypt(t.username,u.encrypted_password);")=='6'
        assert sql('select count(*) from khub_bot.test_accounts t where khub_bot.is_administrator(t.user_id);')=='0'
        banned_test=sql("select user_id from khub_bot.test_accounts where username='banned';")
        assert not access(banned_test)['is_banned']
        assert sql("select bool_and(state='done' and temporary_password is null) from khub_bot.account_jobs where mail_id like 'khub-test-v1-%';")=='t'
        assert sql("select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d where kind<>'notice';")==original_financial
        new_deliveries=json.loads(sql('select coalesce(jsonb_agg(to_jsonb(d)),\'[]\') from khub_bot.deliveries d;'))
        assert all(d['recipient_id']==3552305 and d['kind']=='notice' for d in new_deliveries if d['id'] not in deliveries_before)
        assert all(r['status']=='pending_escrow' for r in json.loads(sql("select jsonb_agg(to_jsonb(a)) from public.auctions a join khub_bot.test_auction_fixtures f on f.auction_id=a.id where a.escrow_mode;")))
        assert sql("select status from public.auctions where id=(select auction_id from khub_bot.test_auction_fixtures where seed_key='direct-both-complete');")=='completed'
        assert sql("select count(*) from khub_bot.trade_reports where auction_id=(select auction_id from khub_bot.test_auction_fixtures where seed_key='direct-incomplete');")=='1'
        assert sql("select public.khub_login_address('KH_test1');",role='anon').endswith('@login.khub.invalid')
        seeded_fingerprint=sql('select jsonb_agg(to_jsonb(a) order by a.id) from public.auctions a join khub_bot.test_auction_fixtures f on f.auction_id=a.id;')
        user_fingerprint=sql('select jsonb_agg(to_jsonb(u) order by u.id) from auth.users u join khub_bot.test_accounts t on t.user_id=u.id;')
        delivery_fingerprint=sql('select jsonb_agg(to_jsonb(d) order by d.id) from khub_bot.deliveries d;')
        ban(banned_test)
        sql(seed_sql)
        assert access(banned_test)['is_banned']
        assert sql('select jsonb_agg(to_jsonb(a) order by a.id) from public.auctions a join khub_bot.test_auction_fixtures f on f.auction_id=a.id;')==seeded_fingerprint
        assert sql('select jsonb_agg(to_jsonb(u) order by u.id) from auth.users u join khub_bot.test_accounts t on t.user_id=u.id;')==user_fingerprint
        assert sql('select jsonb_agg(to_jsonb(d) order by d.id) from khub_bot.deliveries d;')==delivery_fingerprint
        seed_lot=sql("select auction_id from khub_bot.test_auction_fixtures where seed_key='direct-no-bids';")
        sql(f"select public.place_bid('{seed_lot}',1100);",competitor,'authenticated',error='test auction')
        sql("insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,meat,message) values('test-no-real-refund',9000000001,'refund',100,'No real refund');",error='cannot receive real escrow assets')
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key='test-no-real-refund';")=='0'
        sql('select * from khub_bot.test_accounts;',competitor,'authenticated',error='permission denied')
        # Restrictions reconcile existing auctions and serialize with all bidding paths.
        sql(migration_sql('202610210051_banned_auction_obligations.sql'))
        lift(competitor)
        lift(fresh_buyer)
        def review(lot,action,actor=owner_id,error=None):
            return sql(f"select public.review_banned_auction('{lot}','{action}','Evidence reviewed by administrator');",actor,'authenticated',error=error)
        def auction_state(lot):
            return json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{lot}';"))
        empty_banned=direct_create(uid=competitor)
        held_seller=direct_create(1000,uid=competitor)
        sql(f"select public.place_bid('{held_seller}',150);",fresh_buyer,'authenticated')
        ban(competitor)
        assert auction_state(empty_banned)['status']=='cancelled'
        held=auction_state(held_seller)
        assert held['status']=='on_hold' and held['winner_id'] is None and held['ban_review_required']
        sql(f"select public.place_bid('{held_seller}',160);",owner_id,'authenticated',error='administrator review')
        sql(f"select public.purchase_auction('{held_seller}');",fresh_buyer,'authenticated',error='administrator review')
        sql(f"update public.auctions set created_at=now()-interval '2 days',end_time=now()-interval '1 day' where id='{held_seller}';")
        sql('select public.finalize_expired_auctions();',role='anon')
        assert auction_state(held_seller)['status']=='on_hold' and auction_state(held_seller)['winner_id'] is None
        for role,actor in [('anon',None),('authenticated',fresh_buyer)]:
            sql('select public.read_auction_ban_reviews();',actor,role,error='permission denied' if role=='anon' else 'Administrator access required')
        review(held_seller,'cancel',actor=fresh_buyer,error='Administrator access required')
        review(held_seller,'resume',error='Lift the affected bans')
        assert any(a['id']==held_seller for a in json.loads(sql('select public.read_auction_ban_reviews();',owner_id,'authenticated')))
        public_hold=read_page('detail',id=held_seller)['rows'][0]
        assert public_hold['status']=='on_hold' and public_hold['ban_review_required']
        assert 'Evidence reviewed' not in json.dumps(public_hold) and public_hold['winner_id'] is None
        lift(competitor)
        assert auction_state(held_seller)['status']=='on_hold' # lift/expiry never silently restarts bidding
        review(held_seller,'resume')
        resumed=auction_state(held_seller)
        assert resumed['status']=='active' and not resumed['ban_review_required']
        assert sql(f"select end_time>now() from public.auctions where id='{held_seller}';")=='t'
        sql(f"select public.place_bid('{held_seller}',160);",owner_id,'authenticated')
        # A banned unfunded leading bidder must not become the automatic winner.
        held_buyer=direct_create(uid=competitor)
        sql(f"select public.place_bid('{held_buyer}',200);",fresh_buyer,'authenticated')
        ban(fresh_buyer)
        assert auction_state(held_buyer)['status']=='on_hold'
        review(held_buyer,'cancel')
        assert auction_state(held_buyer)['status']=='voided' and auction_state(held_buyer)['winner_id'] is None
        assert sql(f"select count(*) from public.bids where auction_id='{held_buyer}';")=='1'
        # Existing direct obligations stay intact; explicit reviewed completion
        # is separate from ticket resolution/report dismissal and requires both sides.
        lift(fresh_buyer)
        obligation=direct_create(500,uid=competitor)
        sql(f"select public.purchase_auction('{obligation}');",fresh_buyer,'authenticated')
        ban(fresh_buyer)
        assert auction_state(obligation)['status']=='awaiting_trade' and auction_state(obligation)['ban_review_required']
        sql(f"select public.confirm_auction_trade('{obligation}');",fresh_buyer,'authenticated',error='restricted')
        before_count=feedback(competitor)['seller_confirmed']
        review(obligation,'buyer_complete')
        assert auction_state(obligation)['status']=='awaiting_trade'
        assert feedback(competitor)['seller_confirmed']==before_count
        review(obligation,'buyer_complete',error='already recorded complete')
        review(obligation,'seller_complete')
        assert auction_state(obligation)['status']=='completed'
        assert feedback(competitor)['seller_confirmed']==before_count+1
        assert not any(a['id']==obligation for a in json.loads(sql('select public.read_auction_ban_reviews();',owner_id,'authenticated')))
        assert sql(f"select count(*) from khub_bot.trade_feedback where auction_id='{obligation}';")=='0'
        assert sql(f"select count(*) from khub_bot.auction_ban_reviews where auction_id='{obligation}' and action in ('seller_complete','buyer_complete');")=='2'
        # Escrow: seller restrictions reject/refund new bid mail, without changing
        # already-held items/Meat or preventing their original deadline settlement.
        lift(fresh_buyer)
        escrow_seller_id=int(sql(f"select kol_player_id from public.profiles where id='{competitor}';"))
        escrow_buyer_id=int(sql(f"select kol_player_id from public.profiles where id='{fresh_buyer}';"))
        escrow_lot=sql("select public.create_auction('escrow item',2,100,24,null,null,1,true);",competitor,'authenticated')
        assert ingest(mail(9800001,escrow_seller_id,{'type':'list','auction_id':escrow_lot},items=[{'id':1,'quantity':2}]))=='accepted'
        assert ingest(mail(9800002,escrow_buyer_id,{'type':'bid','auction_id':escrow_lot},meat=200))=='accepted'
        ban(competitor)
        ban(fresh_buyer)
        funded_before=auction_state(escrow_lot)
        assert funded_before['status']=='active' and funded_before['current_bid']==200
        assert read_page('detail',id=escrow_lot)['rows'][0]['bidding_restricted']
        owner_player=int(sql(f"select kol_player_id from public.profiles where id='{owner_id}';"))
        rejected=mail(9800003,owner_player,{'type':'bid','auction_id':escrow_lot},meat=300)
        assert 'restricted seller' in ingest(rejected)
        assert ingest(rejected)=='duplicate'
        assert sql("select sum(meat) from khub_bot.deliveries where receipt_id='9800003' and kind='refund';")=='300'
        assert auction_state(escrow_lot)['current_bid']==200
        sql(f"update public.auctions set created_at=now()-interval '2 days',end_time=now()-interval '1 second' where id='{escrow_lot}';")
        sql('select public.bot_tick();',role='service_role')
        settled=auction_state(escrow_lot)
        assert settled['status']=='settling' and settled['winner_id']==fresh_buyer
        assert sql(f"select sum(meat) from khub_bot.deliveries where auction_id='{escrow_lot}' and kind='sale_meat';")=='185'
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{escrow_lot}' and kind='sale_item';")=='1'
        sql('select * from khub_bot.auction_ban_reviews;',owner_id,'authenticated',error='permission denied')
        # A ban racing a new bid is atomic: either a prior bid is retained on
        # hold, or the bid-free listing closes before the bid can be accepted.
        lift(competitor)
        lift(fresh_buyer)
        race_lot=direct_create(uid=competitor)
        def racing_bid():
            try:
                sql(f"select public.place_bid('{race_lot}',150);",fresh_buyer,'authenticated')
                return True
            except AssertionError as failure:
                assert 'administrator review' in str(failure), str(failure)
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            raced=pool.submit(racing_bid)
            restricted=pool.submit(ban,competitor)
            accepted=raced.result(timeout=10)
            restricted.result(timeout=10)
        race_state=auction_state(race_lot)
        assert race_state['status']==('on_hold' if accepted else 'cancelled')
        assert race_state['winner_id'] is None
        assert sql(f"select count(*) from public.bids where auction_id='{race_lot}';")==('1' if accepted else '0')
        # Legacy profile/native Auth bans use exactly the same auction handling.
        lift(competitor)
        native_lot=direct_create(uid=competitor)
        sql(f"select public.place_bid('{native_lot}',150);",fresh_buyer,'authenticated')
        sql(f"update auth.users set banned_until=now()+interval '1 day' where id='{competitor}';")
        assert auction_state(native_lot)['status']=='on_hold'
        sql(f"update khub_bot.account_bans set expires_at=now()-interval '1 second' where active and kol_player_id={escrow_seller_id};")
        assert not access(competitor)['is_banned']
        assert auction_state(native_lot)['status']=='on_hold'
        review(native_lot,'resume')
        profile_lot=direct_create(uid=competitor)
        sql(f"update public.profiles set is_banned=true where id='{competitor}';")
        assert auction_state(profile_lot)['status']=='cancelled'
        lift(competitor)
        # A seller banned before depositing cannot activate the listing. A
        # deposited but bid-free listing queues its item return exactly once.
        pending_restricted=sql("select public.create_auction('escrow item',2,100,24,null,null,1,true);",competitor,'authenticated')
        deposited_restricted=sql("select public.create_auction('escrow item',2,100,24,null,null,1,true);",competitor,'authenticated')
        assert ingest(mail(9800004,escrow_seller_id,{'type':'list','auction_id':deposited_restricted},items=[{'id':1,'quantity':2}]))=='accepted'
        ban(competitor)
        assert auction_state(pending_restricted)['status']=='cancelled'
        assert auction_state(deposited_restricted)['status']=='settling'
        assert auction_state(deposited_restricted)['settlement_outcome']=='cancelled'
        returned=sql(f"select count(*) from khub_bot.deliveries where auction_id='{deposited_restricted}' and kind='return_item';")
        assert returned=='1'
        ban(competitor)
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{deposited_restricted}' and kind='return_item';")==returned
        # A banned escrow leader can be outbid/refunded on an unrestricted
        # seller's auction; already-held bid Meat is never silently confiscated.
        lift(competitor)
        escrow_outbid=sql("select public.create_auction('escrow item',2,100,24,null,null,1,true);",competitor,'authenticated')
        assert ingest(mail(9800005,escrow_seller_id,{'type':'list','auction_id':escrow_outbid},items=[{'id':1,'quantity':2}]))=='accepted'
        assert ingest(mail(9800006,escrow_buyer_id,{'type':'bid','auction_id':escrow_outbid},meat=200))=='accepted'
        ban(fresh_buyer)
        assert ingest(mail(9800007,owner_player,{'type':'bid','auction_id':escrow_outbid},meat=300))=='accepted'
        assert auction_state(escrow_outbid)['highest_bidder_id']==owner_id
        assert sql("select sum(meat) from khub_bot.deliveries where receipt_id='9800007' and recipient_id="+str(escrow_buyer_id)+" and kind='refund';")=='200'
        # Dedicated hold filtering does not misclassify paused auctions as ended.
        hold_filter=read_page('browse',None,'anon',status='on_hold')['rows']
        assert all(a['status']=='on_hold' for a in hold_filter)
        assert all(a['status']!='on_hold' for a in read_page('browse',None,'anon',status='ended')['rows'])
        # Current item data is shared by the website and bot; eligibility is
        # checked on the server even when a client bypasses the item selector.
        catalog_business_fingerprint=sql("select md5((select jsonb_agg(to_jsonb(a) order by id)::text from public.auctions a)||coalesce((select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d),''));")
        sql(migration_sql('202610210052_live_tradeable_item_catalog.sql'))
        assert sql('select public.bot_item_catalog_state() is null;',role='service_role')=='t'
        assert json.loads(sql('select public.read_item_catalog();',role='anon'))=={'ready':False,'fetched_at':None,'items':[]}
        sql("select public.create_auction('seal tooth',1,100,24,null,null,2,false);",competitor,'authenticated',error='catalog is being updated')
        for role in ['anon','authenticated']:
            sql("select public.bot_replace_item_catalog('[]',now(),repeat('a',64));",competitor if role=='authenticated' else None,role,error='permission denied')
            sql('select public.bot_item_catalog_state();',competitor if role=='authenticated' else None,role,error='permission denied')
        source_items=json.loads((ROOT/'src/data/items.json').read_text())
        complete_catalog=source_items+[
            {'id':26,'name':"Dolphin King map fixture",'image':'map.gif','tradeable':False},
            {'id':43,'name':'worthless trinket','image':'trinket.gif','tradeable':False},
            {'id':2000000000,'name':'gift-only fixture','image':'gift.gif','tradeable':False}]
        for padding in range(10000-len(complete_catalog)):
            complete_catalog.append({'id':1500000+padding,'name':f'Untradeable fixture {padding}','image':'fixture.gif','tradeable':False})
        catalog_file=Path(directory)/'catalog-snapshot.json'
        sql('create table public.catalog_import_fixture(payload jsonb); grant select on public.catalog_import_fixture to service_role;')
        def catalog_payload(items):
            catalog_file.write_text(json.dumps(items))
            sql(f"truncate public.catalog_import_fixture; insert into public.catalog_import_fixture select pg_read_file('{catalog_file}')::jsonb;")
        def catalog_import(fetched='clock_timestamp()',error=None):
            return sql(f"select public.bot_replace_item_catalog((select payload from public.catalog_import_fixture),{fetched},repeat('a',64));",role='service_role',error=error)
        catalog_payload(complete_catalog)
        catalog_import()
        assert sql("select md5((select jsonb_agg(to_jsonb(a) order by id)::text from public.auctions a)||coalesce((select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d),''));")==catalog_business_fingerprint
        listed=json.loads(sql('select public.read_item_catalog();',role='anon'))
        assert listed['ready'] and len(listed['items'])==len(source_items)
        assert all(item['tradeable'] for item in listed['items'])
        assert not any(item['id'] in (26,43,2000000000) for item in listed['items'])
        assert next(item for item in listed['items'] if item['id']==6618)['image']=='otherimages/folders/folder01.gif'
        for mode in ['true','false']:
            for item_id,name in [(43,'worthless trinket'),(2000000000,'gift-only fixture')]:
                sql(f"select public.create_auction('{name}',1,100,24,null,null,{item_id},{mode});",competitor,'authenticated',error='Only tradeable items')
        sql("select public.create_auction('seal tooth',1,100,24,null,null,43,false);",competitor,'authenticated',error='current catalog item')
        safe_image_lot=sql("select public.create_auction('seal tooth',1,100,24,'https://example.com/untrusted.gif',null,2,false);",competitor,'authenticated')
        assert auction_state(safe_image_lot)['image']=='https://images.kingdomofloathing.com/itemimages/tooth.gif'
        folder_lot=sql("select public.create_auction('folder (red)',1,100,24,null,null,6618,true);",competitor,'authenticated')
        assert auction_state(folder_lot)['image']=='https://images.kingdomofloathing.com/otherimages/folders/folder01.gif'
        sql("select public.bot_sync_catalog('[{\"id\":43,\"name\":\"worthless trinket\"}]');",role='service_role',error='updated bot sync-catalog')
        catalog_fingerprint=sql('select md5(jsonb_agg(to_jsonb(c) order by id)::text) from khub_bot.catalog c;')
        catalog_import("clock_timestamp()-interval '1 year'",error='Stale')
        for malformed in [complete_catalog[:-1],complete_catalog[:-1]+[complete_catalog[0]],
            [{**item,'tradeable':'true'} if item['id']==2 else item for item in complete_catalog],
            [{**item,'image':'../bad.gif'} if item['id']==2 else item for item in complete_catalog],
            [{**item,'tradeable':False} for item in complete_catalog]]:
            catalog_payload(malformed)
            catalog_import(error='catalog' if len(malformed)<10000 else 'IDs' if malformed[-1]['id']==complete_catalog[0]['id'] else 'tradeability' if all(item['tradeable'] is False for item in malformed) else 'fields')
            assert sql('select md5(jsonb_agg(to_jsonb(c) order by id)::text) from khub_bot.catalog c;')==catalog_fingerprint
        # Eligibility changes and newly discovered items go live atomically while
        # old auction descriptions and financial obligations remain unchanged.
        catalog_business_fingerprint=sql("select md5((select jsonb_agg(to_jsonb(a) order by id)::text from public.auctions a)||coalesce((select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d),''));")
        next_catalog=[{**item,'tradeable':False} if item['id']==364 else item for item in complete_catalog if item['id']!=12344]
        next_catalog.append({'id':1600000,'name':'Next weekly item','image':'weekly.gif','tradeable':True})
        catalog_payload(next_catalog); catalog_import()
        refreshed=json.loads(sql('select public.read_item_catalog();',role='anon'))['items']
        assert any(item['id']==1600000 for item in refreshed)
        assert not any(item['id'] in (364,12344) for item in refreshed)
        assert sql("select md5((select jsonb_agg(to_jsonb(a) order by id)::text from public.auctions a)||coalesce((select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d),''));")==catalog_business_fingerprint
        assert sql('select not is_current and not tradeable from khub_bot.catalog where id=12344;')=='t'
        sql("select public.create_auction('asbestos ore',1,100,24,null,null,364,false);",competitor,'authenticated',error='Only tradeable items')
        weekly_lot=sql("select public.create_auction('Next weekly item',1,100,24,null,null,1600000,false);",competitor,'authenticated')
        assert auction_state(weekly_lot)['item_id']==1600000
        # Increment rules apply only to subsequent accepted bids; migration
        # itself cannot rewrite a price, bid, deadline, receipt or delivery.
        def bidding_fingerprint():
            return sql("select md5((select jsonb_agg(to_jsonb(a) order by id)::text from public.auctions a)||(select jsonb_agg(to_jsonb(b) order by id)::text from public.bids b)||coalesce((select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d),''));")
        before_increments=bidding_fingerprint()
        sql(migration_sql('202610210053_tiered_bid_increments.sql'))
        assert bidding_fingerprint()==before_increments
        increment_cases=[(0,10),(999,10),(1000,100),(9999,100),(10000,1000),(99999,1000),
            (100000,10000),(999999,10000),(1000000,100000),(9999999,100000),
            (10000000,1000000),(99999999,1000000),(100000000,10000000),(999999999,10000000),
            (1000000000,100000000),(9999999999,100000000),(10000000000,100000000),
            (10000000001,100000001),(12345678901,123456790),(9007199254740991,90071992547410)]
        for current,increment in increment_cases:
            assert sql(f'select khub_bot.bid_increment({current});')==str(increment)
            assert sql(f'select khub_bot.minimum_auction_bid(1,{current});')==str(current+increment if current else 1)
        for role in ['anon','authenticated','service_role']:
            sql('select khub_bot.minimum_auction_bid(100,20000000);',role=role,error='permission denied')
        lift(fresh_buyer); lift(competitor); lift(SELLER)
        serial=iter(range(9910001,9990000))
        def increment_mail(lot,amount,sid,command='bid'):
            return mail(next(serial),sid,{'type':command,'auction_id':lot},meat=amount)
        def increment_lot(escrow=False,buyout='null',minimum=100):
            lot=sql(f"select public.create_auction('seal tooth',1,{minimum},24,null,{buyout},2,{'true' if escrow else 'false'});",competitor,'authenticated')
            if escrow:
                assert ingest(mail(next(serial),escrow_seller_id,{'type':'list','auction_id':lot},items=[{'id':2,'quantity':1}]))=='accepted'
            return lot
        first_only=increment_lot(minimum=20000000)
        sql(f"select public.place_bid('{first_only}',19999999);",fresh_buyer,'authenticated',error='20,000,000')
        sql(f"select public.place_bid('{first_only}',20000000);",fresh_buyer,'authenticated')
        sql(f"select public.place_bid('{first_only}',20000001);",owner_id,'authenticated',error='21,000,000')
        assert auction_state(first_only)['current_bid']==20000000
        sql(f"select public.place_bid('{first_only}',21000001);",owner_id,'authenticated') # Above the floor need not be a multiple.
        sql(f"select public.place_bid('{first_only}',22000000);",fresh_buyer,'authenticated',error='22,000,001')
        assert auction_state(first_only)['current_bid']==21000001
        # Test actual Direct writes at each tier as well as exact percentage math.
        for current,increment in [(999,10),(1000,100),(10000,1000),(100000,10000),(1000000,100000),
            (10000000,1000000),(100000000,10000000),(1000000000,100000000),(10000000001,100000001)]:
            lot=increment_lot(minimum=1)
            sql(f"select public.place_bid('{lot}',{current});",fresh_buyer,'authenticated')
            sql(f"select public.place_bid('{lot}',{current+increment-1});",owner_id,'authenticated',error=f'{current+increment:,}')
            sql(f"select public.place_bid('{lot}',{current+increment});",owner_id,'authenticated')
            assert auction_state(lot)['current_bid']==current+increment
        # Exact buyouts bypass the normal increase, both explicit purchases and
        # bids that reach/exceed buyout; accepted prices never get rounded up.
        for route in ['bid','purchase','above']:
            lot=increment_lot(buyout=20500000)
            sql(f"select public.place_bid('{lot}',20000000);",fresh_buyer,'authenticated')
            if route=='purchase': sql(f"select public.purchase_auction('{lot}');",owner_id,'authenticated')
            else: sql(f"select public.place_bid('{lot}',{20500000 if route=='bid' else 22000000});",owner_id,'authenticated')
            assert auction_state(lot)['status']=='awaiting_trade' and auction_state(lot)['final_price']==20500000
        # Funded KMail rejection preserves the prior winner/bid and queues one
        # full refund, with a human-readable exact next minimum in the reply.
        escrow_increment=increment_lot(escrow=True)
        assert ingest(increment_mail(escrow_increment,20000000,escrow_buyer_id))=='accepted'
        tiny=increment_mail(escrow_increment,20000001,owner_player)
        result=ingest(tiny)
        assert '21,000,000 Meat' in result
        assert auction_state(escrow_increment)['current_bid']==20000000
        refund_before=sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{tiny['id']}' and kind='refund';")
        assert refund_before=='20000001'
        assert '21,000,000 Meat' in sql(f"select string_agg(coalesce(display_message,khub_bot.friendly_message(d)),' ') from khub_bot.deliveries d where receipt_id='{tiny['id']}';")
        assert ingest(tiny)=='duplicate'
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{tiny['id']}' and kind='refund';")==refund_before
        assert ingest(increment_mail(escrow_increment,21000000,owner_player))=='accepted'
        assert auction_state(escrow_increment)['current_bid']==21000000
        # The current tier changes after crossing a boundary, not before.
        crossed=increment_lot(escrow=True,minimum=1)
        assert ingest(increment_mail(crossed,999,escrow_buyer_id))=='accepted'
        assert ingest(increment_mail(crossed,1009,owner_player))=='accepted'
        assert '1,109 Meat' in ingest(increment_mail(crossed,1108,escrow_buyer_id))
        assert ingest(increment_mail(crossed,1109,escrow_buyer_id))=='accepted'
        for command in ['bid','buy']:
            lot=increment_lot(escrow=True,buyout=20500000)
            assert ingest(increment_mail(lot,20000000,escrow_buyer_id))=='accepted'
            assert ingest(increment_mail(lot,20500000,owner_player,command))=='accepted'
            assert auction_state(lot)['final_price']==20500000 and auction_state(lot)['status']=='settling'
        oversized=increment_lot(escrow=True,buyout=20500000)
        assert ingest(increment_mail(oversized,20000000,escrow_buyer_id))=='accepted'
        extra=increment_mail(oversized,22000000,owner_player)
        assert ingest(extra)=='accepted'
        assert auction_state(oversized)['final_price']==20500000
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{extra['id']}' and recipient_id={owner_player} and kind='refund';")=='1500000'
        under_buy=increment_lot(escrow=True,buyout=30000000)
        assert ingest(increment_mail(under_buy,20000000,escrow_buyer_id))=='accepted'
        assert 'instant purchase price' in ingest(increment_mail(under_buy,20500000,owner_player,'buy'))
        # Concurrent stale bids recheck the newly accepted amount under lock.
        race_direct=increment_lot()
        sql(f"select public.place_bid('{race_direct}',20000000);",fresh_buyer,'authenticated')
        def race_increment(uid):
            try:
                sql(f"select public.place_bid('{race_direct}',21000000);",uid,'authenticated'); return True
            except AssertionError as failure:
                assert '22,000,000' in str(failure), str(failure); return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes=list(pool.map(race_increment,[owner_id,SELLER]))
        assert sum(outcomes)==1 and auction_state(race_direct)['current_bid']==21000000
        assert sql(f"select count(*) from public.bids where auction_id='{race_direct}';")=='2'
        race_escrow=increment_lot(escrow=True)
        assert ingest(increment_mail(race_escrow,20000000,escrow_buyer_id))=='accepted'
        seller_player=int(sql(f"select kol_player_id from public.profiles where id='{SELLER}';"))
        racers=[increment_mail(race_escrow,21000000,owner_player),increment_mail(race_escrow,21000000,seller_player)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes=list(pool.map(ingest,racers))
        assert outcomes.count('accepted')==1 and any('22,000,000 Meat' in result for result in outcomes)
        rejected_racer=racers[next(i for i,result in enumerate(outcomes) if result!='accepted')]
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{rejected_racer['id']}' and kind='refund';")=='21000000'
        assert auction_state(race_escrow)['current_bid']==21000000
        assert sql(f"select count(*) from public.bids where auction_id='{race_escrow}';")=='2'
        # Existing precision and account restriction boundaries stay intact.
        maximum=increment_lot(minimum=1)
        sql(f"select public.place_bid('{maximum}',9007199254740990);",fresh_buyer,'authenticated')
        sql(f"select public.place_bid('{maximum}',9007199254740991);",owner_id,'authenticated',error='maximum supported bid')
        sql(f"select public.place_bid('{race_direct}',22000000);",role='anon',error='permission denied')
        ban(SELLER)
        sql(f"select public.place_bid('{race_direct}',22000000);",SELLER,'authenticated',error='restricted')
        # Supabase's safe-update guard rejects the original unfiltered reset.
        # Exercise the repaired function for both first import and replacement.
        catalog_business_fingerprint=sql("select md5((select jsonb_agg(to_jsonb(a) order by id)::text from public.auctions a)||coalesce((select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d),''));")
        sql(migration_sql('202610210054_safe_catalog_import.sql'))
        importer=sql("select pg_get_functiondef('public.bot_replace_item_catalog(jsonb,timestamptz,text)'::regprocedure);")
        assert re.search(r'update khub_bot.catalog set is_current=false,tradeable=false\s+where is_current or tradeable;',importer)
        sql('delete from khub_bot.item_catalog_state where id; update khub_bot.catalog set is_current=false,tradeable=false where is_current or tradeable;')
        catalog_payload(complete_catalog)
        catalog_import()
        assert json.loads(sql('select public.read_item_catalog();',role='anon'))['ready'] is True
        assert int(sql('select count(*) from khub_bot.catalog where is_current;'))==len(complete_catalog)
        catalog_import()
        assert sql("select md5((select jsonb_agg(to_jsonb(a) order by id)::text from public.auctions a)||coalesce((select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d),''));")==catalog_business_fingerprint
        for mode in ['true','false']:
            created=sql(f"select public.create_auction('seal tooth',1,100,24,null,null,2,{mode});",competitor,'authenticated')
            assert len(created)==36
            sql(f"select public.create_auction('worthless trinket',1,100,24,null,null,43,{mode});",competitor,'authenticated',error='tradeable')
        sql("select public.bot_replace_item_catalog('[]',now(),repeat('a',64));",competitor,'authenticated',error='permission denied')
        # Grace applies only to profile marks/value, never to report availability
        # or independent thumbs feedback. Migration itself never rewrites data.
        grace_fingerprint=sql("select md5((select jsonb_agg(to_jsonb(a) order by id)::text from public.auctions a)||coalesce((select jsonb_agg(to_jsonb(t) order by report_id)::text from khub_bot.trade_reports t),'')||coalesce((select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d),''));")
        sql(migration_sql('202610210055_incomplete_trade_grace_period.sql'))
        assert sql("select md5((select jsonb_agg(to_jsonb(a) order by id)::text from public.auctions a)||coalesce((select jsonb_agg(to_jsonb(t) order by report_id)::text from khub_bot.trade_reports t),'')||coalesce((select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d),''));")==grace_fingerprint
        grace_base={uid:feedback(uid) for uid in [competitor,fresh_buyer]}
        def grace_lot(end_expr,final_expr,report_roles=('seller','buyer')):
            lot=sql("select public.create_auction('seal tooth',1,100,720,null,200,2,false);",competitor,'authenticated')
            # Set historical closure while the test listing is still active;
            # finalized terms are immutable after this first transition.
            sql(f"update public.auctions set created_at=now()-interval '40 days',end_time={end_expr},finalized_at={final_expr},status='awaiting_trade',winner_id='{fresh_buyer}',winner_username='Feedback Buyer',final_price=200 where id='{lot}';")
            reports={}
            for role in report_roles:
                reports[role]=str(uuid4())
                trade_report(reports[role],lot,'',uid=competitor if role=='seller' else fresh_buyer)
            return lot,reports
        recent,recent_reports=grace_lot("now()+interval '10 days'",'now()')
        for uid in [competitor,fresh_buyer]:
            for key in ['seller_incomplete','buyer_incomplete','seller_incomplete_value','buyer_incomplete_value']:
                assert feedback(uid)[key]==grace_base[uid][key]
        for viewer,role in [(None,'anon'),(competitor,'authenticated'),(fresh_buyer,'authenticated'),(owner_id,'authenticated')]:
            detail=read_page('detail',viewer,role,id=recent)['rows'][0]
            assert detail['seller_reported_incomplete'] and detail['buyer_reported_incomplete']
            stats=read_page('seller',viewer,role,id=competitor)['seller']['stats']
            assert stats['seller_incomplete']==grace_base[competitor]['seller_incomplete']
        # Feedback remains independent of the 48-hour incomplete-report grace.
        thumb_before=feedback(fresh_buyer)['buyer_negative']
        sql(f"select public.rate_trade_partner('{recent}',-1);",competitor,'authenticated')
        assert feedback(fresh_buyer)['buyer_negative']==thumb_before+1
        assert feedback(fresh_buyer)['buyer_incomplete']==grace_base[fresh_buyer]['buyer_incomplete']
        # Normal expiry uses its deadline, not delayed background finalization.
        expired,_=grace_lot("now()-interval '49 hours'",'now()')
        assert feedback(competitor)['seller_incomplete']==grace_base[competitor]['seller_incomplete']+1
        assert feedback(fresh_buyer)['buyer_incomplete']==grace_base[fresh_buyer]['buyer_incomplete']+1
        # Buyouts use actual early closure, not a future original deadline, and
        # an already-mature report counts immediately even if filed just now.
        early,early_reports=grace_lot("now()+interval '10 days'","now()-interval '49 hours'")
        for uid,key in [(competitor,'seller_incomplete'),(fresh_buyer,'buyer_incomplete')]:
            assert feedback(uid)[key]==grace_base[uid][key]+2
            assert int(feedback(uid)[key+'_value'])==int(grace_base[uid][key+'_value'])+400
        # Boundary is checked in one transaction with the same stable now():
        # just before 48h excludes; exactly 48h includes, with no tick/job call.
        boundary,_=grace_lot("now()-interval '47 hours'",'now()')
        for delta,expected in [("interval '48 hours'-interval '1 microsecond'",2),("interval '48 hours'",3)]:
            result=sql(f"begin; update public.auctions set end_time=now()-({delta}) where id='{boundary}'; select khub_bot.profile_feedback('{competitor}'); commit;")
            stats=json.loads(result)
            assert stats['seller_incomplete']==grace_base[competitor]['seller_incomplete']+expected
            assert int(stats['seller_incomplete_value'])==int(grace_base[competitor]['seller_incomplete_value'])+200*expected
        # Withdrawals and admin dismissals still remove mature marks and value;
        # a review restoration cannot bypass the grace on a newer trade.
        sql(f"select public.review_trade_rating('{early_reports['buyer']}',false,'Dismissed after reviewing the exchange.');",owner_id,'authenticated')
        assert feedback(competitor)['seller_incomplete']==grace_base[competitor]['seller_incomplete']+2
        sql(f"select public.review_trade_rating('{recent_reports['buyer']}',false,'Reviewing this early report.');",owner_id,'authenticated')
        sql(f"select public.review_trade_rating('{recent_reports['buyer']}',true,'Report retained pending the trade deadline.');",owner_id,'authenticated')
        assert feedback(competitor)['seller_incomplete']==grace_base[competitor]['seller_incomplete']+2
        sql(f"select public.withdraw_trade_rating('{early}');",competitor,'authenticated')
        assert feedback(fresh_buyer)['buyer_incomplete']==grace_base[fresh_buyer]['buyer_incomplete']+2
        assert int(feedback(fresh_buyer)['buyer_incomplete_value'])==int(grace_base[fresh_buyer]['buyer_incomplete_value'])+400
        # No report means no automatic bad mark when a deadline passes.
        before_no_report=feedback(competitor)['seller_incomplete']
        grace_lot("now()-interval '5 days'","now()-interval '5 days'",report_roles=())
        assert feedback(competitor)['seller_incomplete']==before_no_report
        # General support is a private server-assigned Other thread, with the
        # same retry/rate-limit/identity guarantees as existing reporting.
        support_fingerprint=sql('select md5(jsonb_agg(to_jsonb(d) order by id)::text) from khub_bot.deliveries d;')
        sql(migration_sql('202610210056_general_support_tickets.sql'))
        assert sql('select md5(jsonb_agg(to_jsonb(d) order by id)::text) from khub_bot.deliveries d;')==support_fingerprint
        sql(f"update khub_bot.bug_reports set created_at=now()-interval '2 hours' where reporter_id='{competitor}';")
        ticket=str(uuid4()); ticket_body='Please help with my account. <private evidence>'
        def send_ticket(key=ticket,body=ticket_body,uid=competitor,role='authenticated',error=None):
            result=sql(f"select public.submit_support_ticket('{key}',{literal(body)});",uid,role,error=error)
            return None if error else json.loads(result)
        send_ticket(uid=None,role='anon',error='permission denied')
        send_ticket(uid=SELLER,error='restricted')
        send_ticket(body='short',error='10 to 2,000')
        send_ticket(body='x'*2001,error='10 to 2,000')
        result=send_ticket()
        assert result['reference'].startswith('B-') and result['notification']=='queued'
        assert sql(f"select category||':'||status from khub_bot.bug_reports where id='{ticket}';")=='other:open'
        assert sql(f"select reporter_id from khub_bot.bug_reports where id='{ticket}';")==competitor
        notices_before=sql(f"select jsonb_agg(to_jsonb(d) order by d.id) from khub_bot.deliveries d join khub_bot.bug_report_deliveries b on b.delivery_id=d.id where b.report_id='{ticket}';")
        assert send_ticket()==result
        assert sql(f"select jsonb_agg(to_jsonb(d) order by d.id) from khub_bot.deliveries d join khub_bot.bug_report_deliveries b on b.delivery_id=d.id where b.report_id='{ticket}';")==notices_before
        notice=json.loads(notices_before)[0]
        assert notice['recipient_id']==3552305 and notice['kind']=='notice'
        assert '/admin/inbox?category=other' in notice['message'] and 'Support ticket B-' in notice['message']
        assert '&lt;private evidence&gt;' in notice['message'] and '<private evidence>' not in notice['message']
        send_ticket(body=ticket_body+' Changed.',error='cannot be reused')
        send_ticket(uid=fresh_buyer,error='cannot be reused')
        send_ticket(key=str(uuid4()),error='wait a minute')
        for role in ['anon','authenticated']:
            sql('select * from khub_bot.support_tickets;',competitor if role=='authenticated' else None,role,error='permission denied')
        for category,contains in [('other',True),('bug',False),('trade',False),('appeal',False)]:
            inbox=json.loads(sql(f"select public.read_support_threads('{category}','open',1);",owner_id,'authenticated'))
            assert any(thread['id']==ticket for thread in inbox['threads']) is contains
        sql("select public.read_support_threads('other','open',1);",competitor,'authenticated',error='Administrator access required')
        # Changing a ticket category never allows retry to reset that decision.
        sql(f"select public.set_support_category('{ticket}','bug');",owner_id,'authenticated')
        assert send_ticket()==result
        assert sql(f"select category from khub_bot.bug_reports where id='{ticket}';")=='bug'
        # Existing other kinds of report IDs cannot be reused as support tickets.
        prior=sql(f"select id from khub_bot.bug_reports where reporter_id='{competitor}' and id<>'{ticket}' limit 1;")
        prior_body=sql(f"select body from khub_bot.bug_reports where id='{prior}';")
        send_ticket(key=prior,body=prior_body,error='cannot be reused')
        # Hourly quota is shared with bug/trade reporting, not a separate bypass.
        for n in range(4):
            sql(f"update khub_bot.bug_reports set created_at=now()-interval '2 minutes' where reporter_id='{competitor}' and created_at>now()-interval '1 hour';")
            send_ticket(key=str(uuid4()),body=f'Additional support request {n}.')
        sql(f"update khub_bot.bug_reports set created_at=now()-interval '2 minutes' where reporter_id='{competitor}' and created_at>now()-interval '1 hour';")
        send_ticket(key=str(uuid4()),error='several reports')
        # Appeal controls resolve the stored reporter UUID, not the message's
        # cached username or a fuzzy search result; access remains admin-only.
        sql(migration_sql('202610210057_appeal_account_controls.sql'))
        def appeal_account(report_id=appeal_id,uid=owner_id,role='authenticated',error=None):
            result=sql(f"select public.read_appeal_account('{report_id}');",uid,role,error=error)
            return None if error or not result else json.loads(result)
        appeal_account(uid=None,role='anon',error='permission denied')
        appeal_account(uid=competitor,error='Administrator access required')
        appeal_target=sql(f"select reporter_id from khub_bot.bug_reports where id='{appeal_id}';")
        current=appeal_account()
        assert current['id']==appeal_target and current['is_banned'] is True
        assert 'username' in current and 'player_id' in current and 'reason' in current
        assert current['expires_at'] is None
        assert appeal_account(report_id=ticket) is None
        assert appeal_account(report_id=str(uuid4())) is None
        original_status=sql(f"select status from khub_bot.bug_reports where id='{appeal_id}';")
        lift(appeal_target)
        assert appeal_account()['is_banned'] is False
        assert sql(f"select status from khub_bot.bug_reports where id='{appeal_id}';")==original_status
        ban(appeal_target,"now()+interval '7 days'")
        edited=appeal_account()
        assert edited['is_banned'] and edited['expires_at'] is not None
        assert edited['reason']=='Reviewed failure to honor trade'
        sql(f"select public.set_bug_report_status('{appeal_id}','resolved');",owner_id,'authenticated')
        assert appeal_account()['id']==appeal_target
        assert appeal_account()['is_banned'] is True
        # Ban history is a read-only timeline of real audit events, separate
        # from the support message table and financial delivery queue.
        history_before=sql("select md5((select jsonb_agg(to_jsonb(v) order by id)::text from khub_bot.account_ban_activity v)||(select jsonb_agg(to_jsonb(r) order by id)::text from khub_bot.bug_reports r)||(select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d));")
        sql(migration_sql('202610210058_appeal_ban_history.sql'))
        assert sql("select md5((select jsonb_agg(to_jsonb(v) order by id)::text from khub_bot.account_ban_activity v)||(select jsonb_agg(to_jsonb(r) order by id)::text from khub_bot.bug_reports r)||(select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d));")==history_before
        def ban_history(report_id=appeal_id,uid=owner_id,role='authenticated',error=None):
            result=sql(f"select public.read_appeal_ban_history('{report_id}');",uid,role,error=error)
            return None if error else json.loads(result)
        ban_history(uid=None,role='anon',error='permission denied')
        ban_history(uid=competitor,error='Administrator access required')
        assert ban_history(report_id=str(uuid4()))==[] and ban_history(report_id=ticket)==[]
        history=ban_history()
        assert history and len({event['id'] for event in history})==len(history)
        assert any(event['action']=='issued' for event in history)
        assert any(event['action']=='removed' for event in history)
        # Every audit event belongs to this appellant, including inactive bans.
        for event in history:
            if event['id'].startswith('ban-event-'):
                audit_id=event['id'].removeprefix('ban-event-')
                assert sql(f"select (b.kol_player_id=p.kol_player_id or lower(btrim(b.username)) in(lower(btrim(p.khub_username)),lower(btrim(p.kol_player_name)))) from khub_bot.account_ban_activity v join khub_bot.account_bans b on b.id=v.ban_id cross join public.profiles p where v.id={audit_id} and p.id='{appeal_target}';")=='t'
        long_reason=('Full administrator explanation: '+'Evidence and timeline. '*40).strip()
        sql(f"select public.set_account_restriction('{appeal_target}',{literal(long_reason)},now()+interval '1 day');",owner_id,'authenticated')
        changed=ban_history()
        assert any(event['reason']==long_reason and event['action']=='issued' for event in changed)
        lift(appeal_target)
        assert ban_history()[0]['action']=='removed'
        # Legacy creation uses its original snapshot if later reason edits exist.
        player=sql(f"select kol_player_id from public.profiles where id='{appeal_target}';")
        legacy=sql(f"insert into khub_bot.account_bans(kol_player_id,username,reason,created_at) values({player},'Legacy appeal account','Original legacy reason',now()-interval '6 days') returning id;")
        sql(f"delete from khub_bot.account_ban_activity where ban_id={legacy};")
        sql(f"update khub_bot.account_bans set reason='Edited legacy reason' where id={legacy};")
        history=ban_history()
        initial=next(event for event in history if event['id']=='ban-start-'+legacy)
        assert initial['reason']=='Original legacy reason' and initial['action']=='issued'
        assert any(event['reason']=='Edited legacy reason' and event['action']=='updated' for event in history)
        # Opening history cannot queue another KMail or fabricate a support reply.
        read_fingerprint=sql("select md5((select jsonb_agg(to_jsonb(r) order by id)::text from khub_bot.bug_reports r)||(select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d));")
        assert ban_history()==history
        assert sql("select md5((select jsonb_agg(to_jsonb(r) order by id)::text from khub_bot.bug_reports r)||(select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d));")==read_fingerprint
        # System account alerts must work before registration creates a profile,
        # without attributing a fake report to a human or changing the job secret.
        sql(migration_sql('202610210059_account_failure_notices.sql'))
        failed_mail=account_mail(995900,sid=995900,name='Failure <Player>')
        failed_job=prepare_account(failed_mail)
        assert sql(f"select count(*) from public.profiles where id='{failed_job['user_id']}';")=='0'
        job_before=sql("select to_jsonb(j) from khub_bot.account_jobs j where mail_id='995900';")
        def account_notice(mid='995900',player=True,role='service_role',uid=None,error=None):
            result=sql(f"select public.bot_notify_account_failure('{mid}',{str(player).lower()});",uid,role,error=error)
            return None if error else json.loads(result)
        account_notice(role='anon',error='permission denied')
        account_notice(role='authenticated',uid=competitor,error='permission denied')
        result=account_notice()
        assert result['status']=='queued'
        report_id=sql("select report_id from khub_bot.account_failure_notices where mail_id='995900';")
        assert sql(f"select (reporter_id is null and is_system and category='other') from khub_bot.bug_reports where id='{report_id}';")=='t'
        assert sql("select to_jsonb(j) from khub_bot.account_jobs j where mail_id='995900';")==job_before
        player_notice=sql("select message from khub_bot.deliveries where dedupe_key='account-failure-player:995900';")
        assert 'Beep-boop!' in player_notice and 'keep trying automatically' in player_notice
        assert 'no need to send another request' in player_notice
        assert 'teres' not in player_notice.lower()
        admin_notice=sql("select message from khub_bot.deliveries where dedupe_key='account-failure-admin:995900';")
        assert 'Failure &lt;Player&gt;' in admin_notice and '/admin/inbox?category=other' in admin_notice
        assert temp_password not in player_notice+admin_notice
        assert failed_job['login_email'] not in player_notice+admin_notice
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key in('account-failure-player:995900','account-failure-admin:995900') and meat=0 and item_id is null;")=='2'
        alert_fingerprint=sql(f"select md5((select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d)||(select to_jsonb(r)::text from khub_bot.bug_reports r where id='{report_id}'));")
        assert account_notice()['status']=='already_queued'
        assert sql(f"select md5((select jsonb_agg(to_jsonb(d) order by id)::text from khub_bot.deliveries d)||(select to_jsonb(r)::text from khub_bot.bug_reports r where id='{report_id}'));")==alert_fingerprint
        assert account_notice('999999999')['status']=='unrecorded'
        inbox=json.loads(sql("select public.read_support_threads('other','open',1);",owner_id,'authenticated'))
        alert_thread=next(row for row in inbox['threads'] if row['id']==report_id)
        assert alert_thread['messages'][0]['reporter_username']=='kHub bot'
        assert 'Failure <Player>' in alert_thread['messages'][0]['body']
        alert_body=sql(f"select body from khub_bot.bug_reports where id='{report_id}';")
        for fn in ['submit_bug_report','submit_support_ticket','submit_ban_appeal']:
            sql(f"select public.{fn}('{report_id}',{literal(alert_body)});",competitor,'authenticated',error='cannot be reused')
        sql(f"select public.set_support_category('{report_id}','appeal');",owner_id,'authenticated')
        sql(f"select public.submit_ban_appeal('{report_id}',{literal(alert_body)});",competitor,'authenticated',error='cannot be reused')
        assert appeal_account(report_id=report_id) is None and ban_history(report_id=report_id)==[]
        for role in ['anon','authenticated']:
            sql('select * from khub_bot.account_failure_notices;',competitor if role=='authenticated' else None,role,error='permission denied')
        # Operator can choose admin-only notices; retries cannot add player spam.
        admin_job=prepare_account(account_mail(995901,sid=995901,name='Admin Only'))
        assert account_notice('995901',player=False)['status']=='queued'
        assert account_notice('995901',player=True)['status']=='already_queued'
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key='account-failure-player:995901';")=='0'
        # Concurrent workers/restarts still queue each notice exactly once.
        concurrent_job=prepare_account(account_mail(995902,sid=995902,name='Concurrent Failure'))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes=list(pool.map(lambda _:account_notice('995902'),range(2)))
        assert sorted(result['status'] for result in outcomes)==['already_queued','queued']
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key in('account-failure-player:995902','account-failure-admin:995902');")=='2'
        # Lost finish acknowledgment must not generate a failure after success.
        done_job=prepare_account(account_mail(995903,sid=995903,name='Already Registered'))
        provision(done_job)
        sql("select public.bot_finish_account_job('995903');",role='service_role')
        assert account_notice('995903')['status']=='not_pending'
        assert sql("select count(*) from khub_bot.account_failure_notices where mail_id='995903';")=='0'
        restricted_job=prepare_account(account_mail(995904,sid=995904,name='Restricted Failure'))
        sql("insert into khub_bot.account_bans(kol_player_id,username,reason) values(995904,'Restricted Failure','Restricted during pending registration');")
        assert account_notice('995904')['status']=='restricted'
        # System reports require an explicit source flag; human reports still
        # require a verified profile and retain their existing ownership guards.
        sql("insert into khub_bot.bug_reports(id,reporter_username,reporter_kol_id,body) values(gen_random_uuid(),'Fake system',1,'Invalid unowned report');",error='bug_reports_system_reporter_check')
        # Message-only migration preserves every saved body, financial record,
        # account secret and delivery/reconciliation state exactly.
        def message_audit_snapshot():
            return {table:sql(f"select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from {table} t;")
                for table in ['public.auctions','public.bids','khub_bot.deliveries',
                    'khub_bot.receipts','khub_bot.account_jobs','khub_bot.reconciliations']}
        before_messages=message_audit_snapshot()
        sql(migration_sql('202610210060_clear_bot_messages.sql'))
        assert message_audit_snapshot()==before_messages
        def preview_message(**values):
            # Render the actual SQL template against a saved auction/receipt.
            encoded=literal(json.dumps(values))
            return sql(f"select khub_bot.friendly_message(jsonb_populate_record(null::khub_bot.deliveries,{encoded}::jsonb));")
        for kind in ['sale_item','return_item']:
            split=preview_message(auction_id=split_sale,kind=kind,quantity=1)
            assert 'Attached in this message: 1 × escrow item.' in split and 'split across multiple messages' in split
            whole=preview_message(auction_id=split_sale,kind=kind,quantity=2)
            assert 'split across' not in whole and 'attached' in whole
        for outcome,heading in [('cancelled','Auction cancelled'),('ended_no_bids','Auction ended without bids')]:
            sql(f"update public.auctions set settlement_outcome='{outcome}' where id='{split_sale}';")
            assert preview_message(auction_id=split_sale,kind='return_item',quantity=2).startswith(heading)
        sql(f"update public.auctions set item='<b>item & name</b>' where id='{split_sale}';")
        escaped_item=preview_message(auction_id=split_sale,kind='sale_item',quantity=2)
        assert '&lt;b&gt;item &amp; name&lt;/b&gt;' in escaped_item and '<b>' not in escaped_item
        own_raise=preview_message(auction_id=split_bid,kind='refund',dedupe_key='outbid:7007:meat:0',receipt_id='7007',recipient_id=888,meat=100)
        assert own_raise.startswith('Previous bid returned') and 'outbid!' not in own_raise
        partial=preview_message(auction_id=split_bid,kind='refund',dedupe_key='outbid:7008:meat:0',receipt_id='7008',recipient_id=888,meat=1000000000)
        assert partial.startswith('You’ve been outbid!') and 'being returned across multiple messages' in partial
        assert 'returned in full' not in partial
        accepted=preview_message(auction_id=split_bid,kind='notice',dedupe_key='bid-accepted:fixture',message='funded bid of 1500000000 Meat')
        assert '1,500,000,000 Meat was accepted and funded' in accepted and 'current leading bid and status' in accepted
        assert 'We are holding your bid' not in accepted
        excess=preview_message(auction_id=split_sale,kind='refund',dedupe_key='excess:fixture',meat=100)
        assert 'buyout price' in excess and 'in separate messages' in excess
        for reason,expected in [
            ('This listing has no instant purchase price.','no buyout price'),
            ('The attached Meat does not meet the instant purchase price.','full buyout price'),
            ('Bidding and deposits are closed for this restricted seller.','seller is restricted'),
            ('Link your KoL account on the website before sending deposits or bids.','Register a kHub account'),
            ('Verification code is invalid or expired.','username in the navigation bar'),
            ('Send your full bid of at least 21,000,000 Meat. Bid increases depend on the current highest bid.','21,000,000 Meat')]:
            assert expected in sql(f"select khub_bot.friendly_reason({literal(reason)});")
        # Empty rejection has no fictitious attachments; a funded rejection
        # retains the exact refund obligation and explains split returns.
        for mid,funds in [(996001,0),(996002,1234)]:
            prepare_account(account_mail(mid,sid=996001,name='Message Audit',username='not allowed',meat=funds))
            replies=json.loads(sql(f"select json_agg(to_jsonb(d)) from khub_bot.deliveries d where receipt_id='{mid}';"))
            assert sum(d['meat'] for d in replies)==funds
            assert all(('being returned with this message or in separate messages' in d['display_message'])==bool(funds) for d in replies)
        final_job=prepare_account(account_mail(996003,sid=996003,name='Message & Audit'))
        provision(final_job)
        sql("select public.bot_finish_account_job('996003');",role='service_role')
        credentials=sql("select display_message from khub_bot.deliveries where receipt_id='996003';")
        assert 'click your username in the navigation bar, then select Change password' in credentials
        assert 'Message &amp; Audit' in credentials and 'Temporary password: '+temp_password in credentials
        definition=sql("select pg_get_functiondef('khub_bot.queue_rating_notice(uuid,uuid)'::regprocedure);")
        assert 'failed to honor the trade' in definition and 'response when submitted' in definition
        assert 'rating totals' not in definition and 'does not change your feedback score' in definition
        for role in ['anon','authenticated']:
            sql("select khub_bot.friendly_reason('Bidding is closed.');",role=role,error='permission denied')
        # Escrow contact uses the same private query/inbox flow, with no
        # incomplete report, feedback, delivery or settlement side effects.
        sql(migration_sql('202610210061_escrow_trade_queries.sql'))
        def fresh_query(lot,uid=competitor,body='Please check this escrow delivery and KMail.',key=None,error=None):
            sql(f"update khub_bot.bug_reports set created_at=now()-interval '2 hours' where reporter_id='{uid}';")
            key=key or str(uuid4())
            return key,trade_query(key,lot,body,uid=uid,error=error)
        escrow_query_lot=sql("select public.create_auction('seal tooth',2,100,24,null,500,2,true);",competitor,'authenticated')
        key,result=fresh_query(escrow_query_lot)
        assert sql(f"select category from khub_bot.bug_reports where id='{key}';")=='trade'
        assert trade_query(key,escrow_query_lot,'Please check this escrow delivery and KMail.',uid=competitor)==result
        fresh_query(escrow_query_lot,uid=fresh_buyer,error='Only the seller')
        fresh_query(escrow_query_lot,uid=owner_id,error='Only the seller')
        fresh_query(str(uuid4()),error='Only the seller')
        assert ingest(mail(996101,escrow_seller_id,{'type':'list','auction_id':escrow_query_lot},items=[{'id':2,'quantity':2}]))=='accepted'
        fresh_query(escrow_query_lot)
        assert ingest(mail(996102,escrow_buyer_id,{'type':'bid','auction_id':escrow_query_lot},meat=100))=='accepted'
        # Leading bidders have not won an auction yet.
        fresh_query(escrow_query_lot,uid=fresh_buyer,error='Only the seller')
        assert ingest(mail(996103,escrow_buyer_id,{'type':'buy','auction_id':escrow_query_lot},meat=500))=='accepted'
        assert auction_state(escrow_query_lot)['status']=='settling'
        financial_before=sql(f"select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d where auction_id='{escrow_query_lot}';")
        sale_before=sql(f"select to_jsonb(a) from public.auctions a where id='{escrow_query_lot}';")
        query_before=feedback(fresh_buyer)
        for uid in [competitor,fresh_buyer]:
            fresh_query(escrow_query_lot,uid=uid)
        assert sql(f"select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d where auction_id='{escrow_query_lot}';")==financial_before
        assert sql(f"select to_jsonb(a) from public.auctions a where id='{escrow_query_lot}';")==sale_before
        assert feedback(fresh_buyer)==query_before
        assert sql(f"select count(*) from khub_bot.trade_reports where auction_id='{escrow_query_lot}';")=='0'
        escrow_threads=threads(category='trade',status='all')['threads']
        escrow_thread=next(t for t in escrow_threads if t['id']==escrow_query_lot)
        assert escrow_thread['is_trade'] and escrow_thread['auction']['escrow']
        assert escrow_thread['auction']['item']=='seal tooth' and escrow_thread['auction']['quantity']==2
        assert len(escrow_thread['messages'])==4
        assert {m['reporter_role'] for m in escrow_thread['messages']}=={'seller','buyer'}
        assert all(m['message_type']=='trade_query' for m in escrow_thread['messages'])
        query_body=sql(f"select d.display_message from khub_bot.bug_report_deliveries b join khub_bot.deliveries d on d.id=b.delivery_id where b.report_id='{key}';")
        assert 'Trading method: Escrow' in query_body and 'Item: 2 x seal tooth' in query_body
        assert 'category=trade' in query_body
        # Model a later completed projection in this isolated fixture. Leave
        # unrelated uncertain sends intact; never bypass their reconciliation
        # gates merely to test a read-only support permission.
        sql(f"update public.auctions set status='completed',settled_at=clock_timestamp(),completed_at=clock_timestamp() where id='{escrow_query_lot}';")
        fresh_query(escrow_query_lot,uid=fresh_buyer)
        # A cancellation without a buyer still lets the seller ask about a return.
        return_query_lot=sql("select public.create_auction('seal tooth',2,100,24,null,null,2,true);",competitor,'authenticated')
        sql(f"select public.cancel_auction('{return_query_lot}');",competitor,'authenticated')
        assert auction_state(return_query_lot)['status']=='cancelled'
        fresh_query(return_query_lot)
        fresh_query(return_query_lot,uid=fresh_buyer,error='Only the seller')
        # Existing direct-sale queries retain the same eligibility and inbox.
        fresh_query(mixed,uid=fresh_buyer)
        fresh_query(active_lot,uid=competitor,error='Only the seller')
        sql(f"select public.submit_trade_query('{uuid4()}','{escrow_query_lot}','Please check this auction.');",role='anon',error='permission denied')
        ban(fresh_buyer)
        fresh_query(escrow_query_lot,uid=fresh_buyer,error='restricted')
        lift(fresh_buyer)
        # Query request IDs cannot be reused for another auction or reporter.
        fresh_query(return_query_lot,key=key,error='cannot be reused')
        fresh_query(escrow_query_lot,uid=fresh_buyer,key=key,error='cannot be reused')
        # Administrator identity access is authorized by the database, not a
        # browser flag, metadata claim, auction ownership or auction status.
        admin_lot=sql("select public.create_auction('seal tooth',1,100,24,null,500,2,false);",competitor,'authenticated')
        sql(f"select public.place_bid('{admin_lot}',100);",fresh_buyer,'authenticated')
        sql(f"select public.place_bid('{admin_lot}',200);",owner_id,'authenticated')
        sql(f"select public.place_bid('{admin_lot}',300);",fresh_buyer,'authenticated')
        pending_admin_lot=sql("select public.create_auction('seal tooth',1,100,24,null,null,2,true);",competitor,'authenticated')
        closed_admin_lot=sql("select public.create_auction('seal tooth',1,100,24,null,500,2,false);",competitor,'authenticated')
        sql(f"select public.purchase_auction('{closed_admin_lot}');",fresh_buyer,'authenticated')
        names={uid:sql(f"select khub_username from public.profiles where id='{uid}';") for uid in [competitor,fresh_buyer,owner_id]}
        ordinary_before={uid:read_page('detail',uid,'authenticated' if uid else 'anon',id=admin_lot) for uid in [competitor,fresh_buyer,SELLER,None]}
        unchanged=message_audit_snapshot()
        sql(migration_sql('202610210062_administrator_auction_identities.sql'))
        assert message_audit_snapshot()==unchanged
        for uid,before in ordinary_before.items():
            assert read_page('detail',uid,'authenticated' if uid else 'anon',id=admin_lot)==before
        admin_view=read_page('detail',owner_id,'authenticated',id=admin_lot)
        admin_row=admin_view['rows'][0]
        assert admin_row['seller_username']==names[competitor]
        assert admin_row['highest_bidder_id']==fresh_buyer and admin_row['highest_bidder_username']==names[fresh_buyer]
        assert {b['bidder_id'] for b in admin_view['bids']}=={fresh_buyer,owner_id}
        assert all(b['bidder_username']==names[b['bidder_id']] for b in admin_view['bids'])
        assert admin_row['settlement_contacts'] is None
        closed_view=read_page('detail',owner_id,'authenticated',id=closed_admin_lot)['rows'][0]
        assert closed_view['winner_public'] and closed_view['winner_id']==fresh_buyer
        assert closed_view['winner_username']==names[fresh_buyer] and closed_view['settlement_contacts'] is None
        assert read_page('detail',owner_id,'authenticated',id=pending_admin_lot)['rows'][0]['seller_username']==names[competitor]
        assert read_page('detail',fresh_buyer,'authenticated',id=pending_admin_lot)['rows']==[]
        assert read_page('detail',id=pending_admin_lot)['rows']==[]
        admin_seller=read_page('seller',owner_id,'authenticated',id=competitor,status='all',sort='newest')
        assert pending_admin_lot in {r['id'] for r in admin_seller['rows']}
        assert admin_seller['seller']['username']==names[competitor]
        ordinary_seller=read_page('seller',fresh_buyer,'authenticated',id=competitor,status='all',sort='newest')
        assert pending_admin_lot not in {r['id'] for r in ordinary_seller['rows']}
        # A client-editable role claim must not reveal other bidders.
        spoof_claims=literal(json.dumps({"is_admin":True,"role":"administrator"}))
        sql(f"update auth.users set raw_user_meta_data=coalesce(raw_user_meta_data,'{{}}'::jsonb)||{spoof_claims}::jsonb where id='{competitor}';")
        spoof=read_page('detail',competitor,'authenticated',id=admin_lot)
        assert all(b['bidder_id'] is None and b['bidder_username'].startswith('Bidder ') for b in spoof['bids'])
        # Explicit private grants also work, but only while that account is
        # unrestricted; names of banned auction participants remain visible to admins.
        sql(f"insert into khub_bot.administrators(user_id,note) values('{competitor}','Isolated explicit grant');")
        granted=read_page('detail',competitor,'authenticated',id=admin_lot)
        assert {b['bidder_id'] for b in granted['bids']}=={fresh_buyer,owner_id}
        sql(f"delete from khub_bot.administrators where user_id='{competitor}';")
        ban(competitor)
        ban(fresh_buyer)
        for lot in [admin_lot,closed_admin_lot]:
            row=read_page('detail',owner_id,'authenticated',id=lot)['rows'][0]
            assert row['seller_username']==names[competitor] and row['highest_bidder_username']==names[fresh_buyer]
        assert read_page('detail',owner_id,'authenticated',id=admin_lot)['rows'][0]['status']=='on_hold'
        # A restricted administrator loses the privilege, including through a
        # stale authenticated session. Restore only this isolated fixture afterward.
        owner_number=sql(f"select kol_player_id from public.profiles where id='{owner_id}';")
        sql(f"insert into khub_bot.account_bans(kol_player_id,username,reason) values({owner_number},{literal(names[owner_id])},'Isolated administrator restriction');")
        restricted_admin=read_page('detail',owner_id,'authenticated',id=admin_lot)
        assert not restricted_admin['rows'][0]['usernames_visible']
        assert restricted_admin['rows'][0]['seller_username']=='Seller'
        assert all(b['bidder_id']==owner_id or b['bidder_id'] is None for b in restricted_admin['bids'])
        sql(f"update khub_bot.account_bans set active=false where active and kol_player_id={owner_number};")
        for role in ['anon','authenticated']:
            sql('select khub_bot.public_auction(null::public.auctions,0,null,null);',owner_id if role=='authenticated' else None,role,error='permission denied')
        # Ban-review/decision notices from 051 used to block the sender before
        # settlement deliveries could run. Exercise the actual claim RPC without
        # contacting KoL; the fixture state changes below are rolled back.
        before_ban_templates=message_audit_snapshot()
        sql(migration_sql('202610210063_ban_notice_delivery_templates.sql'))
        assert message_audit_snapshot()==before_ban_templates
        for prefix in ['ban-review:','ban-decision:']:
            notice_id=sql(f"select id from khub_bot.deliveries where dedupe_key like '{prefix}%' order by created_at,id limit 1;")
            assert notice_id, prefix
            body=sql(f"select message from khub_bot.deliveries where id='{notice_id}';")
            assert sql(f"select khub_bot.friendly_message(d) from khub_bot.deliveries d where id='{notice_id}';")==body
            # Seed fixtures redirect notifications to teres Minor while retaining
            # the original dedupe key. Render the actual overridden recipient too.
            assert sql(f"select khub_bot.friendly_message(jsonb_populate_record(d,jsonb_build_object('recipient_id',3552305))) from khub_bot.deliveries d where id='{notice_id}';")==body
            # Calls in one SQL session make rollback restore every prior state.
            claimed=sql(f"""begin;
                update khub_bot.deliveries set state='sent',sent_at=now(),evidence='Isolated fixture only; rolled back without sending' where state in ('pending','sending','unknown');
                update khub_bot.closet_transfers set state='cancelled' where state in ('moving','unknown');
                update khub_bot.deliveries set state='pending',display_message=null where id='{notice_id}';
                select public.bot_claim_delivery(2)->>'id';
                rollback;""")
            assert claimed==notice_id,claimed
            assert sql(f"select khub_bot.friendly_message(jsonb_populate_record(d,jsonb_build_object('meat',1))) from khub_bot.deliveries d where id='{notice_id}';",error='Unrecognized delivery template') is not None
            sql(f"select khub_bot.friendly_message(jsonb_populate_record(d,jsonb_build_object('dedupe_key','{prefix}999999999:3552305:notice'))) from khub_bot.deliveries d where id='{notice_id}';",error='Unrecognized delivery template')
        sql("select khub_bot.friendly_message(jsonb_populate_record(null::khub_bot.deliveries,'{\"kind\":\"notice\",\"dedupe_key\":\"unknown:fixture\",\"message\":\"Do not send\"}'::jsonb));",error='Unrecognized delivery template')
        assert message_audit_snapshot()==before_ban_templates
        before_inspection=message_audit_snapshot()
        sql(migration_sql('202610210064_pending_delivery_inspection.sql'))
        assert message_audit_snapshot()==before_inspection
        for role in ['anon','authenticated']:
            sql('select public.bot_inspect();',owner_id if role=='authenticated' else None,role,error='permission denied')
        # Isolate a tiny queue in a rolled-back transaction. These are database
        # fixtures only: no worker/transport runs and no live states are changed.
        def inspect_queue(broken_first=True):
            return json.loads(sql(f"""begin;
                update khub_bot.deliveries set state='sent',sent_at=now() where state in ('pending','sending','unknown');
                select khub_bot.queue('inspection-unknown',null,null,3552305,'notice',0,'[]','Secret fixture password: never print this');
                select khub_bot.queue('inspection-frozen',null,null,3552305,'notice',0,'[]','Other private body');
                update khub_bot.deliveries set created_at=now()-interval '2 minutes' where dedupe_key='inspection-unknown:notice';
                update khub_bot.deliveries set display_message='Saved credential: never print this',created_at=now()-interval '{3 if not broken_first else 1} minutes'
                    where dedupe_key='inspection-frozen:notice';
                set local role service_role;
                select public.bot_inspect();
                rollback;"""))
        # Fixture setup needs operator writes; inspection itself must work under
        # service_role. Grant no private-table privileges beyond existing grants.
        for broken_first in [True,False]:
            result=inspect_queue(broken_first)
            assert result['pendingDeliveryChecks']==2,result
            assert len(result['pendingDeliveryAttention'])==1,result
            failure=result['pendingDeliveryAttention'][0]
            assert failure['delivery_reference'].startswith('D-') and failure['id']
            assert failure['reason']=='Unrecognized delivery template; inspect delivery before sending.'
            assert failure['blocksQueue']==broken_first
            assert result['pendingQueueBlocked']==broken_first
            assert 'never print this' not in json.dumps(result) and 'Secret fixture password' not in json.dumps(result)
        assert message_audit_snapshot()==before_inspection
        before_delivery_holds=message_audit_snapshot()
        sql(migration_sql('202610210065_isolate_delivery_preparation_failures.sql'))
        assert message_audit_snapshot()==before_delivery_holds
        for role in ['anon','authenticated']:
            sql(f"select public.bot_retry_held_delivery('{uuid4()}','Reviewed the preparation failure.');",owner_id if role=='authenticated' else None,role,error='permission denied')
            sql('select * from khub_bot.delivery_preparation_reviews;',owner_id if role=='authenticated' else None,role,error='permission denied')
        sql(f"""begin;
            -- Test fixtures only: isolate queue without touching any live game.
            update khub_bot.deliveries set state='sent',sent_at=now() where state in ('pending','sending','unknown');
            update khub_bot.closet_transfers set state='cancelled' where state in ('moving','unknown');
            update public.auctions set status='settling',settled_at=null,completed_at=null,settlement_outcome='completed' where id='{split_sale}';
            select khub_bot.queue('hold-item-fixture','{split_sale}',null,3552305,'refund',0,'[{{"id":2,"quantity":3}}]','Secret fixture body; do not print');
            select khub_bot.queue('hold-meat-fixture','{split_sale}',null,3552305,'refund',5,'[]','Private fixture credentials; do not print');
            select khub_bot.queue('sale-item:ready-fixture','{split_sale}',null,3552305,'sale_item',0,'[{{"id":2,"quantity":1}}]','Ready item');
            select khub_bot.queue('frozen-fixture',null,null,3552305,'notice',0,'[]','Private frozen body');
            update khub_bot.deliveries set created_at=now()-interval '3 minutes' where dedupe_key like 'hold-item-fixture:%';
            update khub_bot.deliveries set created_at=now()-interval '2 minutes' where dedupe_key like 'hold-meat-fixture:%';
            update khub_bot.deliveries set created_at=now()-interval '1 minute' where dedupe_key like 'sale-item:ready-fixture:%';
            update khub_bot.deliveries set display_message='Private frozen body' where dedupe_key='frozen-fixture:notice';
            do $test$ declare
                claimed jsonb; info jsonb; reserved jsonb; saved_item jsonb; saved_meat jsonb;
                item_delivery uuid; meat_delivery uuid; frozen_delivery uuid; rejected boolean; alerts bigint;
            begin
                select id,to_jsonb(d) into item_delivery,saved_item from khub_bot.deliveries d where dedupe_key like 'hold-item-fixture:%';
                select id,to_jsonb(d) into meat_delivery,saved_meat from khub_bot.deliveries d where dedupe_key like 'hold-meat-fixture:%';
                select id into frozen_delivery from khub_bot.deliveries where dedupe_key='frozen-fixture:notice';
                reserved:=public.bot_liabilities();
                claimed:=public.bot_claim_delivery(2);
                assert claimed->>'kind'='sale_item','Unrelated item delivery did not proceed';
                assert (select to_jsonb(d)=saved_item from khub_bot.deliveries d where id=item_delivery),'Held item ledger changed';
                assert (select to_jsonb(d)=saved_meat from khub_bot.deliveries d where id=meat_delivery),'Held Meat ledger changed';
                assert public.bot_liabilities()=reserved,'Held assets stopped being reserved';
                info:=public.bot_inspect();
                assert info->>'heldDeliveryCount'='2';
                assert jsonb_array_length(info->'heldDeliveryAttention')=2;
                assert jsonb_array_length(info->'pendingDeliveryAttention')=0;
                assert info->>'pendingQueueBlocked'='false';
                assert strpos(info::text,'Secret fixture body')=0 and strpos(info::text,'Private fixture credentials')=0;
                assert (select count(*)=2 from khub_bot.delivery_preparation_reviews h join khub_bot.bug_reports r on r.id=h.report_id where h.released_at is null and r.is_system and r.category='other');
                perform public.bot_ack_delivery((claimed->>'id')::uuid,(claimed->>'attempt')::uuid,true,'Isolated fixture acknowledgment; no real transfer');
                perform public.bot_tick();
                assert (select status='settling' from public.auctions where id='{split_sale}'),'Held assets falsely settled auction';
                -- After the good item, the frozen notice and both operator alerts
                -- send normally. Repeated claims never duplicate the two holds.
                for i in 1..3 loop
                    claimed:=public.bot_claim_delivery(2);
                    assert claimed is not null;
                    if i=1 then assert (claimed->>'id')::uuid=frozen_delivery; end if;
                    perform public.bot_ack_delivery((claimed->>'id')::uuid,(claimed->>'attempt')::uuid,true,'Isolated fixture acknowledgment; no real transfer');
                end loop;
                assert public.bot_claim_delivery(2) is null;
                assert (select count(*)=2 from khub_bot.delivery_preparation_reviews where released_at is null);
                assert (select count(*)=2 from khub_bot.deliveries where dedupe_key like 'delivery-preparation-review:%');
                rejected:=false;
                begin perform public.bot_retry_held_delivery(item_delivery,'Attempt retry before fixing its template.'); exception when others then rejected:=true; end;
                assert rejected,'Unfixed hold was released';
                assert (select released_at is null from khub_bot.delivery_preparation_reviews where delivery_id=item_delivery);
                -- Correct only this isolated fixture, then explicitly release it.
                update khub_bot.deliveries set display_message='Corrected fixture text' where id=item_delivery;
                perform public.bot_retry_held_delivery(item_delivery,'Corrected the isolated message template.');
                assert (select release_evidence='Corrected the isolated message template.' from khub_bot.delivery_preparation_reviews where delivery_id=item_delivery);
                claimed:=public.bot_claim_delivery(2);
                assert (claimed->>'id')::uuid=item_delivery and claimed->>'quantity'='3';
                -- An interrupted actual send still blocks; never treat it as a
                -- definitely-unsent preparation error or automatically send twice.
                rejected:=false;
                begin perform public.bot_claim_delivery(2); exception when others then rejected:=true; end;
                assert rejected,'Sending delivery uncertainty was ignored';
                assert (select count(*)=1 from khub_bot.delivery_preparation_reviews where released_at is null);
            end; $test$;
            rollback;""")
        assert message_audit_snapshot()==before_delivery_holds
        before_mailbox=message_audit_snapshot()
        sql(migration_sql('202610210066_automatic_sent_mail_recovery.sql'))
        assert message_audit_snapshot()==before_mailbox
        for role in ['anon','authenticated']:
            actor=owner_id if role=='authenticated' else None
            for query in ['select public.bot_mailbox_check_deliveries();', 'select public.bot_dispatch_liabilities();',
                f"select public.bot_record_mailbox_check('{uuid4()}',null,'{{}}');", 'select * from khub_bot.delivery_mailbox_reviews;']:
                sql(query,actor,role,error='permission denied')
        sql("""begin;
            update khub_bot.deliveries set state='sent',sent_at=now() where state in ('pending','sending','unknown');
            update khub_bot.closet_transfers set state='cancelled' where state in ('moving','unknown');
            select khub_bot.queue('mailbox-uncertain',null,null,3552305,'refund',10,'[]','Frozen sensitive body');
            select khub_bot.queue('mailbox-ready',null,null,3552305,'refund',20,'[]','Ready delivery');
            update khub_bot.deliveries set display_message=message where dedupe_key like 'mailbox-%';
            update khub_bot.deliveries set state='unknown',attempt=gen_random_uuid() where dedupe_key like 'mailbox-uncertain:%';
            do $test$ declare
                d khub_bot.deliveries%rowtype; claimed jsonb; result jsonb; total jsonb; dispatch jsonb;
                ticket_count bigint; alert_count bigint; rejected boolean; ready_id uuid;
            begin
                select * into d from khub_bot.deliveries where dedupe_key like 'mailbox-uncertain:%';
                select id into ready_id from khub_bot.deliveries where dedupe_key like 'mailbox-ready:%';
                total:=public.bot_liabilities();
                assert exists(select 1 from jsonb_array_elements(public.bot_mailbox_check_deliveries()) x where x->>'id'=d.id::text and strpos(x->>'expected_message','Frozen sensitive body')>0);
                rejected:=false;
                begin perform public.bot_claim_delivery(2); exception when others then rejected:=true; end;
                assert rejected,'Unreviewed send uncertainty must stop dispatch';
                result:=public.bot_record_mailbox_check(d.id,d.attempt,'{"status":"not_found","candidate_ids":[]}');
                assert result->>'status'='isolated';
                assert (select state='unknown' and attempt=d.attempt from khub_bot.deliveries where id=d.id);
                assert public.bot_liabilities()=total,'Uncertain obligation was erased';
                dispatch:=public.bot_dispatch_liabilities();
                assert (dispatch->>'meat')::numeric=(total->>'meat')::numeric-10,'Dispatch must reserve all known-unsent obligations';
                select count(*) into ticket_count from khub_bot.delivery_mailbox_reviews;
                select count(*) into alert_count from khub_bot.deliveries where dedupe_key like 'mailbox-review-admin:%';
                assert alert_count=1;
                assert (select r.is_system and r.category='other' and strpos(r.body,d.id::text)>0 and strpos(r.body,'No confirmed matching sent-message ID')>0 and strpos(r.body,'Frozen sensitive body')=0
                    from khub_bot.delivery_mailbox_reviews h join khub_bot.bug_reports r on r.id=h.report_id where h.delivery_id=d.id);
                perform public.bot_record_mailbox_check(d.id,d.attempt,'{"status":"ambiguous","candidate_ids":["998877"]}');
                assert (select count(*)=ticket_count from khub_bot.delivery_mailbox_reviews),'Repeated check duplicated review';
                assert (select count(*)=alert_count from khub_bot.deliveries where dedupe_key like 'mailbox-review-admin:%'),'Repeated check duplicated alert';
                assert public.bot_inspect()->>'mailboxRecoveryEnabled'='true';
                assert jsonb_array_length(public.bot_inspect()->'isolatedDeliveryAttention')=1;
                claimed:=public.bot_claim_delivery(2);
                assert (claimed->>'id')::uuid=ready_id,'Unrelated funded delivery stayed blocked';
                perform public.bot_ack_delivery((claimed->>'id')::uuid,(claimed->>'attempt')::uuid,true,'Isolated fixture only; no live message sent');
                rejected:=false;
                begin perform public.bot_record_mailbox_check(d.id,gen_random_uuid(),jsonb_build_object('status','verified','message_id','998877','candidate_ids',jsonb_build_array('998877'),'message_hash',repeat('a',64))); exception when others then rejected:=true; end;
                assert rejected,'A stale attempt must not confirm another send';
                result:=public.bot_record_mailbox_check(d.id,d.attempt,jsonb_build_object('status','verified','message_id','998877','candidate_ids',jsonb_build_array('998877'),'message_hash',repeat('a',64)));
                assert result->>'status'='sent';
                assert (select state='sent' from khub_bot.deliveries where id=d.id);
                assert (select resolved_at is not null and sent_message_id='998877' from khub_bot.delivery_mailbox_reviews where delivery_id=d.id);
                assert (select strpos(evidence,'Sent Mail ID 998877')>0 from khub_bot.reconciliations where delivery_id=d.id);
                assert public.bot_record_mailbox_check(d.id,d.attempt,'{"status":"not_found","candidate_ids":[]}')->>'status'='already_sent';
                -- A failed administrator alert cannot create endless alert mail.
                select * into d from khub_bot.deliveries where dedupe_key like 'mailbox-review-admin:%' limit 1;
                update khub_bot.deliveries set state='unknown',attempt=gen_random_uuid() where id=d.id returning * into d;
                perform public.bot_record_mailbox_check(d.id,d.attempt,'{"status":"check_failed","candidate_ids":[]}');
                assert (select count(*)=alert_count from khub_bot.deliveries where dedupe_key like 'mailbox-review-admin:%');
                perform public.bot_reconcile_delivery(d.id,false,'Manually checked this isolated fixture was not sent.');
                assert (select state='pending' from khub_bot.deliveries where id=d.id);
                assert not exists(select 1 from khub_bot.delivery_mailbox_reviews where delivery_id=d.id and resolved_at is null);
            end; $test$;
            rollback;""")
        assert message_audit_snapshot()==before_mailbox
        sql(migration_sql('202610210067_account_retry_schedule.sql'))
        retry_job=prepare_account(account_mail(997067,sid=997067,name='Retry Schedule'))
        for attempt in range(3):
            assert sql("select public.bot_begin_account_attempt('997067');",role='service_role')=='t'
        assert sql("select public.bot_begin_account_attempt('997067');",role='service_role')=='f'
        assert sql("select attempt_count=3 and next_attempt_at>now()+interval '4 minutes' from khub_bot.account_jobs where mail_id='997067';")=='t'
        due=json.loads(sql("select public.bot_pending_account_requests();",role='service_role'))
        assert len(due)<=2 and all(row['id']!='997067' for row in due)
        sql("update khub_bot.account_jobs set next_attempt_at=now()-interval '1 second' where mail_id='997067';")
        assert sql("select public.bot_begin_account_attempt('997067');",role='service_role')=='t'
        assert sql("select public.bot_begin_account_attempt('997067');",role='service_role')=='f'
        assert sql("select attempt_count=4 and next_attempt_at>now()+interval '4 minutes' from khub_bot.account_jobs where mail_id='997067';")=='t'
        assert sql("select has_function_privilege('anon','public.bot_begin_account_attempt(text)','execute') or has_function_privilege('authenticated','public.bot_begin_account_attempt(text)','execute');")=='f'
        sql("update khub_bot.account_jobs set state='done',temporary_password=null,next_attempt_at=now()-interval '1 second' where mail_id='997067';")
        assert sql("select public.bot_begin_account_attempt('997067');",role='service_role')=='f'
        sql(migration_sql('202610210068_gift_wrapping_funds.sql'))
        gift_held=json.loads(sql("select public.bot_gift_wrapping_liabilities();",role='service_role'))
        regular_held=json.loads(sql("select public.bot_liabilities();",role='service_role'))
        pending_closet=int(sql("select coalesce(sum(meat),0) from khub_bot.closet_transfers where state in ('pending','moving','unknown');"))
        assert int(gift_held['meat'])==int(regular_held['meat'])+pending_closet
        assert gift_held['items']==regular_held['items']
        assert sql("select has_function_privilege('anon','public.bot_gift_wrapping_liabilities()','execute') or has_function_privilege('authenticated','public.bot_gift_wrapping_liabilities()','execute');")=='f'
        before_fee_migration=message_audit_snapshot()
        closed_fees=sql("select coalesce(jsonb_agg(jsonb_build_array(id,fee_meat,fee_bps,final_price,status) order by id),'[]') from public.auctions where finalized_at is not null;")
        sql(migration_sql('202610210069_tiered_escrow_fees.sql'))
        for table in ['khub_bot.deliveries','public.bids','khub_bot.receipts','khub_bot.account_jobs','khub_bot.reconciliations']:
            assert message_audit_snapshot()[table]==before_fee_migration[table]
        assert sql("select coalesce(jsonb_agg(jsonb_build_array(id,fee_meat,fee_bps,final_price,status) order by id),'[]') from public.auctions where finalized_at is not null;")==closed_fees
        assert sql("select khub_bot.tiered_escrow_fee(10000000);")=='410000'
        assert json.loads(sql('select public.bot_inspect();',role='service_role'))['escrowFeePolicy']['name']=='tiered_v1'
        assert read_page('detail',id=split_sale)['rows'][0]['fee_policy']=='flat'
        print('PASS: fee migration after the full audit suite preserves all existing finalized financial records, frozen deliveries, identities and queued account jobs; private service inspection reports the marginal schedule')
        before_duration_migration=message_audit_snapshot()
        sql(migration_sql('202610220070_fourteen_day_auctions.sql'))
        assert message_audit_snapshot()==before_duration_migration
        fortnight_direct=sql("select public.create_auction('seal tooth',1,100,336,null,null,2,false);",owner_id,'authenticated')
        fortnight_escrow=sql("select public.create_auction('seal tooth',1,100,336,null,null,2,true);",owner_id,'authenticated')
        for ident in [fortnight_direct,fortnight_escrow]:
            assert sql(f"select duration_hours=336 and end_time-created_at=interval '336 hours' from public.auctions where id='{ident}';")=='t'
        assert ingest(mail(next(serial),int(sql(f"select kol_player_id from public.profiles where id='{owner_id}';")),{'type':'list','auction_id':fortnight_escrow},items=[{'id':2,'quantity':1}]))=='accepted'
        assert sql(f"select status='active' and abs(extract(epoch from end_time-item_escrowed_at)-336*3600)<1 from public.auctions where id='{fortnight_escrow}';")=='t'
        for invalid_duration in [335,337]:
            sql(f"select public.create_auction('seal tooth',1,100,{invalid_duration},null,null,2,false);",owner_id,'authenticated',error='valid auction duration')
        sql(f"update public.auctions set duration_hours=337 where id='{fortnight_direct}';",error='auctions_duration_hours_check')
        print('PASS: 14-day Direct and Escrow creation, exact 336-hour timers and deposit-start timing, unsupported durations rejected, existing records unchanged')
        before_hybrid=message_audit_snapshot()
        sql(migration_sql('202610220071_hybrid_bid_increments.sql'))
        assert message_audit_snapshot()==before_hybrid
        assert sql('select khub_bot.bid_increment(1750000);')=='60000'
        assert sql('select khub_bot.minimum_auction_bid(1,15000000000);')=='15075000000'
        print('PASS: hybrid increments apply after the full migration chain without altering accepted bids, auctions, financial ledgers, frozen messages, or accounts')
        before_hot=message_audit_snapshot()
        sql(migration_sql('202610220072_hot_auction_cards.sql'))
        assert message_audit_snapshot()==before_hot
        hot_page=json.loads(sql("select public.read_auction_page(p_status=>'all');"))
        assert all(isinstance(row['is_hot'],bool) for row in hot_page['rows'])
        print('PASS: global hot-auction metadata preserves all auction/account/financial history and existing privacy-protected reads')
        before_browse=message_audit_snapshot()
        sql(migration_sql('202610220073_auction_browse_controls.sql'))
        assert message_audit_snapshot()==before_browse
        browse_page=json.loads(sql("select public.read_auction_page('browse',null,'','all','activity',1,'escrow');"))
        assert all(row['escrow_mode'] and 'latest_bid_at' in row and 'is_hot' in row for row in browse_page['rows'])
        print('PASS: extended paginated browsing preserves existing history, hot flags, and privacy metadata')
        before_expiry_assets=sql("select jsonb_build_object('deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d),'bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b));")
        sql(migration_sql('202610220074_unfunded_escrow_expiry.sql'))
        assert sql("select jsonb_build_object('deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d),'bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b));")==before_expiry_assets
        sql('select public.finalize_expired_auctions();')
        print('PASS: 24-hour unfunded escrow cleanup preserves all existing bids and financial deliveries')
        before_polls=message_audit_snapshot()
        sql(migration_sql('202610220075_homepage_poll.sql'))
        assert message_audit_snapshot()==before_polls
        assert sql('select count(*) from khub_bot.site_polls where active;')=='1'
        print('PASS: homepage poll and management migration preserves all existing auctions, identities, bids, messages and financial records')
        before_live_polls=message_audit_snapshot()
        sql(migration_sql('202610220076_live_poll_results.sql'))
        assert message_audit_snapshot()==before_live_polls
        print('PASS: live post-vote results and private voter lookup preserve existing financial and account history')
        before_completed_carousel=message_audit_snapshot()
        sql(migration_sql('202610220077_recent_completed_trades.sql'))
        assert message_audit_snapshot()==before_completed_carousel
        print('PASS: recent completed-trade ordering preserves existing auction, financial and account history')
        before_bid_references=message_audit_snapshot()
        sql(migration_sql('202610220078_admin_bid_delivery_references.sql'))
        assert message_audit_snapshot()==before_bid_references
        print('PASS: admin bid references preserve existing financial and account history')
        before_receipt_bidding=sql("select jsonb_build_object('deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d),'bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b));")
        sql(migration_sql('202610220079_receipt_time_escrow_bidding.sql'))
        sql(migration_sql('202610220080_receipt_time_intake_guards.sql'))
        sql(migration_sql('202610220081_custom_auction_ending_time.sql'))
        sql(migration_sql('202610220082_other_sellers_filter.sql'))
        sql(migration_sql('202610220083_multiple_active_poll_queue.sql'))
        sql(migration_sql('202610220084_admin_poll_results.sql'))
        sql(migration_sql('202610220085_buy_auctions.sql'))
        sql(migration_sql('202610220086_buy_reservations_and_gifts.sql'))
        sql(migration_sql('202610220087_effective_fee_percentages.sql'))
        sql(migration_sql('202610220088_completed_bidder_usernames.sql'))
        sql(migration_sql('202610220089_site_banner.sql'))
        sql(migration_sql('202610220090_cancel_buy_reservations.sql'))
        sql(migration_sql('202610230091_distinguish_expiration_from_cancellation.sql'))
        sql(migration_sql('202610230092_hide_abandoned_escrow_drafts.sql'))
        sql(migration_sql('202610230093_private_buy_auction_fees.sql'))
        sql(migration_sql('202610230094_pending_trade_experience_ratings.sql'))
        sql(migration_sql('202610230095_escrow_bid_help.sql'))
        sql(migration_sql('202610230096_bot_paid_buy_gift_batches.sql'))
        sql(migration_sql('202610230097_incoming_auction_gifts.sql'))
        sql(migration_sql('202610230098_isolate_uncertain_gifts.sql'))
        sql(migration_sql('202610230099_sell_auction_anti_sniping.sql'))
        sql(migration_sql('202610230100_direct_trade_reminders.sql'))
        sql(migration_sql('202610230101_free_text_polls.sql'))
        sql(migration_sql('202610230102_multiple_choice_polls.sql'))
        sql(migration_sql('202610230103_skip_text_polls.sql'))
        sql(migration_sql('202610230104_reopen_skipped_text_polls.sql'))
        sql(migration_sql('202610240105_remove_escrow_starting_bid_cap.sql'))
        sql(migration_sql('202610240106_isolate_uncertain_closet_moves.sql'))
        assert sql("select jsonb_build_object('deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d),'bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b));")==before_receipt_bidding
        assert json.loads(sql('select public.bot_inspect();',role='service_role'))['receiptTimeBiddingVersion']==1
        print('PASS: receipt-time bidding migration preserves existing bids and payment obligations')




        print('PASS: service-only gift wrapping protects full player obligations and pending closet funds without changing the regular liability ledger')
        print('PASS: persistent account attempt reservations, two initial retries then five-minute cooldown on every later attempt, due-only bounded queue, finished-job and service-only guards')
        print('PASS: service-only Sent Mail recovery, attempt-stamped positive proof, idempotent isolation alerts and actual message IDs, retained full obligations with separate funded dispatch checks, unrelated payouts continue, manual release, no alert loops or blind resend')
        print('PASS: broken item and Meat messages set aside; unrelated asset delivery and frozen notices continue; reservations, settlement, no-send state and uncertain-send guards preserved; one Other inbox/KMail alert per failure; explicit validated audited retry; inspection remains secret-free')
        print('PASS: read-only service-only pending message diagnostics, frozen-message handling, queue-head distinction, safe references/reasons without secret bodies, per-message errors and unchanged delivery state')
        print('PASS: audited ban-review and ban-decision notices render and claim without blocking settlement; unknown/unaudited/funded templates still rejected; existing messages and ledger state unchanged')
        print('PASS: server-verified administrator names/IDs for all bids and auction parties, pending/closed/held listings and seller pages, unchanged ordinary/guest/banned privacy, metadata spoof rejection, explicit grants and restricted-admin revocation, no financial/contact-data expansion')
        print('PASS: participant-only Escrow queries before deposit/during bidding/settlement/after completion/cancellation, leading/outsider/banned/anonymous protection, grouped auction context, stable retries and unchanged financial/feedback state')
        print('PASS: audited message templates, split item/Meat returns, self-raised bids, delayed event wording, buyout/restriction guidance, account navigation/escaping, conditional refund copy and unchanged saved messages/financial records')
        print('PASS: once-only player/admin account-failure notices, real Other inbox system reports before profile creation, private/zero-asset queues, untouched pending secrets, concurrent replay protection, admin-only preference, and null-safe report ownership')
        print('PASS: private exact-account ban timeline, original timestamps and full reasons, edits/removals, legacy creation snapshots, and no fabricated support messages or financial deliveries')
        print('PASS: admin-only exact appeal-account lookup, current permanent/temporary/lifted state, missing/non-appeal privacy and independent appeal resolution')
        print('PASS: general support routes to Other, private authenticated intake, shared rate limits, escaped administrator notices, stable retries/category edits, cross-user/type key protection and no duplicate deliveries')
        print('PASS: exact 48-hour profile grace for both roles/counts/values, actual buyout close versus delayed natural finalization, automatic read-time maturity, immediate report visibility, separate feedback, dismissal/withdrawal and no automatic marks for silence')
        print('PASS: safe-update-compatible catalog reset, first import and replacement, publishing in both modes, preserved tradeability/permissions and unchanged historical auctions/deliveries')
        print('PASS: all bid-increment boundaries and exact 1% rounding, unchanged first bids and existing records, Direct/Escrow parity, typed/explicit buyout exceptions, excess refunds, actionable KMail errors, duplicate receipts and serialized concurrent bids')
        print('PASS: atomic current catalog replacement, server-enforced tradeability in both modes, canonical images/folder paths, public reference-only data, service-only imports, stale/malformed snapshot rejection, live new items and unchanged historical auctions/financial obligations')
        print('PASS: bans close bid-free listings, hold direct commitments, block browser bids/buyouts, preserve history, require admin review, audit evidence-based two-party completion, and refund new escrow bids while honoring funded settlement')
        print('PASS: repeatable SQL test accounts, password hashes/identities, no admin privileges, unbanned initial account, preserved admin ban, mock direct trade states, notification redirection and no fabricated escrow transfers')
        print('PASS: new escrow minimums above 1M are rejected including default-mode API calls; exact 1M, Direct and larger buyouts remain allowed; existing records stay unchanged')
        print('PASS: admin-only bans/lifts, preserved restrictions, temporary expiry, stale-session trading/report protection, authenticated appeals, private atomic image evidence and audit records')
        print('PASS: durable admin withdrawal metadata for silent reports, correct event time/order, idempotency, both participants, legacy withdrawals and no false completion from admin ticket closure')
        print('PASS: completed escrow purchase counts exclude active/settling deliveries, stay separate from direct trades, and match public profile totals')
        print('PASS: role-specific incomplete trade values distinguish 10k and 10b, count final prices once, follow exclusion/restoration/withdrawal and retain exact public totals without changing feedback')
        print('PASS: completed points wait for both parties, conflicts and dismissed reports add no completion, resolved trades count once, feedback stays independent and historical source records are unchanged')
        print('PASS: admin-excluded reports clear per-party/public incomplete marks and profile counts, preserve reports/audits/feedback, never imply completion, and restore correctly')
        print('PASS: exact completed purchase totals for direct and escrow trades, no pending purchases, public aggregate projection and unchanged source records')
        print('PASS: comma-formatted direct/escrow message amounts and quantities, exact large integers, untouched identifiers/user text/ledger values and frozen delivery bodies')
        print('PASS: separate feedback and trade-confirmation counts, optional response-gated votes, final votes/idempotency, private votes, banned/anonymous/outsider protection, and unchanged trade outcomes')
        print('PASS: public trade responses for every viewer, private names/contacts/report text, and public resolution updates')
        print('PASS: neutral completion after withdrawal, no positive rating conversion, participant-only response statuses and unchanged historical notifications')
        print('PASS: grouped support threads, cross-page histories, per-party rating reviews, atomic resolution/category changes and administrator-only access')
        print('PASS: all database migration, escrow, recovery, permission and persistence checks; public seller profiles, bidder anonymity, participant-only identities and seller history pagination; optional escrow, private pending trades, two-party confirmation and direct bid races; large prices, exact precision and commission arithmetic; private bug inbox, administrator permissions and durable KMail reports')
    finally:
        if started:
            pg_ctl('-m', 'fast', '-w', 'stop')
