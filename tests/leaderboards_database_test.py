"""Disposable PostgreSQL test of leaderboard accounting, privacy and maintenance wiring."""
import json
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-leaderboards-',dir='/tmp') as folder:
    data=Path(folder)/'data'
    subprocess.run([str(BIN/'initdb'),'-D',str(data),'-A','trust','--no-locale'],check=True,capture_output=True)
    started=False
    try:
        subprocess.run([str(BIN/'pg_ctl'),'-D',str(data),'-l',str(Path(folder)/'log'),'-o',f"-F -h '' -k {folder}",'-w','start'],check=True,capture_output=True)
        started=True
        def sql(query,error=None):
            r=subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],input=query,text=True,capture_output=True)
            if error: assert r.returncode and error.lower() in r.stderr.lower(),r.stderr
            else: assert r.returncode==0,r.stderr
            return r.stdout.strip()
        def migration(name):
            paths=list(ROOT.glob('supabase/migrations/**/'+name));assert len(paths)==1
            return paths[0].read_text()
        sql('''create role anon; create role authenticated; create role service_role;
        create schema auth;create schema khub_bot;
        create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
        create table public.profiles(id uuid primary key,khub_username text,kol_player_name text,kol_player_id bigint,kol_verified_at timestamptz,restricted boolean default false);
        create function khub_bot.profile_is_restricted(actor uuid) returns boolean language sql stable as $$select coalesce((select restricted from public.profiles where id=actor),true)$$;
        create table public.auctions(id uuid primary key,seller_id uuid,winner_id uuid,auction_kind text,status text,final_price bigint,quantity bigint default 1,bundle_items jsonb default '[]');
        create table khub_bot.buy_fulfillments(receipt_id text,auction_id uuid,seller_id uuid,payment_meat bigint,quantity bigint);
        create table khub_bot.deliveries(receipt_id text,dedupe_key text,state text);
        create table khub_bot.receipts(mail_id text primary key,sender_id bigint,result text,payload jsonb);
        create table public.player_ignores(user_id uuid,kol_player_id bigint);
        create table khub_bot.site_totals_dirty(transaction_id bigint primary key);
        create table public.site_activity(last_seen timestamptz);
        create function khub_bot.refresh_public_discovery() returns void language plpgsql as $$begin null;end;$$;
        grant usage on schema public,auth to anon,authenticated;
        ''')
        # Use the established aggregate and donation eligibility definitions, not replicas.
        sql(migration('202610290150_homepage_trade_totals.sql').split('-- Keep both')[0].replace('begin;','')+'commit;')
        sql(migration('202611030174_read_only_home_totals.sql').split('-- Preserve discovery')[0].replace('begin;','')+'commit;')
        sql(migration('202610190017_financial_reports.sql').split('create or replace function public.bot_financial_stats')[0].replace('begin;','')+'commit;')
        financial_definition=sql("select pg_get_functiondef('khub_bot.refresh_site_trade_totals()'::regprocedure);")
        sql(migration('202611130262_real_leaderboards.sql'))
        assert sql("select prosrc from pg_proc where oid='khub_bot.refresh_site_totals_before_leaderboards()'::regprocedure;") in financial_definition
        sql(migration('202611130263_leaderboard_owner_exclusion.sql'))
        sql(migration('202611130264_personal_leaderboard_stats.sql'))
        sql(migration('202611130266_search_leaderboards.sql'))
        sql(migration('202611130267_search_zero_activity_players.sql'))
        refresh_before=sql("select pg_get_functiondef('khub_bot.refresh_leaderboards()'::regprocedure);")
        sql(migration('202611140268_leaderboard_safe_refresh.sql'))
        refresh_after=sql("select pg_get_functiondef('khub_bot.refresh_leaderboards()'::regprocedure);")
        assert refresh_after==refresh_before.replace(
            'delete from khub_bot.leaderboard_totals;',
            'delete from khub_bot.leaderboard_totals where profile_id is not null;')
        # Fail closed on unexpected definitions, including accidental reapplication.
        sql(migration('202611140268_leaderboard_safe_refresh.sql'),error='Unexpected leaderboard refresh definition')
        sql('-- Preserve discovery'+migration('202611030174_read_only_home_totals.sql').split('-- Preserve discovery')[1])
        def uid(i): return f'00000000-0000-0000-0000-{i:012d}'
        for i in range(1,15):
            sql(f"insert into public.profiles values('{uid(i)}','User{i}','Player{i}',{100+i},now(),false);")
        sql(f"update public.profiles set kol_player_name='Anrath1' where id='{uid(5)}';")
        sql(migration('202611130265_leaderboard_alt_exclusion.sql'))
        # Direct/escrow Sell share authoritative completion, canceled and pending do not qualify.
        sql(f"""insert into public.auctions(id,seller_id,winner_id,auction_kind,status,final_price) values
        ('{uid(101)}','{uid(1)}','{uid(2)}','sell','completed',9007199254740993),
        ('{uid(102)}','{uid(1)}','{uid(3)}','sell','completed',100),
        ('{uid(103)}','{uid(1)}','{uid(3)}','sell','cancelled',999999),
        ('{uid(104)}','{uid(1)}',null,'sell','completed',999999),
        ('{uid(105)}','{uid(4)}',null,'buy','cancelled',null);
        insert into khub_bot.buy_fulfillments values ('paid','{uid(105)}','{uid(3)}',200,2),('partial','{uid(105)}','{uid(3)}',900,9),('none','{uid(105)}','{uid(3)}',500,5);
        insert into khub_bot.deliveries values ('paid','buy-fill-payment:paid','sent'),('partial','buy-fill-payment:1','sent'),('partial','buy-fill-payment:2','pending');
        insert into khub_bot.receipts values
        ('donate',102,'donation','{{"meat":500,"raw":{{"type":"normal","message":"DONATE"}}}}'),
        ('implicit',103,'donation','{{"meat":99999,"raw":{{"type":"normal","message":""}}}}'),
        ('gift',103,'donation','{{"meat":99999,"raw":{{"type":"giftshop"}}}}'),
        ('fee',103,'accepted','{{"meat":99999,"raw":{{"type":"normal","message":"DONATE"}}}}');
        update khub_bot.leaderboard_state set refreshed_at='-infinity';
        select khub_bot.refresh_site_trade_totals();""")
        def read(actor=14):
            return json.loads(sql(f"set request.jwt.claim.sub='{uid(actor)}';set role authenticated;select public.read_leaderboards();"))
        result=read()
        volume={r['name']:int(r['value']) for r in result['volume']}
        assert volume=={'Player1':9007199254741093,'Player2':9007199254740993,'Player3':300,'Player4':200},volume
        assert {r['name']:int(r['value']) for r in result['trades']}=={'Player1':2,'Player2':1,'Player3':2,'Player4':1}
        assert result['donors']==[{'id':uid(2),'name':'Player2','value':'500','rank':1}]
        # Exercise deletion of a nonempty snapshot through discovery maintenance.
        # A stale synthetic entry must disappear; cooldown must retain fresh state.
        sql(f"insert into khub_bot.leaderboard_totals values('{uid(14)}',999999999999999999,99,99);")
        sql('select public.bot_refresh_public_discovery();')
        assert sql(f"select count(*) from khub_bot.leaderboard_totals where profile_id='{uid(14)}';")=='1'
        sql("update khub_bot.leaderboard_state set refreshed_at='-infinity';select public.bot_refresh_public_discovery();")
        assert sql(f"select count(*) from khub_bot.leaderboard_totals where profile_id='{uid(14)}';")=='0'
        rebuilt=read()
        assert all(rebuilt[category]==result[category] for category in ['volume','trades','donors','personal'])
        assert int(sql('select count(*) from khub_bot.site_totals_dirty;'))>0
        sql(f"insert into public.player_ignores values('{uid(14)}',101);")
        assert all(r['name']!='Player1' for r in read()['volume'])
        sql(f"insert into public.player_ignores values('{uid(2)}',114);")
        assert all(r['name']!='Player2' for r in read()['volume'])
        sql(f"update public.profiles set restricted=true where id='{uid(3)}';")
        assert all(r['name']!='Player3' for r in read()['volume'])
        sql("set role anon;select public.read_leaderboards();",error='permission denied')
        sql(f"set request.jwt.claim.sub='{uid(3)}';set role authenticated;select public.read_leaderboards();",error='unrestricted')
        sql("set role authenticated;select * from khub_bot.leaderboard_totals;",error='permission denied')
        # Add enough positive totals to exercise bounded top-ten ranking and fresh naming.
        sql("insert into khub_bot.leaderboard_totals select id,50,1,0 from public.profiles where id not in(select profile_id from khub_bot.leaderboard_totals);")
        assert len(read(13)['volume'])==10
        sql(f"update public.profiles set kol_player_name='Renamed' where id='{uid(1)}';")
        assert read(13)['volume'][0]['name']=='Renamed'
        assert [r['rank'] for r in read(13)['volume']]==list(range(1,11))
        sql(f"update public.profiles set kol_player_id=3552305 where id='{uid(1)}';")
        assert all(r['id']!=uid(1) for category in ['volume','trades','donors'] for r in read(13)[category])
        assert len(read(13)['volume'])==10
        assert read(13)['volume'][0]['rank']==1
        assert read(1)['personal']['volume']=='9007199254741093'
        assert read(2)['personal']['donors']=='500'
        assert read(4)['personal']['donors']=='0'
        sql(f"update public.profiles set kol_player_name='RenamedAlt' where id='{uid(5)}';update khub_bot.leaderboard_totals set volume=9999999999999999999,trades=9999,donated=9999 where profile_id='{uid(5)}';")
        assert all(r['id']!=uid(5) for category in ['volume','trades','donors'] for r in read(13)[category])
        assert read(5)['personal']['trades']=='9999'
        assert len(read(13)['volume'])==10
        def search(term,category='volume',offset=0):
            return json.loads(sql(f"set request.jwt.claim.sub='{uid(13)}';set role authenticated;select public.search_leaderboards('{category}','{term}',{offset});"))
        beyond=search('Player14')['rows']
        assert len(beyond)==1 and beyond[0]['rank']>10,beyond
        assert not search('RenamedAlt')['rows']
        assert not search('Player3')['rows']
        assert not search('Renamed')['rows']
        sql(f"insert into public.player_ignores values('{uid(13)}',114);")
        assert not search('Player14')['rows']
        sql(f"delete from public.player_ignores where user_id='{uid(13)}';")
        for i in range(30,60):
            sql(f"insert into public.profiles values('{uid(i)}','Shared{i}','Shared%_{i}',{100+i},now(),false);insert into khub_bot.leaderboard_totals values('{uid(i)}',10,1,10);")
        sql(f"insert into public.profiles values('{uid(90)}','ZeroActivity','ZeroActivity',190,now(),false);")
        for category in ['volume','trades','donors']:
            assert search('ZeroActivity',category)['rows']==[{'id':uid(90),'name':'ZeroActivity','value':'0','rank':None}]
        assert search('Player4','donors')['rows'][0]['rank'] is None
        sql(f"insert into public.player_ignores values('{uid(13)}',190);")
        assert not search('ZeroActivity')['rows']
        sql(f"delete from public.player_ignores where user_id='{uid(13)}';")
        page1=search('%_');page2=search('%_',offset=20)
        assert len(page1['rows'])==20 and page1['more']
        assert len(page2['rows'])==10 and not page2['more']
        assert page2['rows'][0]['rank']>page1['rows'][-1]['rank']
        assert not search('no-match')['rows']
        sql("set role anon;select public.search_leaderboards('volume','Player',0);",error='permission denied')
        sql(f"set request.jwt.claim.sub='{uid(13)}';set role authenticated;select public.search_leaderboards('invalid','Player',0);",error='Invalid leaderboard search')
        print('Leaderboard accounting, exact totals, privacy, ignores, top-ten bounds and maintenance wiring passed.')
    finally:
        if started: subprocess.run([str(BIN/'pg_ctl'),'-D',str(data),'-m','immediate','-w','stop'],check=True,capture_output=True)
