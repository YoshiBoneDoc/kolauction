"""Isolated Phase 1 schema/security regression; no production or bot access."""
from pathlib import Path
import subprocess
import tempfile
ROOT = Path(__file__).resolve().parents[1]
BIN = Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-raffles-', dir='/tmp') as folder:
    data = Path(folder)/'data'
    subprocess.run([str(BIN/'initdb'), '-D', str(data), '-A', 'trust', '--no-locale'], check=True, capture_output=True)
    def pg(*args):
        subprocess.run([str(BIN/'pg_ctl'), '-D', str(data), *args], check=True, capture_output=True)
    pg('-l', folder+'/postgres.log', '-o', f"-F -h '' -k {folder}", '-w', 'start')
    def sql(query, error=None):
        result = subprocess.run([str(BIN/'psql'), '-h', folder, '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=query, text=True, capture_output=True)
        if error:
            assert result.returncode and error.lower() in result.stderr.lower(), result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()
    try:
        sql("""create role anon; create role authenticated; create schema auth; create schema khub_bot;
        create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
        create table public.profiles(id uuid primary key);
        insert into public.profiles values('00000000-0000-0000-0000-000000000001');
        create function khub_bot.is_administrator(uuid) returns boolean language sql as $$select $1='00000000-0000-0000-0000-000000000001'::uuid$$;
        create table khub_bot.catalog(id int primary key,name text,image text,is_current boolean,tradeable boolean);
        create function khub_bot.auction_item_eligible(khub_bot.catalog) returns boolean language sql as $$select $1.is_current and $1.tradeable$$;
        insert into khub_bot.catalog values(1,'prize','prize.gif',true,true),(2,'retired','old.gif',false,true);
        """)
        for filename in ['202611040197_mystery_raffle_preparation.sql', '202611040198_raffle_prize_probabilities.sql']:
            path = ROOT/'supabase/migrations/queue'/filename
            if not path.exists(): path = ROOT/'supabase/migrations'/filename
            sql(path.read_text())
        call = "select public.create_mystery_raffle('00000000-0000-0000-0000-000000000002','Mystery Raffle',1000000,now()+interval '7 days','[{\"id\":1,\"quantity\":20,\"probability_bps\":10000}]');"
        admin = "set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';"
        sql('set role authenticated;'+call, 'Administrator required')
        sql('set role anon;'+call, 'permission denied')
        assert sql(admin+call).endswith('00000000-0000-0000-0000-000000000002')
        sql(admin+call)
        assert sql('select count(*) from public.mystery_raffles') == '1'
        assert sql('select state from public.mystery_raffles') == 'preview'
        assert sql('set role anon;select name from public.mystery_raffles') == 'Mystery Raffle'
        sql('set role anon;select creator_id from public.mystery_raffles', 'permission denied')
        sql(admin+"update public.mystery_raffles set state='active'", 'permission denied')
        sql("update public.mystery_raffles set state='active'", 'check constraint')
        sql(admin+"delete from public.mystery_raffle_prizes", 'permission denied')
        assert sql('select probability_bps from public.mystery_raffle_prizes') == '10000'
        sql(admin+"update public.mystery_raffle_prizes set probability_bps=0", 'permission denied')
        fresh = call.replace('000000000002', '000000000003')
        sql(admin+fresh.replace('10000}', '9999}'), '100 percent')
        sql(admin+fresh.replace('1000000,','0,'), 'Invalid raffle')
        sql(admin+fresh.replace('"id":1', '"id":2'), 'eligible catalog')
        sql(admin+fresh.replace('[{"id":1,"quantity":20,"probability_bps":10000}]','[{"id":1,"quantity":1,"probability_bps":5000},{"id":1,"quantity":2,"probability_bps":5000}]'), 'unique constraint')
        assert sql('select count(*) from public.mystery_raffles') == '1'
        sql("update khub_bot.catalog set name='changed'")
        assert sql('select name from public.mystery_raffle_prizes') == 'prize'
        assert sql("select to_regclass('public.auctions') is null") == 't'
        print('Raffle database authorization, preview-only state, atomicity, idempotency and snapshots passed.')
    finally:
        pg('-m', 'immediate', '-w', 'stop')
