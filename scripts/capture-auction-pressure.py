#!/usr/bin/env python3
"""Bounded local read-only incident capture. See docs/AUCTION_LIVE_CAPTURE.md."""
import argparse
import base64
import datetime as dt
import getpass
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import shutil
import threading
import time
import urllib.request
from urllib.parse import urlsplit, unquote, quote

ROOT = Path(__file__).resolve().parent

def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()

# No raw query text, parameters, usernames or player identities are exported.
PRESSURE = r"""
with a as materialized (
 select pid,backend_type,state,wait_event_type,wait_event,query_id::text,
 extract(epoch from clock_timestamp()-query_start) age_seconds,
 pg_blocking_pids(pid) blockers,
 case when query ~* '^\s*with\s+pgrst_source' then
 coalesce(substring(query from '"public"\."([a-z_][a-z0-9_]*)"\s*\('),
 substring(query from 'public\.([a-z_][a-z0-9_]*)\s*\(')) end rpc
 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
), l as (
 select pid,granted,mode from pg_locks where locktype='advisory'
 and database=(select oid from pg_database where datname=current_database())
 and classid=0 and objid=3888760 and objsubid=1
)
select jsonb_build_object('captured_at',clock_timestamp(),
 'sessions',(select count(*) from a),
 'active',coalesce((select jsonb_agg(to_jsonb(x)) from (
 select * from a where state='active' order by age_seconds desc limit 30) x),'[]'),
 'blocked',coalesce((select jsonb_agg(to_jsonb(x)) from (
 select * from a where cardinality(blockers)>0 order by age_seconds desc limit 30)x),'[]'),
 'financial_lock',coalesce((select jsonb_agg(to_jsonb(l)) from l),'[]'),
 'database',(select to_jsonb(d)-'datid'-'datname' from pg_stat_database d where datname=current_database()));
"""

class SetupError(Exception):
    """Only fixed, credential-free messages may be exposed."""

def find_psql():
    found = shutil.which('psql')
    if found:
        return found
    for base in ('/opt/homebrew/opt', '/usr/local/opt'):
        for package in ('libpq', 'postgresql@17', 'postgresql@16', 'postgresql@15', 'postgresql'):
            candidate = Path(base)/package/'bin/psql'
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    raise SetupError('psql not found on PATH or in standard Homebrew locations')

def database_fields(dsn):
    dsn = dsn.strip()
    if len(dsn) > 1 and dsn[0] == dsn[-1] and dsn[0] in ("'", '"'):
        dsn = dsn[1:-1]
    if not dsn.startswith(('postgres://', 'postgresql://')):
        raise SetupError('first prompt needs the entire postgresql:// connection string')
    if '[YOUR-PASSWORD]' in dsn or '[your-password]' in dsn:
        raise SetupError('replace the password placeholder, including its brackets, with your database password')
    try:
        uri = urlsplit(dsn)
        host, port, user, password = uri.hostname, uri.port, uri.username, uri.password
    except ValueError:
        raise SetupError('connection URI could not be parsed; remove placeholder brackets and percent-encode special password characters') from None
    if not host or not user:
        raise SetupError('connection URI is missing host or user; copy the entire connection string')
    if not password:
        raise SetupError('connection URI is missing the database password')
    if re.search(r'%(?![0-9a-fA-F]{2})', dsn):
        raise SetupError('invalid percent encoding in URI; a literal percent character must be %25')
    return dict(PGHOST=host, PGPORT=str(port or 5432), PGUSER=unquote(user),
                PGPASSWORD=unquote(password), PGDATABASE=unquote(uri.path.lstrip('/') or 'postgres'))

