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

        before = sql('select json_agg(t order by id) from public.auctions t;')
        bids_before = sql('select json_agg(t order by id) from public.bids t;')
        pg_ctl('-l', str(Path(directory) / 'postgres.log'), '-m', 'fast', '-w', 'restart')
        assert sql('select json_agg(t order by id) from public.auctions t;') == before
        assert sql('select json_agg(t order by id) from public.bids t;') == bids_before
        print('PASS: migrations, profile RLS, public reads, write restrictions, input validation, bids, concurrent bids, expiry, identity, registration conflict checks, lifecycle upgrades, cancellation/bid races, two-party completion, and database restart persistence')
    finally:
        if started:
            pg_ctl('-m', 'fast', '-w', 'stop')
