"""Hidden Gems ranking, quote completeness, freshness and read privacy.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/public_listing_projection_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-public-projection-',dir='/tmp') as folder:
    data=Path(folder)/'data'
    subprocess.run([str(BIN/'initdb'),'-D',str(data),'-A','trust','--no-locale','--encoding=UTF8'],check=True,capture_output=True)
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
            create table auth.mfa_amr_claims(id uuid primary key,session_id uuid references auth.sessions(id),authentication_method text,created_at timestamptz,updated_at timestamptz);
            create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
            grant usage on schema public,auth to anon,authenticated,service_role;
            grant execute on function auth.uid() to anon,authenticated;
        ''')
        sql("create schema storage; create table storage.buckets(id text primary key,public boolean); insert into storage.buckets values('creator-photos',false); create table storage.objects(bucket_id text,name text);")
        migrations=sorted([*ROOT.glob('supabase/migrations/*.sql'),*ROOT.glob('supabase/migrations/queue/*.sql')],key=lambda p:p.name)
        assert len({p.name for p in migrations})==len(migrations)
        
        financial_probe="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','khub_bot') and p.prokind='f' and p.proname in ('bot_ingest_mail','bot_tick','bot_claim_delivery','bot_ack_delivery','finish_listing','finish_buy_order','bot_liabilities');"""
        for migration in migrations:
            if migration.name=='202611130258_home_explore_fallback.sql':
                before_projection=sql(financial_probe)
            sql(migration.read_text())
        assert before_projection==sql(financial_probe), 'Financial definitions changed'

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
        item_ids=json.loads(sql("select jsonb_agg(id) from (select id from khub_bot.catalog where is_current and tradeable order by id limit 8) s;"))
        for item_id in item_ids:
            sql(f"insert into khub_bot.market_prices values({item_id},100000,now(),now(),true);")
        def listing(index, minimum, hours=24, giveaway=None):
            return sql(f"insert into public.auctions(seller_id,seller_username,item,item_id,quantity,min_bid_meat,duration_hours,end_time,status,giveaway_title) values('{owner}','Traffic Seller','Gem {index}',{item_ids[index]},1,{minimum},24,now()+interval '{hours} hours','active',"+(lit(giveaway) if giveaway else 'null')+") returning id;")
        best=listing(0,20000)
        lesser=listing(1,50000)
        urgent=listing(2,99000,1)
        giveaway=listing(3,100,48,'Fixture giveaway')
        tiny=listing(4,95001)
        stale=listing(5,100)
        missing=listing(6,100)
        sql(f"update khub_bot.market_prices set checked_at=now()-interval '25 hours',observed_at=now()-interval '25 hours' where item_id={item_ids[5]};")
        sql(f"update khub_bot.market_prices set available=false where item_id={item_ids[6]};")
        def read(sort, private=False):
            if private:
                return json.loads(sql(f"select public.read_filtered_auction_page('browse',null,'','active','{sort}',1,'all','all',null,null,'any','any');",other))
            return json.loads(sql(f"select public.read_public_auction_page('browse',null,'','active','{sort}',1,'all','all',null,null,'any','any');"))
        for private in [False,True]:
            recommended=read('recommended',private)
            assert [r['id'] for r in recommended['rows']][:4]==[giveaway,urgent,best,lesser],recommended
            values=read('best-value',private)
            assert [r['id'] for r in values['rows']][:3]==[giveaway,best,lesser],values
            quote=next(r for r in values['rows'] if r['id']==best)
            assert quote['deal_market_value_meat']=='100000' and quote['deal_checked_at']
        home=json.loads(sql('select public.read_public_home_auctions();'))
        assert home['sections']['popular'][:3]==[giveaway,best,lesser],home['sections']
        cards=json.loads(sql('select public.read_home_cards();'))
        assert cards['sections']['popular'][:3]==[giveaway,best,lesser],cards['sections']
        assert set(cards['sections']['popular'])=={giveaway,best,lesser,urgent,tiny,stale,missing}
        assert cards['sections']['popular_buy']==[]
        assert cards['sections']['popular_direct']==cards['sections']['popular']
        # Build alternative composite inputs without changing funded rows or guards.
        def score(patch):
            return float(sql(f"select khub_bot.deal_score(jsonb_populate_record(a,{lit(json.dumps(patch))}::jsonb)) from public.auctions a where id='{best}';"))
        assert score({'min_bid_meat':90000})==0.1 # exact absolute threshold
        assert score({'min_bid_meat':90001})==0
        assert score({'current_bid':90000})==0 # includes next increment, not last bid
        assert score({'current_bid':80000,'instant_purchase_price':85000})==0.19 # next minimum is 81k
        assert score({'current_bid':89999,'instant_purchase_price':90000})==0.1 # buyout caps next bid
        assert score({'auction_kind':'buy','min_bid_meat':120000})==0.2
        assert score({'auction_kind':'buy','min_bid_meat':80000})==0
        bundle=[{'id':item_ids[0],'quantity':2},{'id':item_ids[1],'quantity':3}]
        assert score({'bundle_items':bundle,'quantity':1,'min_bid_meat':100000})==0.8
        bundle[1]['id']=item_ids[6]
        assert score({'bundle_items':bundle,'quantity':1,'min_bid_meat':100000})==0
        # Ranking occurs before pagination, including later-created low-value rows.
        sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,end_time,status) select '{owner}','Traffic Seller','No quote '||n,1,100,24,now()+interval '48 hours','active' from generate_series(1,30) n;")
        assert [r['id'] for r in read('recommended')['rows']][:4]==[giveaway,urgent,best,lesser]
        assert len(read('recommended')['rows'])==24
        # Category pools remain available even when the global selection is full.
        sql(f"insert into public.auctions(seller_id,seller_username,item,item_id,quantity,min_bid_meat,duration_hours,end_time,status,auction_kind,escrow_mode,seller_kol_id) select '{owner}','Traffic Seller','Buy fixture '||n,catalog_id,1,80000,24,now()+interval '24 hours','active','buy',true,48889801 from (select id as catalog_id,row_number() over(order by id) n from khub_bot.catalog where is_current and tradeable order by id limit 26) fixture;")
        cards=json.loads(sql('select public.read_home_cards();'))
        for tab in ['popular','new','ending']:
            assert len(cards['sections'][tab+'_buy'])==24,cards['sections']
            assert len(cards['sections'][tab])==24
            assert all(next(r for r in cards['rows'] if r['id']==ident)['auction_kind']=='buy' for ident in cards['sections'][tab+'_buy'])
        live=json.loads(sql("select public.read_public_auction_live_batch(array(select id from public.auctions));"))
        assert len(live['rows'])==63
        sql("select public.read_public_auction_live_batch(array_fill(gen_random_uuid(),array[336]));")
        sql("select public.read_public_auction_live_batch(array_fill(gen_random_uuid(),array[337]));",error='at most 336')
        # Private loyalty reads count only the caller's completed escrow Sell value.
        assert json.loads(sql("set role authenticated;select public.read_my_loyalty_progress();",owner))['completed_escrow_sales_meat']=='0'
        def completed_sale(seller, price, escrow=True, kind='sell', status='completed'):
            return sql(f"insert into public.auctions(seller_id,seller_username,seller_kol_id,item,item_id,quantity,min_bid_meat,duration_hours,end_time,status,auction_kind,escrow_mode,winner_id,final_price,seller_confirmed_at,buyer_confirmed_at,completed_at,finalized_at,settled_at) values('{seller}','Fixture seller',48889801,'Loyalty fixture',{item_ids[0]},1,100,24,now()+interval '24 hours','{status}','{kind}',{str(escrow).lower()},'{other}',{price},now(),now(),now(),now(),now()) returning id;")
        completed_sale(owner,500000000);completed_sale(owner,250000000)
        completed_sale(owner,2000000000,escrow=False)
        completed_sale(owner,1000000000,status='awaiting_trade')
        completed_sale(owner,5000000000,kind='buy')
        completed_sale(other,999000000)
        def loyalty(uid):
            return json.loads(sql("set role authenticated;select public.read_my_loyalty_progress();",uid))['completed_escrow_sales_meat']
        assert loyalty(owner)=='750000000'
        assert loyalty(other)=='999000000'
        sql("set role anon;select public.read_my_loyalty_progress();",error='permission denied')
        sql("select public.read_my_loyalty_progress();",error='Log in')
        sql("set role authenticated;select public.read_my_loyalty_progress();",restricted,error='restricted')
        print('PASS: loyalty totals isolate each authenticated seller and exclude Direct, Buy and unfinished sales')
        assert sql(financial_probe)==before_projection
        print('PASS: public/private Discover, Hidden Gems selection, thresholds, next bid/buyout, Buy offers, partial bundles, stale/missing estimates, pagination and unchanged financial definitions.')
    finally:
        if started:pg('-m','immediate','-w','stop')