class Database:
    def __init__(self, dsn):
        fields = database_fields(dsn)
        executable = find_psql()
        env = dict(os.environ, **fields)
        env.update(PGCONNECT_TIMEOUT='5', PGAPPNAME='khub_incident_capture',
                   PGSSLMODE='require',
                   PGOPTIONS='')
        self.proc = subprocess.Popen([executable, '-X', '-q', '-A', '-t', '-w'],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, env=env)
        self.error_categories = set()
        def read_errors():
            categories = [
                ('password authentication failed', 'database password rejected'),
                ('no password supplied', 'connection URI has no password'),
                ('tenant or user not found', 'pooler host or username does not match project'),
                ('could not translate host name', 'hostname/DNS failure'),
                ('network is unreachable', 'network/IPv6 unreachable; use Session pooler'),
                ('connection refused', 'connection refused'),
                ('no such file or directory', 'psql attempted a missing local socket'),
                ('timeout expired', 'connection timed out'),
                ('unsupported startup parameter', 'pooler rejected startup settings'),
                ('invalid uri', 'invalid connection URI'),
                ('invalid percent', 'password/URI percent encoding invalid'),
                ('permission denied', 'database permission denied'),
                ('ssl', 'SSL connection error'),
                ('statement timeout', 'monitor query exceeded deadline'),
            ]
            for line in self.proc.stderr:
                for needle, label in categories:
                    if needle in line.lower():
                        self.error_categories.add(label)
        self.error_thread = threading.Thread(target=read_errors, daemon=True)
        self.error_thread.start()
        self.lines = queue.Queue()
        def read():
            for line in self.proc.stdout:
                self.lines.put(line.rstrip('\n'))
            self.lines.put(None)
        threading.Thread(target=read, daemon=True).start()

    def read(self, sql):
        if self.proc.poll() is not None:
            raise RuntimeError('database connection closed')
        # Poolers may ignore startup PGOPTIONS. Apply guards explicitly inside
        # each transaction, which also works when a backend is reassigned.
        guarded = ("BEGIN READ ONLY;\n"
                   "SET LOCAL statement_timeout='1500ms';\n"
                   "SET LOCAL lock_timeout='100ms';\n"
                   "SET LOCAL idle_in_transaction_session_timeout='3000ms';\n"
                   + sql.rstrip() + "\nCOMMIT;\n\\echo CAPTURE_END\n")
        self.proc.stdin.write(guarded)
        self.proc.stdin.flush()
        values = []
        deadline = time.monotonic() + 8
        while True:
            try:
                line = self.lines.get(timeout=max(.01, deadline-time.monotonic()))
            except queue.Empty:
                self.close()
                raise RuntimeError('database capture deadline') from None
            if line is None:
                raise RuntimeError('database connection closed')
            if line == 'CAPTURE_END':
                break
            if line.strip():
                values.append(line)
        if len(values) != 1:
            raise RuntimeError('query canceled, unavailable or access denied')
        return json.loads(values[0])

    def failure_category(self):
        self.error_thread.join(timeout=.3)
        return '; '.join(sorted(self.error_categories)) or 'unclassified connection/query failure'

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

# Keep aggregate infrastructure series only. Unknown exporter families are omitted.
METRIC = re.compile(r'^(node_(?:memory_|vmstat_|cpu_seconds_total|disk_|pressure_|load)|pg_stat_database_(?:numbackends|deadlocks|temp_bytes|blks_|xact_)|pg_up\b)')

