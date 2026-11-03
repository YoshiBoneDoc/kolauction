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
        aid=sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,current_bid,duration_hours,end_time,status,giveaway_title) values('{owner}','Traffic Seller','Giveaway fixture',1,100,100,24,now()+interval '1 hour','active','Fixture') returning id;")
        sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{aid}','{other}','Traffic Buyer',100);")
        sql(f"update public.auctions set highest_bidder_id='{other}',highest_bidder_username='Traffic Buyer' where id='{aid}';")
        administrator=account(98004,3552305,'Administrator Fixture')
        # The public Sell fast path must preserve every cache-visible value
        # from the installed private projection without exporting identities.
        import re
        protocol=(ROOT/'workers/public-auction-cache/protocol.js').read_text()
        public_fields=re.findall(r"'([^']+)'",protocol.split('export const PUBLIC_FIELDS = [',1)[1].split('];',1)[0])+['bundle_items']
        for viewer in [None,owner,other,restricted,administrator]:
            pair=json.loads(sql(f"select jsonb_build_object('old',khub_bot.public_auction(a,1,'Bidder 1',null),'new',khub_bot.public_listing_projection(a,1,'Bidder 1',null)) from public.auctions a where id='{aid}';",viewer))
            for key in public_fields:
                assert pair['old'].get(key)==pair['new'].get(key),(key,pair)
            assert not set(pair['new']) & {'seller_id','seller_username','highest_bidder_id','winner_id','settlement_contacts','balance_meat','fulfillments','my_reservation'}
        assert sql(f"select khub_bot.public_home_listing_projection(a,1,null,null)=khub_bot.public_auction(a,1,null,null) from public.auctions a where id='{aid}';",owner)=='t'
        listing_body=sql("select prosrc from pg_proc where oid='khub_bot.public_listing_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text,text)'::regprocedure;")
        assert 'khub_bot.public_listing_projection(a,' in listing_body
        assert 'khub_bot.public_auction(a,' not in listing_body
        # Exercise completed, escrow and bundle-shaped Sell rows as composite
        # inputs without changing financial rows or bypassing auction triggers.
        for variant in ["jsonb_build_object('status','completed','winner_id','"+other+"')",
                        "jsonb_build_object('escrow_mode',true)",
                        "jsonb_build_object('bundle_items',jsonb_build_array(jsonb_build_object('id',1,'quantity',2,'name','Fixture A'),jsonb_build_object('id',2,'quantity',3,'name','Fixture B')))"]:
            pair=json.loads(sql(f"with fixture as (select jsonb_populate_record(a,{variant}) as lot from public.auctions a where id='{aid}') select jsonb_build_object('old',khub_bot.public_auction(lot,1,'Bidder 1',null),'new',khub_bot.public_listing_projection(lot,1,'Bidder 1',null)) from fixture;"))
            for key in public_fields:
                assert pair['old'].get(key)==pair['new'].get(key),(key,pair)
        assert sql(f"select khub_bot.public_listing_projection(a,1,null,null)=khub_bot.public_auction(a,1,null,null) from (select (jsonb_populate_record(a,jsonb_build_object('auction_kind','buy'))).* from public.auctions a where id='{aid}') a;")=='t'
        for query in ["select public.read_public_home_auctions();",
                      "select public.read_public_auction_page('browse',null,'','active','ending',1,'all','all',null,null);"]:
            payload=json.loads(sql(query))
            row=next(row for row in payload['rows'] if row['id']==aid)
            assert row['current_bid']==100
            assert not set(row)&{'seller_id','seller_username','highest_bidder_id','winner_id','settlement_contacts'}
        featured=json.loads(sql('select public.read_featured_giveaway();'))
        assert featured['id']==aid and featured['giveaway_title']=='Fixture'
        assert not set(featured)&{'seller_id','seller_username','highest_bidder_id','winner_id','settlement_contacts'}
        assert sql(f"select public.read_featured_giveaway()=khub_bot.public_auction(a,1,null,null) from public.auctions a where id='{aid}';",owner)=='t'
        batch=json.loads(sql(f"select public.read_public_auction_live_batch(array['{aid}'::uuid]);"))
        assert batch['rows'][0]['current_bid']==100 and batch['rows'][0]['bid_count']==1
        assert not set(batch['rows'][0]) & {'seller_id','seller_username','highest_bidder_id','winner_id','balance_meat','my_reservation','fulfillments','item','image'}
        assert json.loads(sql("select public.read_public_auction_live_batch('{}'::uuid[]);"))['rows']==[]
        sql("select public.read_public_auction_live_batch(array_fill(gen_random_uuid(),array[121]));",error='at most 120')
        pending=sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,current_bid,duration_hours,end_time,status,escrow_mode,item_id,seller_kol_id) values('{owner}','Traffic Seller','Unpublished fixture',1,100,0,24,now()+interval '1 hour','pending_escrow',true,1,48889801) returning id;")
        assert json.loads(sql(f"select public.read_public_auction_live_batch(array['{pending}'::uuid]);"))['rows']==[]
        # Public role may call only the narrow RPC, not the private notification
        # sender. Financial mutation definitions remain byte-for-byte identical.
        assert sql("select has_function_privilege('anon','public.read_public_auction_live_batch(uuid[])','execute');")=='t'
        assert sql("select has_function_privilege('anon','khub_bot.send_public_cache_invalidation(uuid)','execute');")=='f'
        sql("""create schema if not exists net;
            create table public.fixture_notifications(body jsonb);
            create or replace function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer)
            returns bigint language plpgsql as $$begin insert into public.fixture_notifications values(body);return 1;end;$$;
            insert into khub_bot.public_cache_webhook_config values(true,'https://fixture.test/api/public-auctions/invalidate',repeat('a',64));""")
        before_revision=int(sql('select revision from khub_bot.public_cache_revision where id;'))
        sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{aid}','{other}','Traffic Buyer',101);")
        assert int(sql('select revision from khub_bot.public_cache_revision where id;'))==before_revision+1
        import hmac,hashlib
        notification=json.loads(sql('select body from public.fixture_notifications limit 1;'))
        assert set(notification)=={'revision','auction_id','signature'} and notification['auction_id']==aid
        expected=hmac.new(('a'*64).encode(),f"khub-public-auctions:v2:{notification['revision']}:{aid}".encode(),hashlib.sha256).hexdigest()
        assert notification['signature']==expected
        sql('select khub_bot.send_public_cache_invalidation();')
        legacy=json.loads(sql("select body from public.fixture_notifications where not body ? 'auction_id' limit 1;"))
        assert legacy['signature']==hmac.new(('a'*64).encode(),f"khub-public-auctions:v1:{legacy['revision']}".encode(),hashlib.sha256).hexdigest()
        assert 'new.auction_id' in sql("select prosrc from pg_proc where oid='khub_bot.invalidate_public_cache_after_bid()'::regprocedure;")
        print('PASS: live batch limits/privacy, unpublished exclusion, notification ACL and accepted-bid revision increment.')
        for function in ['public_auction','public_listing_projection']:
            # Construct 24 projected rows; compare execution time only, no
            # performance threshold or production capacity inference.
            timing=json.loads(sql(f"explain (analyze,format json) select jsonb_agg(khub_bot.{function}(a,1,null,null)) from public.auctions a cross join generate_series(1,24) n where a.id='{aid}';"))
            print(function,'local 24-card execution ms:',timing[0]['Execution Time'])
        print('PASS: public Sell cache-field parity for anonymous, owner, bidder, banned viewer and administrator; no private fields.')
        assert sql(definitions)==financial_before
    finally:
        if started:pg('-m','immediate','-w','stop')
