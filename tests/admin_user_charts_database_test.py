"""Disposable PostgreSQL: rolling registration counts, pagination and access control."""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BIN = Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-user-charts-', dir='/tmp') as folder:
    data = Path(folder) / 'data'
    subprocess.run([str(BIN/'initdb'), '-D', str(data), '-A', 'trust', '--no-locale'], check=True, capture_output=True)
    def pg(*args):
        subprocess.run([str(BIN/'pg_ctl'), '-D', str(data), *args], check=True, capture_output=True)
    def sql(query, error=None):
        r = subprocess.run([str(BIN/'psql'), '-h', folder, '-d', 'postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1'], input=query, text=True, capture_output=True)
        if error:
            assert r.returncode and error in r.stderr, r.stderr
        else:
            assert r.returncode == 0, r.stderr
        return r.stdout.strip()
    def migration(name):
        return next(p for p in [ROOT/'supabase/migrations'/name, ROOT/'supabase/migrations/queue'/name] if p.exists()).read_text()
    pg('-l', str(Path(folder)/'postgres.log'), '-o', f"-F -h '' -k {folder}", '-w', 'start')
    try:
        sql("""create role anon; create role authenticated;
            create schema auth; create schema khub_bot;
            create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
            create function khub_bot.is_administrator(uuid) returns boolean language sql stable as $$select coalesce($1='00000000-0000-0000-0000-000000000001'::uuid,false)$$;
            create table public.profiles(id uuid primary key, khub_username text, created_at timestamptz);
            insert into public.profiles select md5(i::text)::uuid,'Member '||i,now()-interval '1 hour' from generate_series(1,30) i;
            insert into public.profiles select md5('older-'||hours::text)::uuid,'Older member',now()-hours*interval '1 hour' from unnest(array[25,167,169,719,721,-1]) hours;
        """)
        sql(migration('202611020168_admin_new_users.sql'))
        admin = "set role authenticated;set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';"
        baseline = json.loads(sql(admin + 'select public.read_admin_new_users();'))
        sql(migration('202611090246_admin_user_charts.sql'))
        result = json.loads(sql(admin + 'select public.read_admin_new_users();'))
        assert result['registration_counts'] == ['30', '32', '34'], result
        assert result['total'] == baseline['total'] == '32'
        assert result['users'] == baseline['users'] and len(result['users']) == 25
        assert result['login_activity'] == {'status': 'unavailable'}
        assert len(json.loads(sql(admin + 'select public.read_admin_new_users(2);'))['users']) == 7
        sql('set role anon;select public.read_admin_new_users();', error='permission denied')
        sql('set role authenticated;select public.read_admin_new_users();', error='Administrator access required')
        sql(admin + 'select public.read_admin_new_users(0);', error='Invalid page')
        sql(admin + 'select public.read_admin_new_users(null);', error='Invalid page')
        sql("""create table auth.sessions(id uuid primary key,user_id uuid not null,refreshed_at timestamptz);
            create table auth.mfa_amr_claims(id uuid primary key,session_id uuid references auth.sessions(id),authentication_method text,updated_at timestamptz);
        """)
        sql(migration('202611090248_record_login_activity.sql'))
        def activity(): return json.loads(sql(admin+'select public.read_admin_new_users();'))['login_activity']
        assert activity()['unique_users']==['0','0','0']
        assert activity()['status']=='recording' and activity()['recording_since']
        def session(n,account=1,method='password'):
            sql(f"insert into auth.sessions values(md5('session{n}')::uuid,md5('account{account}')::uuid,null); insert into auth.mfa_amr_claims values(md5('claim{n}')::uuid,md5('session{n}')::uuid,'{method}',now());")
        session(1);session(2);session(3,2)
        assert activity()['unique_users']==['2','2','2']
        assert activity()['total_logins']==['3','3','3']
        # Duplicate claim delivery cannot create a second event for one session.
        sql("insert into auth.mfa_amr_claims values(md5('duplicate')::uuid,md5('session1')::uuid,'password',now());")
        session(4,3,'token_refresh');session(5,3,'recovery');session(6,3,'totp')
        sql("update auth.sessions set refreshed_at=now(); update auth.mfa_amr_claims set updated_at=now();")
        assert activity()['total_logins']==['3','3','3']
        sql("begin;insert into auth.sessions values(md5('rollback-session')::uuid,md5('account4')::uuid,null);insert into auth.mfa_amr_claims values(md5('rollback-claim')::uuid,md5('rollback-session')::uuid,'password',now());rollback;")
        assert activity()['total_logins']==['3','3','3']
        # Retain history after logout/session deletion, and verify rolling windows.
        sql("delete from auth.mfa_amr_claims;delete from auth.sessions;")
        assert activity()['total_logins']==['3','3','3']
        sql("update khub_bot.login_events set logged_in_at=now()-interval '25 hours' where session_id=md5('session2')::uuid;update khub_bot.login_events set logged_in_at=now()-interval '169 hours' where session_id=md5('session3')::uuid;")
        assert activity()['unique_users']==['1','1','2']
        assert activity()['total_logins']==['1','2','3']
        sql("insert into khub_bot.login_events select md5('old'||i)::uuid,md5('old-user')::uuid,now()-interval '32 days' from generate_series(1,150) i;")
        session(7,1)
        assert sql("select count(*) from khub_bot.login_events where logged_in_at<now()-interval '31 days';")=='50'
        for role in ['anon','authenticated']:
            sql(f'set role {role};select * from khub_bot.login_events;',error='permission denied')
            sql(f'set role {role};insert into khub_bot.login_events values(null,null,now());',error='permission denied')
        assert len(json.loads(sql(admin+'select public.read_admin_new_users(2);'))['users'])==7
        sql("create table public.site_activity(visitor_id uuid primary key,user_id uuid,last_seen timestamptz);")
        sql(migration('202611090249_site_visit_analytics.sql'))
        def visit_stats(): return json.loads(sql(admin+'select public.read_admin_new_users();'))['site_activity']
        def touch(visitor,account=None):
            prefix=f"set request.jwt.claim.sub='{account}';" if account else ''
            sql(prefix+f"select public.khub_record_site_activity(md5('{visitor}')::uuid);")
        account='00000000-0000-0000-0000-000000000002'
        other='00000000-0000-0000-0000-000000000003'
        assert visit_stats()['total_visits']==['0','0','0']
        touch('tab1',account);touch('tab1',account);touch('tab2',account)
        assert visit_stats()['unique_users']==['1','1','1']
        assert visit_stats()['total_visits']==['1','1','1']
        touch('tab3',other);touch('guest1');touch('guest1')
        assert visit_stats()['unique_users']==['2','2','2']
        assert visit_stats()['total_visits']==['2','2','2']
        assert visit_stats()['guest_visitors']==['1','1','1']
        assert visit_stats()['guest_visits']==['1','1','1']
        sql(f"update khub_bot.site_visits set last_seen=now()-interval '31 minutes' where account_id='{account}';")
        touch('tab2',account)
        assert visit_stats()['total_visits']==['3','3','3']
        # An ongoing visit can contribute an active account without a new start in 24h.
        sql("update khub_bot.site_visits set started_at=now()-interval '25 hours';")
        assert visit_stats()['total_visits']==['0','3','3']
        assert visit_stats()['unique_users']==['2','2','2']
        sql(f"update khub_bot.site_visits set last_seen=now()-interval '169 hours',started_at=now()-interval '170 hours' where account_id='{other}';")
        assert visit_stats()['unique_users']==['1','1','2']
        for role in ['anon','authenticated']:
            sql(f'set role {role};select * from khub_bot.site_visits;',error='permission denied')
        sql("set role anon;select public.read_admin_new_users();",error='permission denied')
        assert len(json.loads(sql(admin+'select public.read_admin_new_users(2);'))['users'])==7
        login_rows=sql('select count(*) from khub_bot.login_events;')
        session(99,99)
        assert sql('select count(*) from khub_bot.login_events;')==login_rows
        assert sql('select count(*) from public.site_activity;')=='4'
        sql(f"update khub_bot.site_visits set last_seen=now()-interval '31 minutes' where account_id='{account}';")
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda visitor: touch(visitor,account),['parallel1','parallel2']))
        assert sql(f"select count(*) from khub_bot.site_visits where account_id='{account}';")=='3'
        sql("insert into khub_bot.site_visits(identity_key,account_id,started_at,last_seen) select 'old:'||i,null,now()-interval '33 days',now()-interval '32 days' from generate_series(1,75) i;")
        touch('tab1',account)
        assert sql("select count(*) from khub_bot.site_visits where last_seen<now()-interval '31 days';")=='25'
        before=sql('select count(*) from khub_bot.site_visits;')
        sql("begin;select public.khub_record_site_activity(md5('rolled-back-visit')::uuid);rollback;")
        assert sql('select count(*) from khub_bot.site_visits;')==before
        print('PASS: repeated heartbeats, cross-tab account dedupe, 30-minute visits, guest separation, active-vs-start windows, registration parity, privacy and login trigger retirement')
        sql('truncate public.profiles;')
        assert json.loads(sql(admin + 'select public.read_admin_new_users();'))['registration_counts'] == ['0', '0', '0']
        print('PASS: password login capture, session dedupe, refresh/recovery exclusions, rollback, bounded retention, logout history and privacy')
        print('PASS: rolling windows, future/old exclusions, counts, weekly list parity, pagination, empty state and administrator-only access')
    finally:
        pg('-m', 'fast', '-w', 'stop')
