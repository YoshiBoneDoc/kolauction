"""Exercise globally ranked hot-auction badges against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/hot_auctions_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-hot-',dir='/tmp') as folder:
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
        hot_migration=next(path for path in migrations if path.name=='202610220072_hot_auction_cards.sql')
        for migration in migrations:
            if migration!=hot_migration and not migration.name.startswith('202610220073_'): sql(migration.read_text())
        catalog_path=ROOT/'src/data/items.json'
        if not catalog_path.exists(): catalog_path=ROOT/'catalog/items.json'
        catalog=json.loads(catalog_path.read_text())
        # Website bundle contains tradeable items only. Add explicitly synthetic
        # non-tradeable rows to satisfy the full-snapshot importer in this test.
        catalog += [{'id':1900000+i,'name':f'Untradeable fixture {i}','image':'test.gif','tradeable':False}
            for i in range(max(0,10000-len(catalog)))]
        sql('select public.bot_replace_item_catalog('+lit(json.dumps(catalog))+",now(),repeat('a',64));")
        def account(mid,player,name):
            payload={'id':str(mid),'sender_id':player,'sender_name':name,'received_at':'2026-10-21T12:00:00Z',
                'command':{'type':'register'},'meat':0,'items':[],'raw':{'id':str(mid),'fromid':str(player),'fromname':name,'type':'normal','message':'REGISTER'}}
            job=json.loads(sql('select public.bot_prepare_account_mail('+lit(json.dumps(payload))+",'Kh9!FixturePassword');"))
            metadata=lit(json.dumps({'khub_account_job':str(mid)}))
            sql(f"insert into auth.users(id,email,encrypted_password,raw_app_meta_data,raw_user_meta_data) values('{job['user_id']}',{lit(job['login_email'])},'fixture-hash',{metadata},'{{}}');")
            sql(f"select public.bot_finish_account_job('{mid}');")
            sql(f"insert into auth.sessions values('{uuid4()}','{job['user_id']}');")
            return job['user_id'],payload

        seller_a,_=account(89101,48889101,'Hot Seller A')
        seller_b,_=account(89102,48889102,'Hot Seller B')
        buyer,_=account(89103,48889103,'Hot Buyer')
        banned,_=account(89104,48889104,'Hot Restricted Seller')
        def seed(index,count,status='active',expired=False,owner=seller_a,escrow=False):
            ident=str(uuid4())
            confirms="clock_timestamp()" if status=='completed' else 'null'
            end="clock_timestamp()-interval '1 second'" if expired else "clock_timestamp()+interval '1 day'"
            sql(f"""insert into public.auctions(id,seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,
                item_id,seller_kol_id,escrow_mode,created_at,end_time,current_bid,highest_bidder_id,highest_bidder_username,
                status,seller_confirmed_at,buyer_confirmed_at,completed_at)
                values('{ident}','{owner}','Fixture seller','HotFixture {index}',1,1000,24,
                    2,48889104,{'true' if escrow else 'false'},clock_timestamp()-interval '2 days'+interval '{index} minutes',
                    {end},{count*1000},{lit(buyer) if count else 'null'},'Fixture bidder','{status}',{confirms},{confirms},{confirms});
                insert into public.bids(auction_id,bidder_id,bidder_username,amount)
                    select '{ident}','{buyer}','Fixture bidder',n*1000 from generate_series(1,{count}) n;""")
            return ident
        def read(view='browse',ident=None,search='',status='all',page=1,role='anon',uid=None):
            return json.loads(sql(f"set role {role}; select public.read_auction_page({lit(view)},{lit(ident) if ident else 'null'},{lit(search)},{lit(status)},'newest',{page});",uid))
        def snapshot():
            return sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d),'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p));")
        live=[seed(i,31-i,owner=seller_a if i%2==0 else seller_b) for i in range(31)]
        excluded=[seed(100+i,100+i,status=status) for i,status in enumerate(['completed','on_hold','settling','awaiting_trade','cancelled','voided'])]
        excluded.append(seed(110,200,expired=True))
        excluded.append(seed(111,200,status='pending_escrow',escrow=True))
        restricted=seed(112,250,owner=banned,escrow=True)
        sql("insert into khub_bot.account_bans(kol_player_id,username,reason) values(48889104,'Hot Restricted Seller','Isolated test restriction');")
        excluded.append(restricted)
        before=snapshot()
        prior=read()
        sql(hot_migration.read_text())
        assert snapshot()==before
        after=read()
        for entry in after['rows']: del entry['is_hot']
        assert after==prior
        hot=lambda:set(json.loads(sql("select coalesce(jsonb_agg(id),'[]'::jsonb) from khub_bot.hot_auction_ids() id;")))
        assert hot()==set(live[:4]),hot()
        assert not hot().intersection(excluded)
        print('PASS: ceil(10%) ranks all 31 live auctions globally; completed, held, expired, canceled, pending, settling and restricted-seller listings are excluded; migration leaves records and prior privacy projection unchanged')
        rows=read(status='active')['rows']+read(status='active',page=2)['rows']
        assert {r['id'] for r in rows if r['is_hot']}==set(live[:4])
        assert not any(r['is_hot'] for r in read(status='active')['rows']) # Hot listings are on page two.
        filtered=read(search='HotFixture 10',status='active')['rows']
        assert len(filtered)==1 and not filtered[0]['is_hot']
        own=read('seller',seller_a,status='active',role='authenticated',uid=seller_a)['rows']
        assert {r['id'] for r in own if r['is_hot']}=={live[0],live[2]}
        detail=read('detail',live[0])
        assert detail['rows'][0]['is_hot'] is True
        assert detail['rows'][0]['seller_username']=='Seller'
        assert detail['rows'][0]['highest_bidder_id'] is None
        assert all(b['bidder_id'] is None and b['bidder_username'].startswith('Bidder ') for b in detail['bids'])
        for role in ['anon','authenticated','service_role']:
            sql(f'set role {role}; select * from khub_bot.hot_auction_ids();',error='permission denied')
        print('PASS: badges are global across pagination, searches, My Auctions/seller filters and details; guest identities remain masked and the helper stays private')
        # Accepted bid totals, not current price, control popularity. Changes are
        # visible on the next ordinary read, without a job/cache refresh.
        cold=live[-1]
        sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) select '{cold}','{buyer}','Fixture bidder',n*1000 from generate_series(100,150) n;")
        assert hot()=={cold,*live[:3]}
        sql(f"update public.auctions set end_time=clock_timestamp()-interval '1 second' where id='{live[0]}';")
        assert hot()=={cold,*live[1:3]} # 30 remaining live auctions means three slots.
        print('PASS: new accepted bids and deadline expiry immediately update ranking; prices do not determine eligibility')
        sql("update public.auctions set status='cancelled' where status='active';")
        ties=[seed(200+i,1) for i in range(10)]
        assert hot()=={ties[0]} # Same totals prefer the oldest listing.
        extra=seed(220,1)
        assert hot()=={ties[0],ties[1]} # 11 active rounds up to two.
        sql("update public.auctions set status='cancelled' where status='active';")
        zeros=[seed(230+i,0) for i in range(11)]
        assert hot()==set()
        positive=seed(250,1)
        assert hot()=={positive}
        sql("update public.auctions set status='cancelled' where status='active';")
        assert hot()==set()
        print('PASS: deterministic ties, 10/11 bracket boundary, zero-bid pools and no-active-auction cases')
        browse_migration=next(path for path in migrations if path.name.startswith('202610220073_'))
        sql(browse_migration.read_text())
        # A complete mixed pool exercises global sorting/filtering before pages.
        lots=[seed(300+i,i%7,escrow=i%2==0,owner=seller_a if i%3 else seller_b) for i in range(55)]
        for i,ident in enumerate(lots):
            sql(f"update public.bids set created_at='2026-10-20T00:00:00Z'::timestamptz+interval '{i} minutes' where auction_id='{ident}';")
        def browse(sort='ending',trade='all',page=1,search='HotFixture 3',owner=None):
            view='seller' if owner else 'browse'
            return json.loads(sql(f"set role anon; select public.read_auction_page('{view}',{lit(owner) if owner else 'null'},{lit(search)},'active',{lit(sort)},{page},{lit(trade)});"))
        for sort in ['ending','newest','price-asc','price-desc','bids-asc','bids-desc','activity']:
            for trade in ['all','escrow','direct']:
                result=browse(sort,trade)
                rows=result['rows']+browse(sort,trade,2)['rows']+browse(sort,trade,3)['rows']
                expected=[(i,ident) for i,ident in enumerate(lots) if trade=='all' or (i%2==0)==(trade=='escrow')]
                # Fixture indices 300..354 all match the search.
                assert result['total']==len(expected),(sort,trade,result['total'])
                assert len(rows)==len(expected) and len({r['id'] for r in rows})==len(expected)
                if sort=='activity': expected.sort(key=lambda x: (x[0]%7>0,x[0] if x[0]%7>0 else 0,x[0]),reverse=True)
                elif sort=='price-asc': expected.sort(key=lambda x:(max(1,x[0]%7),-x[0]))
                elif sort=='bids-asc': expected.sort(key=lambda x:(x[0]%7,-x[0]))
                elif sort=='price-desc': expected.sort(key=lambda x:(max(1,x[0]%7),x[0]),reverse=True)
                elif sort=='bids-desc': expected.sort(key=lambda x:(x[0]%7,x[0]),reverse=True)
                elif sort=='newest': expected.sort(reverse=True)
                # Deadline timestamps follow insertion order.
                elif sort=='ending': expected.sort()
                assert [r['id'] for r in rows]==[ident for _,ident in expected],(sort,trade)
                assert all(r['seller_username']=='Seller' and r['highest_bidder_id'] is None for r in rows)
                assert all(('latest_bid_at' in r) for r in rows)
        own=browse('activity','escrow',owner=seller_a)
        assert own['total']==len([i for i in range(55) if i%2==0 and i%3])
        assert browse(trade='none')['total']==0
        assert browse(trade='escrow',search='HotFixture 302')['total']==1
        print('PASS: all seven sort orders and independent trade filters operate globally before pagination; latest valid bids, unbid-last behavior, repeated bidders, search, seller filtering and guest privacy are preserved')
    finally:
        if started: pg('-m','fast','-w','stop')
