"""Isolated raffle backend regression using a minimal existing-delivery fixture."""
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
        sql("""create role service_role; create role anon; create role authenticated; create schema auth; create schema khub_bot;
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
        sql("""alter table public.profiles add column kol_player_id bigint;
        update public.profiles set kol_player_id=100;
        create table khub_bot.receipts(mail_id text primary key,sender_id bigint,received_at timestamptz,payload jsonb,result text default 'processing');
        create table khub_bot.deliveries(id uuid default gen_random_uuid(),dedupe_key text unique,auction_id uuid,receipt_id text,recipient_id bigint,kind text,meat bigint default 0,item_id integer,quantity bigint default 0,message text,state text default 'pending');
        create function public.bot_liabilities() returns jsonb language sql as $$select '{"meat":"0","items":{}}'::jsonb$$;
        create function public.bot_ingest_mail(jsonb) returns text language sql as $$select 'existing'::text$$;
        create function public.bot_worker_status() returns jsonb language sql as $$select '{}'::jsonb$$;
        """)
        foundation=(ROOT/'supabase/migrations/202610190004_kmail_escrow.sql').read_text()
        queue=foundation[foundation.index('create function khub_bot.queue('):]
        sql(queue[:queue.index('$$;',queue.index('as $$'))+3])
        sql(next(p for p in [ROOT/'supabase/migrations/queue/202611040199_raffle_backend.sql', ROOT/'supabase/migrations/202611040199_raffle_backend.sql'] if p.exists()).read_text())
        rid='00000000-0000-0000-0000-000000000002'
        sql(admin+f"select public.activate_mystery_raffle('{rid}')",'preview-only')
        sql(f"insert into khub_bot.raffle_accounts(raffle_id,admin_player_id) values('{rid}',100); update public.mystery_raffles set state='active' where id='{rid}';")
        import json
        def mail(mid, command='raffle', meat=2000000, items=None, sender=200):
            return dict(id=str(mid),sender_id=sender,received_at='2026-01-01T00:00:00Z',meat=meat,items=items or [],command=dict(type=command,raffle_id=rid))
        def ingest(m):
            return sql("select public.bot_ingest_mail('"+json.dumps(m)+"'::jsonb)")
        assert ingest(mail(1))=='raffle_tickets'
        assert ingest(mail(1))=='duplicate'
        assert ingest(mail(2,meat=1000000))=='raffle_tickets'
        assert sql('select ticket_count from khub_bot.raffle_accounts')=='3'
        assert ingest(mail(3,meat=5))=='raffle_refund'
        assert ingest(mail(4,'raffle_supply',0,[dict(id=1,quantity=25)],100))=='raffle_supply'
        assert sql("select public.bot_liabilities()->>'meat'")=='3000000'
        assert sql("set role anon;select winner_player_id from public.mystery_raffles") == ''
        sql('set role authenticated;select * from khub_bot.raffle_purchases','permission denied')
        assert json.loads(sql(admin+f"select public.read_my_raffle_tickets('{rid}')"))['ticket_count']=='0'
        sql(f"update public.mystery_raffles set ends_at=now()-interval '1 minute' where id='{rid}'")
        assert ingest(mail(5))=='raffle_refund'
        work=json.loads(sql('select public.bot_raffle_draw_work()'))
        assert len(work)==1
        assert json.loads(sql('select public.bot_raffle_draw_work()'))==work
        result=dict(method='crypto-rejection-ticket-then-prize-v1',snapshot=dict(raffleId=rid,prizes=work[0]['prizes']),winningTicket='1',winnerPlayerId='200',selectedOutcome='1',prizeIndex='0')
        sql(f"select public.bot_commit_raffle_draw('{rid}','"+json.dumps(result)+"');select public.bot_raffle_tick();")
        assert sql('select held_meat from khub_bot.raffle_accounts')=='3000000'
        assert sql("select quantity from khub_bot.raffle_inventory")=='5'
        sql("select public.bot_raffle_tick()")
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like '%:prize:%'")=='1'
        sql("update khub_bot.deliveries set state='unknown' where dedupe_key like '%:prize:%'; select public.bot_raffle_tick();")
        assert sql('select held_meat from khub_bot.raffle_accounts')=='3000000'
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like '%:proceeds:%'")=='0'
        sql("update khub_bot.deliveries set state='sent' where dedupe_key like '%:prize:%'; select public.bot_raffle_tick();")
        assert sql('select held_meat from khub_bot.raffle_accounts')=='3000000'
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like '%:proceeds:%'")=='0'
        sql("update khub_bot.deliveries set state='sent'; select public.bot_raffle_tick();")
        assert sql('select held_meat from khub_bot.raffle_accounts')=='0'
        assert sql("select sum(meat) from khub_bot.deliveries where dedupe_key like '%:proceeds:%'")=='3000000'
        assert sql("select sum(quantity) from khub_bot.deliveries where dedupe_key like '%:return:%'")=='5'
        sql("select public.bot_raffle_tick()")
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like '%:proceeds:%'")=='1'
        for suffix,cancel in [('3',True),('4',False)]:
            new_id='00000000-0000-0000-0000-00000000000'+suffix
            sql(admin+call.replace(rid,new_id))
            sql(f"insert into khub_bot.raffle_accounts(raffle_id,admin_player_id) values('{new_id}',100); update public.mystery_raffles set state='active' where id='{new_id}';")
            deposit=mail(10+int(suffix),'raffle_supply',25,[dict(id=1,quantity=2)],100)
            deposit['command']['raffle_id']=new_id
            assert ingest(deposit)=='raffle_supply'
            if cancel:
                payment=mail(20+int(suffix));payment['command']['raffle_id']=new_id
                assert ingest(payment)=='raffle_tickets'
                sql(admin+f"select public.cancel_mystery_raffle('{new_id}')")
            else:
                sql(f"update public.mystery_raffles set ends_at=now()-interval '1 minute' where id='{new_id}'; select public.bot_raffle_draw_work();")
            sql('select public.bot_raffle_tick();select public.bot_raffle_tick();')
            assert sql(f"select held_meat from khub_bot.raffle_accounts where raffle_id='{new_id}'")=='0'
            assert sql(f"select sum(quantity) from khub_bot.deliveries where dedupe_key like 'raffle:{new_id}:return:%'")=='2'
            assert sql(f"select sum(meat) from khub_bot.deliveries where dedupe_key like 'raffle:{new_id}:contribution:%'")=='25'
            if cancel:
                assert sql(f"select sum(meat) from khub_bot.deliveries where dedupe_key like 'raffle:{new_id}:refund:%'")=='2000000'
        print('Raffle backend fixture: gate, privacy, intake dedupe, reserves, draw freeze, verified settlement passed.')
    finally:
        pg('-m', 'immediate', '-w', 'stop')
