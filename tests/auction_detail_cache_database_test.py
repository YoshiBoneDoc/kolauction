"""Auction detail cache migrations, narrow context privacy and unchanged financial RPCs.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/auction_detail_cache_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-detail-cache-',dir='/tmp') as folder:
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
        
        for migration in migrations:
            sql(migration.read_text())
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
        for viewer in [None,owner,other,restricted,administrator]:
            full=json.loads(sql(f"select public.read_auction_page(p_view=>'detail',p_id=>'{aid}');",viewer))
            narrow=json.loads(sql(f"select public.read_auction_detail_context(p_id=>'{aid}');",viewer))
            assert narrow['bids']==full['bids'],(viewer,narrow,full)
            row=narrow['rows'][0]
            for key in ['usernames_visible','seller_username','highest_bidder_id','highest_bidder_username','viewer_is_highest_bidder','bidding_restricted','escrow_timing_review']:
                assert row[key]==full['rows'][0][key],(key,row,full['rows'][0])
            assert not set(row)&{'item','image','current_bid','bid_count','end_time','quantity'}
        public=json.loads(sql(f"select public.read_public_auction_detail_state('{aid}');"))
        assert public['rows'][0]['bid_count']==1
        assert 'seller_id' not in public['rows'][0]
        body=sql("select prosrc from pg_proc where oid='public.read_auction_detail_context(text,uuid,text,text,text,integer)'::regprocedure;")
        assert 'khub_bot.public_auction(' not in body
        assert 'select count(*) from public.bids b where b.auction_id=a.id' not in body
        sql(f"update public.auctions set status='awaiting_trade',winner_username='Traffic Buyer',final_price=100,finalized_at=now(),winner_id='{other}' where id='{aid}';")
        assert json.loads(sql(f"select public.read_auction_detail_context(p_id=>'{aid}');"))['rows'][0]['_detail_full_required']
        assert sql(definitions)==financial_before
        print('Detail migrations applied to PostgreSQL; narrow history/privacy, public state and unchanged financial functions passed.')
    finally:
        if started:pg('-m','immediate','-w','stop')
