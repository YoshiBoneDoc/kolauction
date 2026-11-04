"""Public Sell listing projection parity and privacy.
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
            create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
            grant usage on schema public,auth to anon,authenticated,service_role;
            grant execute on function auth.uid() to anon,authenticated;
        ''')
        sql("create schema storage; create table storage.buckets(id text primary key,public boolean); insert into storage.buckets values('creator-photos',false); create table storage.objects(bucket_id text,name text);")
        migrations=sorted([*ROOT.glob('supabase/migrations/*.sql'),*ROOT.glob('supabase/migrations/queue/*.sql')],key=lambda p:p.name)
        assert len({p.name for p in migrations})==len(migrations)
        
        financial_probe="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','khub_bot') and p.prokind='f' and p.proname in ('bot_ingest_mail','bot_tick','bot_claim_delivery','bot_ack_delivery','finish_listing','finish_buy_order','bot_liabilities');"""
        for migration in migrations:
            if migration.name=='202611030170_public_sell_listing_projection.sql':
                before_projection=sql(financial_probe)
            if '192_memoize' not in migration.name: sql(migration.read_text())
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
        aid=sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,current_bid,duration_hours,end_time,status,giveaway_title) values('{owner}','Traffic Seller','Giveaway fixture',1,100,100,24,now()+interval '1 hour','active','Fixture') returning id;")
        sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{aid}','{other}','Traffic Buyer',100);")
        sql(f"update public.auctions set highest_bidder_id='{other}',highest_bidder_username='Traffic Buyer' where id='{aid}';")
        administrator=account(98004,3552305,'Administrator Fixture')
        # Repeated sellers are common during events. Include direct and escrow lots.
        sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,end_time,status,escrow_mode,seller_kol_id,item_id,item_escrowed_at) select '{owner}','Traffic Seller','Fixture '||i,1,100,24,now()+interval '2 days','active',i%2=0,48889801,2,now() from generate_series(1,120) i;")
        # Include closed Sell, Buy and bundle projections in card-context parity.
        sql(f"update public.auctions set status='cancelled',cancelled_at=now() where id in(select id from public.auctions where not escrow_mode and giveaway_title is null limit 3);")
        buy=sql(f"select public.create_buy_auction(2,10,100,24,'immediate');",owner)
        sql(f"update public.auctions set status='active',item_escrowed_at=now() where id='{buy}';")
        bundle=sql("select public.create_bundle_auction('[{\"id\":2,\"quantity\":1},{\"id\":364,\"quantity\":1}]'::jsonb,100,24,p_title=>'Read performance fixture');",owner)
        sql(f"update public.auctions set status='active',item_escrowed_at=now() where id='{bundle}';")
        ids=json.loads(sql("select jsonb_agg(id) from (select id from public.auctions order by (auction_kind='buy' or status='cancelled' or bundle_items<>'[]'::jsonb) desc,id limit 24) a;"))
        arr='array['+','.join(lit(i)+'::uuid' for i in ids)+']'
        # Freeze both implementations' time-dependent fields within one transaction.
        home=sql("select pg_get_functiondef('public.read_home_auctions_before_site_totals()'::regprocedure);")
        card=sql("select pg_get_functiondef('public.read_auction_card_context(uuid[])'::regprocedure);")
        sql(home.replace('FUNCTION public.read_home_auctions_before_site_totals()', 'FUNCTION public.baseline_home()'))
        sql(card.replace('FUNCTION public.read_auction_card_context(', 'FUNCTION public.baseline_card('))
        script=ROOT/'supabase/migrations/queue/202611030192_memoize_read_seller_restrictions.sql'
        if not script.exists(): script=ROOT/'supabase/migrations'/script.name
        sql(script.read_text())
        for viewer in [None,owner,other,restricted,administrator]:
            assert sql("select (public.baseline_home()-'server_time')=(public.read_home_auctions_before_site_totals()-'server_time');",viewer)=='t'
            if viewer:
                assert sql(f"select (public.baseline_card({arr})-'server_time')=(public.read_auction_card_context({arr})-'server_time');",viewer)=='t'
        # Measure paired warm runs in the same backend; report rather than assert wall time.
        query=f"""do $$declare t timestamptz; old_ms numeric; new_ms numeric;begin
          perform public.baseline_card({arr}); perform public.read_auction_card_context({arr});
          perform public.baseline_home(); perform public.read_home_auctions_before_site_totals();
          t:=clock_timestamp();for i in 1..15 loop perform public.baseline_card({arr});end loop;
          old_ms:=extract(epoch from clock_timestamp()-t)*1000;
          t:=clock_timestamp();for i in 1..15 loop perform public.read_auction_card_context({arr});end loop;
          new_ms:=extract(epoch from clock_timestamp()-t)*1000;
          raise notice 'Card 15 calls baseline=%ms optimized=%ms',old_ms,new_ms;
          t:=clock_timestamp();for i in 1..5 loop perform public.baseline_home();end loop;
          old_ms:=extract(epoch from clock_timestamp()-t)*1000;
          t:=clock_timestamp();for i in 1..5 loop perform public.read_home_auctions_before_site_totals();end loop;
          new_ms:=extract(epoch from clock_timestamp()-t)*1000;
          raise notice 'Home 5 calls baseline=%ms optimized=%ms',old_ms,new_ms;
        end;$$;"""
        run=subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',f"set request.jwt.claim.sub='{other}';"+query],capture_output=True,text=True)
        assert run.returncode==0,run.stderr
        print(run.stderr.strip())
        sql(f"insert into public.player_ignores(user_id,kol_player_id) values('{other}',48889801);")
        for viewer in [owner,other,restricted,administrator]:
            assert sql("select (public.baseline_home()-'server_time')=(public.read_home_auctions_before_site_totals()-'server_time');",viewer)=='t'
            assert sql(f"select (public.baseline_card({arr})-'server_time')=(public.read_auction_card_context({arr})-'server_time');",viewer)=='t'
        # Restrict a seller and test both readers again, preserving live ban checks.
        sql("insert into khub_bot.account_bans(kol_player_id,username,reason) values(48889801,'Traffic Seller','Performance parity fixture');")
        for viewer in [owner,other,restricted,administrator]:
            assert sql("select (public.baseline_home()-'server_time')=(public.read_home_auctions_before_site_totals()-'server_time');",viewer)=='t'
            assert sql(f"select (public.baseline_card({arr})-'server_time')=(public.read_auction_card_context({arr})-'server_time');",viewer)=='t'
        sql(f"select public.read_auction_card_context({arr});",error='Sign in')
        sql(f"select public.read_auction_card_context(array_fill('{aid}'::uuid,array[25]));",other,error='at most 24')
        sql("select public.read_auction_card_context(null);",other,error='at most 24')
        assert json.loads(sql("select public.read_auction_card_context('{}'::uuid[]);",other))['rows']==[]
        assert financial_before==sql(definitions),'Financial functions changed'
        print('PASS: Home/card result parity across anonymous/owner/bidder/restricted/admin and restricted seller; financial definitions unchanged')
    finally:
        if started:pg('-m','fast','-w','stop')
