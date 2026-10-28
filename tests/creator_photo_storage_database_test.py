"""Check the creator photo policy against an isolated PostgreSQL fixture."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BIN = Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip())
MIGRATIONS = ROOT / 'supabase/migrations'
MIGRATION = MIGRATIONS / 'queue/202610280130_creator_photo_reads.sql'
if not MIGRATION.exists():
    MIGRATION = MIGRATIONS / '202610280130_creator_photo_reads.sql'

with tempfile.TemporaryDirectory(prefix='khub-creator-policy-', dir='/tmp') as folder:
    data = Path(folder) / 'data'
    subprocess.run([str(BIN / 'initdb'), '-D', str(data), '-A', 'trust', '--no-locale'], check=True, capture_output=True)
    started = False
    try:
        subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-l', str(Path(folder) / 'postgres.log'), '-o', f"-F -h '' -k {folder}", '-w', 'start'], check=True, capture_output=True)
        started = True

        def sql(query, expect_success=True):
            result = subprocess.run([str(BIN / 'psql'), '-h', folder, '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=query, capture_output=True, text=True)
            assert (result.returncode == 0) == expect_success, result.stderr
            return result.stdout.strip(), result.stderr

        sql("""
            create role anon; create role authenticated; create schema storage;
            create table storage.buckets(id text primary key, public boolean not null);
            create table storage.objects(bucket_id text, name text);
            alter table storage.objects enable row level security;
            grant usage on schema storage to anon, authenticated;
            grant select on storage.objects to anon, authenticated;
            insert into storage.buckets values ('creator-photos', true);
            insert into storage.objects values
              ('creator-photos','friends.jpeg'), ('creator-photos','grad.png'),
              ('creator-photos','or.JPEG'), ('creator-photos','Tbar.png'),
              ('creator-photos','savannah.jpeg'), ('creator-photos','Yosemite.png'),
              ('creator-photos','OFFICIAL APPROVAL.png'), ('creator-photos','IMG_5578.JPEG'),
              ('another-bucket','friends.jpeg');
        """)
        _, error = sql(MIGRATION.read_text(), expect_success=False)
        assert 'missing or not private' in error
        sql("update storage.buckets set public=false where id='creator-photos';")
        sql(MIGRATION.read_text())
        sql(MIGRATION.read_text())
        for role in ('anon', 'authenticated'):
            output, _ = sql(f"set role {role}; select string_agg(name, ',' order by name) from storage.objects;")
            assert output == 'Tbar.png,Yosemite.png,friends.jpeg,grad.png,or.JPEG,savannah.jpeg', (role, output)
            sql(f"set role {role}; insert into storage.objects values ('creator-photos','new.png');", expect_success=False)
        print('Creator photo policy: selected reads allowed; other objects and writes denied.')
    finally:
        if started:
            subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'], check=True, capture_output=True)
