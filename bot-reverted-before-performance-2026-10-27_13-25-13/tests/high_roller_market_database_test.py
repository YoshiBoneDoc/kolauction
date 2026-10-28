"""Exercise Mall market price imports and reads against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/high_roller_market_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-high-roller-market-',dir='/tmp') as folder:
    data=Path(folder)/'data'
    subprocess.run([str(BIN/'initdb'),'-D',str(data),'-A','trust','--no-locale'],check=True,capture_output=True)
    def pg(*args):
        return subprocess.run([str(BIN/'pg_ctl'),'-D',str(data),*args],check=True,capture_output=True)
    started=False
    try:
        pg('-l',str(Path(folder)/'postgres.log'),'-o',f"-F -h '' -k {folder}",'-w','start');started=True
        serial=0
        def sql(query,uid=None,error=None):
            global serial
            serial+=1
            path=Path(folder)/f'query-{uuid4()}.sql'
            path.write_text((f"set request.jwt.claim.sub='{uid}';\n" if uid else '')+query)
            r=subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-f',str(path)],capture_output=True,text=True)
            if error:
                assert r.returncode and error.lower() in r.stderr.lower(),r.stderr
            else: assert r.returncode==0,r.stderr
            return r.stdout.strip()
        def lit(value): return "'"+value.replace("'","''")+"'"
        sql('''create role anon;create role authenticated;create role service_role bypassrls;
            create schema auth;
            create table auth.users(id uuid primary key,instance_id uuid,aud text,role text,email text unique,encrypted_password text,
                email_confirmed_at timestamptz,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}',
                is_super_admin boolean default false,created_at timestamptz,updated_at timestamptz,banned_until timestamptz,
                confirmation_token text,recovery_token text,email_change_token_current text,email_change_token_new text,email_change text,
                phone_change_token text,phone_change text,reauthentication_token text);
            create table auth.identities(id uuid primary key,provider_id text,user_id uuid references auth.users(id) on delete cascade,
                identity_data jsonb,provider text,created_at timestamptz,updated_at timestamptz);
            create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade);
            create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
            grant usage on schema public,auth to anon,authenticated,service_role;
            grant execute on function auth.uid() to anon,authenticated;
        ''')
        migrations=sorted([*ROOT.glob('supabase/migrations/*.sql'),*ROOT.glob('supabase/migrations/queue/*.sql')],key=lambda p:p.name)
        assert len({p.name for p in migrations})==len(migrations)
        for migration in migrations:
            if migration.name<'202610240108_':sql(migration.read_text())
        catalog_path=ROOT/'src/data/items.json'
        if not catalog_path.exists(): catalog_path=ROOT/'catalog/items.json'
        catalog=json.loads(catalog_path.read_text())
        # Website bundle contains tradeable items only. Add explicitly synthetic
        # non-tradeable rows to satisfy the full-snapshot importer in this test.
        catalog += [{'id':1900000+i,'name':f'Untradeable fixture {i}','image':'test.gif','tradeable':False}
            for i in range(max(0,10000-len(catalog)))]
        sql('select public.bot_replace_item_catalog('+lit(json.dumps(catalog))+",now(),repeat('a',64));")
        sql(next(p for p in migrations if p.name=='202610240108_mall_market_prices.sql').read_text())
        ids=[int(i) for i in sql('select id from khub_bot.catalog where is_current and tradeable order by id limit 3;').splitlines()]
        a,b,c=ids
        def stamp(minutes): return sql(f"select clock_timestamp()-interval '{minutes} minutes';")
        def ingest(items,when,error=None,role='service_role'):
            return sql(f"set role {role};select public.bot_import_market_prices({lit(json.dumps(items))},'{when}');",error=error)
        def read(role='anon'):
            return json.loads(sql(f"set role {role};select public.read_market_prices(array[{a},{b},{c},2147483647]);"))
        def state(): return sql('select public.bot_market_price_state();')
        def assets():
            return sql("select jsonb_build_object('auctions',(select count(*) from public.auctions),'bids',(select count(*) from public.bids),'deliveries',(select count(*) from khub_bot.deliveries),'closet',(select count(*) from khub_bot.closet_transfers));")
        before=assets()
        first=stamp(10)
        ingest([{'item_id':a,'price_meat':1250000},{'item_id':b,'price_meat':200}],first)
        result={r['item_id']:r for r in read()}
        assert result[a]['price_meat']==1250000 and result[a]['available']
        assert result[c]['price_meat'] is None and not result[c]['available']
        assert result[2147483647]['price_meat'] is None
        assert {r['item_id']:r for r in read('authenticated')}==result
        sql('set role anon;select * from khub_bot.market_prices;',error='permission denied')
        sql('set role authenticated;select public.bot_market_price_failure();',error='permission denied')
        ingest([],first,error='permission denied',role='anon')
        sql('set role anon;select public.bot_market_price_state();',error='permission denied')
        sql('set role service_role;select public.bot_market_price_failure();')
        assert {r['item_id']:r for r in read()}==result
        assert json.loads(state())['last_failure_at']
        second=stamp(9)
        ingest([{'item_id':a,'price_meat':None},{'item_id':c,'price_meat':300}],second)
        result={r['item_id']:r for r in read()}
        assert not result[a]['available'] and result[a]['price_meat'] is None and result[a]['observed_at'] is not None
        assert sql(f'select price_meat from khub_bot.market_prices where item_id={a};')=='1250000'
        assert not result[b]['available'] # omitted from complete snapshot
        assert result[c]['available'] and result[c]['price_meat']==300
        before_state=state()
        ingest([{'item_id':a,'price_meat':999}],first) # older snapshot cannot overwrite
        assert state()==before_state
        ingest([],second) # duplicate commit/retry is a no-op
        assert state()==before_state
        for invalid in [[{'item_id':a,'price_meat':-1}],[{'item_id':a,'price_meat':1},{'item_id':a,'price_meat':2}],
                        [{'item_id':a,'price_meat':9007199254740992}],[{'item_id':a}], [{'item_id':a,'price_meat':'123'}]]:
            ingest(invalid,stamp(8),error='market')
            assert state()==before_state
            assert {r['item_id']:r for r in read()}==result
        ingest([],sql("select clock_timestamp()+interval '1 day';"),error='Invalid market snapshot')
        sql('set role anon;select public.read_market_prices(array(select generate_series(1,501)));',error='at most 500')
        # The market importer does not acquire the escrow advisory lock.
        with subprocess.Popen([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) as lock:
            lock.stdin.write("begin;select pg_advisory_xact_lock(3888760);select 'LOCKED';\n");lock.stdin.flush()
            while lock.stdout.readline().strip()!='LOCKED': pass
            sql("set statement_timeout='2s';select public.bot_import_market_prices('[]',clock_timestamp());")
            lock.stdin.write('rollback;\n');lock.stdin.close();lock.wait(timeout=5)
        assert all(not r['available'] for r in read()) # empty Mall is a valid unavailable snapshot
        assert before==assets()
        # Future completions freeze their market value; historical completions are not backfilled.
        payload={'id':'market-account','sender_id':48888709,'sender_name':'Market Seller',
            'received_at':'2026-10-24T12:00:00Z','command':{'type':'register'},'meat':0,'items':[],
            'raw':{'id':'market-account','fromid':'48888709','fromname':'Market Seller','type':'normal','message':'REGISTER'}}
        payload['id']='9888709';payload['raw']['id']='9888709'
        job=json.loads(sql('select public.bot_prepare_account_mail('+lit(json.dumps(payload))+",'Kh9!FixturePassword');"))
        metadata=lit(json.dumps({'khub_account_job':'9888709'}))
        sql(f"insert into auth.users(id,email,encrypted_password,raw_app_meta_data,raw_user_meta_data) values('{job['user_id']}',{lit(job['login_email'])},'fixture-hash',{metadata},'{{}}');")
        sql("select public.bot_finish_account_job('9888709');")
        seller=job['user_id']
        def auction(kind='sell',status='active',item=a):
            return sql(f"insert into public.auctions(seller_id,seller_username,item,item_id,quantity,min_bid_meat,duration_hours,end_time,status,auction_kind,escrow_mode,seller_kol_id,settled_at,completed_at) values('{seller}','Market Seller','Item',{item},10,100,24,clock_timestamp()+interval '1 day','{status}','{kind}',true,48888709,case when '{status}'='completed' then clock_timestamp() end,case when '{status}'='completed' then clock_timestamp() end) returning id;")
        historical=auction(status='completed')
        old_rows=sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')
        sql(next(p for p in migrations if p.name=='202610240109_completed_market_values.sql').read_text())
        assert old_rows==sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')
        def completed(ident,role='anon'):
            return json.loads(sql(f"set role {role};select public.read_completed_market_prices(array['{ident}']::uuid[]);"))[0]
        assert not completed(historical)['has_snapshot']
        ingest([{'item_id':a,'price_meat':500}],stamp(0))
        sales=[auction(),auction('buy')]
        for sale in sales:
            assert not completed(sale)['has_snapshot']
            sql(f"update public.auctions set status='completed',settled_at=clock_timestamp(),completed_at=clock_timestamp() where id='{sale}';")
            record=completed(sale)
            assert record['has_snapshot'] and record['price_meat']==500 and record['available']
            assert completed(sale,'authenticated')==record
        inserted_completed=auction(status='completed')
        assert completed(inserted_completed)['price_meat']==500
        frozen=[completed(sale) for sale in sales]
        ingest([{'item_id':a,'price_meat':900}],stamp(0))
        assert [completed(sale) for sale in sales]==frozen
        for sale in sales:
            sql(f"update public.auctions set status='completed',settled_at=clock_timestamp(),completed_at=clock_timestamp() where id='{sale}';")
        assert [completed(sale) for sale in sales]==frozen
        no_price=auction(item=b)
        sql(f"update public.auctions set status='completed',settled_at=clock_timestamp(),completed_at=clock_timestamp() where id='{no_price}';")
        assert completed(no_price)['has_snapshot'] and not completed(no_price)['available']
        assert completed(no_price)['price_meat'] is None
        for status in ['cancelled','expired','settling','awaiting_trade']:
            ident=auction(status=status)
            assert not completed(ident)['has_snapshot']
        sql('set role anon;select * from khub_bot.auction_market_prices;',error='permission denied')
        sql('set role authenticated;select khub_bot.capture_completed_market_price();',error='permission denied')
        prior=sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')
        sql(next(p for p in migrations if p.name=='202610240110_market_value_high_rollers.sql').read_text())
        assert prior==sql('select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;')
        ingest([{'item_id':a,'price_meat':6000000},{'item_id':b,'price_meat':None},{'item_id':c,'price_meat':1}],stamp(0))
        def listing(kind='sell',status='completed',item=a):
            ident=auction(kind,status,item)
            sql(f"update public.auctions set item='High Roller fixture' where id='{ident}';")
            return ident
        market_sales=[listing() for _ in range(26)]
        bid_only=listing(item=b)
        sql(f"update public.auctions set final_price=50000000,winner_id='{seller}',winner_username='Market Seller' where id='{bid_only}';")
        low_sale=listing(item=c)
        active=listing(status='active')
        buy=listing(kind='buy',status='active')
        cancelled=listing(status='cancelled')
        def page(status='completed',sort='high-rollers',number=1,extra=''):
            return json.loads(sql(f"set role anon;select public.read_auction_page('browse',null,'High Roller fixture','{status}','{sort}',{number}{extra});"))
        first_page=page();second_page=page(number=2)
        assert first_page['total']==27 and len(first_page['rows'])==24
        assert len(second_page['rows'])==3
        rows=first_page['rows']+second_page['rows']
        assert {r['id'] for r in rows}==set(market_sales+[bid_only])
        assert rows[-1]['id']==bid_only
        assert all(r['market_value_meat']=='60000000' for r in rows if r['id']!=bid_only)
        assert rows[-1]['market_value_meat']=='0'
        assert first_page['privacy_version']==1
        assert page(sort='price-desc')['total']==28 # ordinary browsing still includes low-price sales
        active_page=page(status='active')
        assert {r['id'] for r in active_page['rows']}=={active,buy}
        for extra in [",'all'",",'all','all'"]:
            assert page(extra=extra)['total']==27 # all three RPC signatures use identical filtering
        all_outcomes=page(status='all')
        assert all_outcomes['total']==29 and cancelled not in {r['id'] for r in all_outcomes['rows']}
        assert sql(f"select khub_bot.auction_market_value({a},5000000000);")=='30000000000000000'
        sql(f"set role anon;select khub_bot.auction_market_value({a},1);",error='permission denied')
        print('PASS: market total OR bid/final price >=50M, missing estimates, Buy/Sell parity, pre-pagination filtering, all reader signatures, preserved privacy and ordinary browsing, exact large totals')
    finally:
        if started:pg('-m','fast','-w','stop')
