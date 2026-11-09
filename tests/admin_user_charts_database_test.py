"""Disposable PostgreSQL: rolling registration counts, pagination and access control."""
import json
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
        sql('truncate public.profiles;')
        assert json.loads(sql(admin + 'select public.read_admin_new_users();'))['registration_counts'] == ['0', '0', '0']
        print('PASS: rolling windows, future/old exclusions, counts, weekly list parity, pagination, empty state and administrator-only access')
    finally:
        pg('-m', 'fast', '-w', 'stop')
