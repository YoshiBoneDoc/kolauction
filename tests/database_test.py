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
        print('PASS: all database migration, escrow, recovery, permission and persistence checks; public seller profiles, bidder anonymity, participant-only identities and seller history pagination; optional escrow, private pending trades, two-party confirmation and direct bid races; large prices, exact precision and commission arithmetic; private bug inbox, administrator permissions and durable KMail reports')
    finally:
        if started:
            pg_ctl('-m', 'fast', '-w', 'stop')
