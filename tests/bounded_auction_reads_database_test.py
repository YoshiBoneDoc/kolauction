"""Bounded homepage/browse reads, privacy, query work and concurrent bot progress.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/bounded_auction_reads_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-bounded-reads-',dir='/tmp') as folder:
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
            path=Path(folder)/f'query-{serial}.sql'
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
        upgrade=next(p for p in migrations if p.name.startswith('202610280126_'))
        for migration in migrations:
            if migration!=upgrade:sql(migration.read_text())
        definitions="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname in ('public','khub_bot') and p.prokind='f' and p.proname in
            ('bot_ingest_mail','bot_tick','bot_claim_delivery','bot_ack_delivery','finish_listing','finish_buy_order','bot_liabilities');"""
        financial_before=sql(definitions)
        catalog=json.loads((ROOT/'src/data/items.json').read_text())
        catalog += [{'id':1900000+i,'name':f'Untradeable fixture {i}','image':'test.gif','tradeable':False}
            for i in range(max(0,10000-len(catalog)))]
        sql('select public.bot_replace_item_catalog('+lit(json.dumps(catalog))+",now(),repeat('a',64));")
        def account(mid,player,name):
            payload={'id':str(mid),'sender_id':player,'sender_name':name,'received_at':'2026-10-21T12:00:00Z',
                'command':{'type':'register'},'meat':0,'items':[],'raw':{'id':str(mid),'fromid':str(player),'fromname':name,'type':'normal','message':'REGISTER'}}
            job=json.loads(sql('select public.bot_prepare_account_mail('+lit(json.dumps(payload))+",'Kh9!FixturePassword');"))
            sql(f"insert into auth.users(id,email,encrypted_password,raw_app_meta_data) values('{job['user_id']}',{lit(job['login_email'])},'fixture-hash',"+lit(json.dumps({'khub_account_job':str(mid)}))+');')
            sql(f"select public.bot_finish_account_job('{mid}');")
            sql(f"insert into auth.sessions values('{uuid4()}','{job['user_id']}');")
            return job['user_id']
        owner=account(98001,48889801,'Traffic Seller')
        other=account(98002,48889802,'Traffic Buyer')
        restricted=account(98003,48889803,'Restricted Viewer')
        sql("insert into khub_bot.account_bans(kol_player_id,username,reason) values(48889803,'Restricted Viewer','Local restriction fixture');")
        # Over 24 distinct items, duplicate item lots and completed market history.
        sql(f"""insert into public.auctions(seller_id,seller_username,item,quantity,item_id,min_bid_meat,current_bid,duration_hours,created_at,end_time,status)
            select case when n%2=0 then '{owner}'::uuid else '{other}'::uuid end,'Traffic Seller','Traffic Item '||(n%40),1,null,
                n*1000000,n*1000000,24,clock_timestamp()-interval '2 days'+n*interval '1 minute',clock_timestamp()+n*interval '1 minute','active'
            from generate_series(1,100) n;
            insert into public.bids(auction_id,bidder_id,bidder_username,amount,created_at)
            select a.id,'{other}','Traffic Buyer',b*100,clock_timestamp()-interval '1 hour'+b*interval '1 second'
            from public.auctions a cross join generate_series(1,40) b where a.item like 'Traffic Item %';
            insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,current_bid,duration_hours,end_time,status,created_at,final_price,completed_at,seller_confirmed_at,buyer_confirmed_at,winner_id,finalized_at,winner_username)
            select '{owner}','Traffic Seller','Historic item '||n,1,1,n*1000000,24,clock_timestamp()-interval '1 day','completed',clock_timestamp()-interval '2 days',n*1000000,
                clock_timestamp()-n*interval '1 minute',clock_timestamp(),clock_timestamp(),'{other}',clock_timestamp()-n*interval '1 minute','Traffic Buyer' from generate_series(1,50) n;
            insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,current_bid,duration_hours,end_time,status,cancelled_at)
            values('{owner}','Traffic Seller','Canceled fixture',1,100,0,24,clock_timestamp()+interval '3 days','cancelled',clock_timestamp());
            insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,current_bid,duration_hours,end_time,status,created_at)
            values('{owner}','Traffic Seller','Finalizing fixture',1,100,0,24,clock_timestamp()-interval '1 minute','active',clock_timestamp()-interval '2 days');
        """)
        params="'browse',null,'','active','ending',1,'all','all',null,null"
        signature='public.read_filtered_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric)'
        old_body=sql(f"select prosrc from pg_proc where oid='{signature}'::regprocedure;")
        def explain(body):
            import re
            values={'p_view':"'browse'",'p_id':'null::uuid','p_search':"''",'p_status':"'all'",'p_sort':"'newest'",'p_page':'1','p_trade':"'all'",'p_kind':"'all'",'p_min_price':'null::numeric','p_max_price':'null::numeric'}
            body=re.sub(r'\bp_[a-z_]+\b',lambda m:values.get(m[0],m[0]),body).strip().rstrip(';')
            return json.loads(sql('explain(analyze,buffers,format json) '+body))[0]
        sql('analyze public.auctions;analyze public.bids;')
        before_plan=explain(old_body)
        baseline=json.loads(sql(f'select public.read_filtered_auction_page({params});'))
        sql(upgrade.read_text());sql(upgrade.read_text())
        assert financial_before==sql(definitions)
        after_plan=explain(sql(f"select prosrc from pg_proc where oid='{signature}'::regprocedure;"))
        def nodes(n):
            yield n
            for p in n.get('Plans',[]):yield from nodes(p)
        def stats(plan):
            return {'execution_ms':plan['Execution Time'],'bid_index_loops':sum(n['Actual Loops'] for n in nodes(plan['Plan']) if n.get('Index Name','').startswith('bids_auction'))}
        print('PLAN COMPARISON (synthetic local data, not production capacity):',json.dumps({'before':stats(before_plan),'after':stats(after_plan)}))
        assert stats(after_plan)['bid_index_loops']<stats(before_plan)['bid_index_loops']
        print('PASS: migration rerun safe; financial definitions unchanged; per-page bid lookup work reduced')
        def read(view='browse',ident=None,status='all',sort='newest',page=1,trade='all',kind='all',role='anon',uid=None,search='',low='null',high='null'):
            return json.loads(sql(f"set role {role};select public.read_filtered_auction_page('{view}',{lit(ident) if ident else 'null'},{lit(search)},'{status}','{sort}',{page},'{trade}','{kind}',{low},{high});",uid))
        current=read(status='active',sort='ending')
        assert current['total']==baseline['total']+1 # Existing UI includes server-active finalizing auctions.
        assert current['rows'][0]['item']=='Finalizing fixture'
        for sort in ['newest','ending','price-asc','price-desc','bids-desc','bids-asc','activity','ended-desc']:
            one,two=read(sort=sort),read(sort=sort,page=2)
            assert one['total']==152 and len(one['rows'])==len(two['rows'])==24
            assert not set(r['id'] for r in one['rows'])&set(r['id'] for r in two['rows'])
            assert all(r['bid_count']==40 for r in one['rows'] if r['item'].startswith('Traffic Item '))
        cancelled=read(status='cancelled',sort='ended-desc')['rows'][0]
        assert cancelled['item']=='Canceled fixture'
        assert read(status='ended')['total']==51 and read(status='completed')['total']==50
        assert read(trade='none')['total']==0
        assert read(view='others',role='authenticated',uid=owner)['total']==50
        assert read(view='seller',ident=owner,role='authenticated',uid=owner)['total']==102
        assert read(search='Canceled')['total']==1
        assert read(low='90000000')['total']==11
        assert read()['price_bounds']==read(search='Canceled',status='cancelled')['price_bounds']
        # Add a private draft and restricted active lot; neither can enter Home.
        sql(f"""insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,end_time,status,escrow_mode,item_id,seller_kol_id)
            values('{owner}','Traffic Seller','Secret draft',1,1,24,clock_timestamp()+interval '1 day','pending_escrow',true,2,48889801),
                ('{restricted}','Restricted Viewer','Restricted lot',1,1,24,clock_timestamp()+interval '1 day','active',false,null,null);""")
        for role,uid in [('anon',None),('authenticated',other),('authenticated',restricted)]:
            home=json.loads(sql(f'set role {role};select public.read_home_auctions();',uid))
            assert home['privacy_version']==1 and home['bids']==[] and len(home['rows'])<=120
            assert home['total']==100
            by_id={r['id']:r for r in home['rows']}
            assert not any(r['item'] in ['Secret draft','Restricted lot','Finalizing fixture'] for r in home['rows'])
            for section in home['sections'].values():assert len(section)<=24 and all(i in by_id for i in section)
            for name in ['popular','new','ending']:
                assert len({by_id[i]['item'] for i in home['sections'][name]})==24
            assert all(by_id[i]['status']=='completed' for i in home['sections']['recent'])
            if uid is None or uid==restricted:
                assert all(r['usernames_visible']==False and r['seller_username'] not in ['Traffic Seller','Traffic Buyer'] for r in home['rows'])
            else:assert all(r['usernames_visible']==True for r in home['rows'])
        print('PASS: global ordering/counts, filters/ranges, lifecycle, ownership, bounded distinct-item sections and guest/restricted privacy')
        # Compare optimized bounds against the original formula with real catalog
        # quotes, quantities, fallback prices and unavailable market data.
        sql("select public.bot_import_market_prices('[{\"item_id\":2,\"price_meat\":125000000}]',clock_timestamp());")
        sql(f"insert into public.auctions(seller_id,seller_username,item,item_id,quantity,min_bid_meat,current_bid,duration_hours,end_time,status) values('{owner}','Traffic Seller','Market bounds fixture',2,3,1,0,24,clock_timestamp()+interval '1 day','active');")
        original_bounds="""select jsonb_build_object('min',coalesce(min(least(v.price,coalesce(nullif(v.market,0),v.price))),0)::text,'max',coalesce(max(greatest(v.price,v.market)),0)::text)
            from (select khub_bot.filter_auction_price(a) as price,least(9007199254740991::numeric,khub_bot.auction_market_value(a.item_id,a.quantity)) as market
            from public.auctions a where a.status<>'pending_escrow' and not khub_bot.is_abandoned_escrow_draft(a)) v;"""
        assert json.loads(sql('select khub_bot.public_auction_price_bounds();'))==json.loads(sql(original_bounds))
        assert read()['price_bounds']['max']=='375000000'
        sql("select public.bot_import_market_prices('[]',clock_timestamp());")
        assert json.loads(sql('select khub_bot.public_auction_price_bounds();'))==json.loads(sql(original_bounds))
        # A real Buy creation/funding flow exercises the existing projection.
        buy_id=sql("set role authenticated;select public.create_buy_auction(2,10,200,24,'finished');",owner)
        funding=int(sql(f"select funding_required from khub_bot.buy_orders where auction_id='{buy_id}';"))
        stamp=json.loads(sql("select jsonb_build_object('received_at',date_trunc('second',clock_timestamp()),'epoch',floor(extract(epoch from clock_timestamp()))::bigint);"))
        payload={'id':'98009','sender_id':48889801,'sender_name':'Traffic Seller','received_at':stamp['received_at'],'command':{'type':'fund','auction_id':buy_id},'meat':funding,'items':[],
            'raw':{'id':'98009','type':'normal','fromid':'48889801','fromname':'Traffic Seller','message':'FUND '+buy_id,'azunixtime':str(stamp['epoch'])}}
        assert sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(payload))+');')=='accepted'
        buy_page=read(kind='buy')
        assert buy_page['total']==1 and buy_page['rows'][0]['auction_kind']=='buy'
        assert buy_page['rows'][0]['price_per_item']==200 and buy_page['rows'][0]['remaining_quantity']==10
        assert buy_page['rows'][0].get('balance_meat') is None # Another viewer's funds remain private.
        print('PASS: global market bounds match the original formula; funded Buy listings and financial privacy survive bounded reads')

        # Readers must not acquire the bot's global financial lock. Hold it in
        # another connection: the public read must still finish within 2 seconds.
        import time
        lock=subprocess.Popen([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-c',"begin;select pg_advisory_xact_lock(3888760);select pg_sleep(4);commit;"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            time.sleep(.5)
            sql("set statement_timeout='2s';set role anon;select public.read_home_auctions();")
        finally:lock.communicate(timeout=10)
        print('PASS: homepage reads progress while another transaction holds the financial advisory lock')
        # Independent connections exercise concurrent website reads while the
        # normal bot tick closes one overdue Direct auction. Synthetic load only.
        from concurrent.futures import ThreadPoolExecutor
        def pressure(i):
            statement = "set statement_timeout='10s';"
            if i==8:statement += "set role service_role;select public.bot_inspect();select public.bot_tick();"
            elif i%2:statement += "set role anon;select public.read_home_auctions();"
            else:statement += "set role anon;select public.read_filtered_auction_page('browse',null,'','all','newest',1,'all','all',null,null);"
            result=subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',statement],capture_output=True,text=True)
            assert result.returncode==0,result.stderr
        with ThreadPoolExecutor(max_workers=9) as pool:list(pool.map(pressure,range(9)))
        assert sql("select status from public.auctions where item='Finalizing fixture';")=='ended_no_bids'
        print('PASS: eight concurrent website reads plus bot inspection/finalization finish within the local 10-second statement budget')

    finally:
        if started:pg('-m','fast','-w','stop')