def capture_metrics(url, key, directory, stop):
    opener = urllib.request.build_opener(NoRedirect)
    while not stop.is_set():
        started = time.monotonic()
        record = {'captured_at': stamp()}
        try:
            auth = base64.b64encode(('service_role:' + key).encode()).decode()
            request = urllib.request.Request(url + '/customer/v1/privileged/metrics',
                                             headers={'Authorization': 'Basic ' + auth})
            with opener.open(request, timeout=8) as response:
                body = response.read(8 * 1024 * 1024 + 1)
            if len(body) > 8 * 1024 * 1024:
                raise ValueError('oversized metrics')
            lines = [line for line in body.decode().splitlines() if METRIC.match(line)]
            record.update(status='ok' if lines else 'no_allowlisted_series', series=lines)
        except Exception:
            record['status'] = 'unavailable'
        record['elapsed_ms'] = round((time.monotonic()-started)*1000)
        with (directory/'host-metrics.jsonl').open('a') as f:
            f.write(json.dumps(record)+'\n')
        print(f"{stamp()} host metrics: {record['status']}", flush=True)
        stop.wait(60)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=int, default=420, help='default 7 minutes: start 5 minutes before end')
    parser.add_argument('--interval', type=int, default=5)
    parser.add_argument('--connection-fields', action='store_true', help='enter host/user/password separately; no URI password encoding needed')
    args = parser.parse_args()
    if not 30 <= args.seconds <= 900 or not 5 <= args.interval <= 60:
        parser.error('seconds must be 30–900; interval 5–60')
    os.umask(0o077)
    if args.connection_fields:
        host = input('Session pooler host (copy host field, no port): ').strip()
        user = input('Database user (copy user field, postgres.PROJECT): ').strip()
        port = input('Port [5432]: ').strip() or '5432'
        if not re.fullmatch(r'[a-zA-Z0-9.-]+', host) or not port.isdigit() or not 1 <= int(port) <= 65535:
            parser.error('Enter the hostname only and a valid numeric port')
        password = getpass.getpass('Database password (hidden; enter actual password, no brackets or encoding): ')
        dsn = 'postgresql://' + quote(user, safe='') + ':' + quote(password, safe='') + '@' + host + ':' + port + '/postgres'
    else:
        dsn = os.environ.get('CAPTURE_DATABASE_URL') or getpass.getpass('Supabase PostgreSQL connection URI (hidden): ')
    try:
        database_fields(dsn)
        find_psql()
    except SetupError as error:
        parser.error(str(error))
    url = (os.environ.get('SUPABASE_URL') or input('Supabase project URL (https://PROJECT.supabase.co): ')).strip().rstrip('/')
    if not re.fullmatch(r'https://[a-z0-9-]+\.supabase\.co', url):
        parser.error('Use the canonical HTTPS Supabase project URL')
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or getpass.getpass('Service-role JWT for metrics (hidden): ')
    directory = ROOT/'incident-captures'/dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    directory.mkdir(parents=True, exist_ok=False)
    print(f'Capture directory: {directory}\nRead-only; one connection; no automatic reconnects.', flush=True)
    stop = threading.Event()
    db = None
    thread = None
    def save(name, value):
        (directory/name).write_text(json.dumps(value, indent=2)+'\n')
    def snapshot(name):
        try:
            save(name, db.read((ROOT/'query-stats-snapshot.sql').read_text()))
            print(f'{stamp()} {name}: saved', flush=True)
        except Exception:
            save(name, {'status':'unavailable', 'captured_at':stamp()})
            print(f'{stamp()} {name}: unavailable; continuing', flush=True)
    try:
        db = Database(dsn)
        probe = db.read("select jsonb_build_object('read_only',current_setting('transaction_read_only'),'stats_visible',pg_has_role(current_user,'pg_read_all_stats','MEMBER'));")
        if probe.get('read_only') != 'on':
            raise SetupError('explicit read-only transaction was not confirmed')
        print(f"Stats visibility role: {probe['stats_visible']} (owner/superuser may also see stats)", flush=True)
        thread = threading.Thread(target=capture_metrics, args=(url,key,directory,stop), daemon=True)
        thread.start()
        snapshot('before.json')
        start = time.monotonic()
        save('manifest.json', {'started_at':stamp(),'seconds':args.seconds,'interval':args.interval,
                               'statement_timeout_ms':1500,'probe':probe})
        while time.monotonic()-start < args.seconds:
            began = time.monotonic()
            try:
                result = db.read(PRESSURE)
                result['collector_elapsed_ms'] = round((time.monotonic()-began)*1000)
                active = result['active']
                print(f"{stamp()} active={len(active)} blocked={len(result['blocked'])} financial_locks={len(result['financial_lock'])} oldest={max((x['age_seconds'] or 0 for x in active),default=0):.1f}s", flush=True)
            except Exception:
                result = {'captured_at':stamp(),'status':'unavailable'}
                print(f'{stamp()} pressure unavailable; no immediate retry', flush=True)
                if db.proc.poll() is not None:
                    break
            with (directory/'pressure.jsonl').open('a') as f:
                f.write(json.dumps(result)+'\n')
            time.sleep(max(0, min(args.interval-(time.monotonic()-began), args.seconds-(time.monotonic()-start))))
    except KeyboardInterrupt:
        print('Stopping; preserving partial capture.', flush=True)
    except SetupError as error:
        print(f'Capture setup failed: {error}.', flush=True)
    except Exception:
        category = db.failure_category() if db is not None else 'psql unavailable or collector initialization failed'
        print(f'Capture failed: {category}. Raw errors and credentials remain hidden.', flush=True)
    finally:
        if db is not None:
            snapshot('after.json')
            db.close()
        stop.set()
        if thread:
            thread.join(timeout=10)
        save('finished.json', {'finished_at':stamp()})
        print(f'Saved available evidence in {directory}', flush=True)

if __name__ == '__main__':
    main()
