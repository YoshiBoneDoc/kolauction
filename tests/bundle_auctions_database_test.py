"""Bundle auction financial safety against ALL local SQL migrations.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/bundle_auctions_database_test.py
"""
import json
import hashlib
import hmac
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-bot-only-expiration-',dir='/tmp') as folder:
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
            create schema storage;
            create table storage.buckets(id text primary key,public boolean);
            insert into storage.buckets values('creator-photos',false);
            create table storage.objects(bucket_id text,name text);
            alter table storage.objects enable row level security;
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
            if migration.name.startswith('202610290144_'):
                upgrade_transfer=str(uuid4());upgrade_attempt=str(uuid4())
                sql("insert into khub_bot.closet_transfers(id,dedupe_key,source,meat,state,attempt,before_state) values('"+upgrade_transfer+"','soft-upgrade-fixture','sale_fee',700,'unknown','"+upgrade_attempt+"','{\"inventory\":\"9000\",\"closet\":\"1000\"}');")
                sql("insert into khub_bot.closet_recovery_attempts(attempt,transfer_id,legacy,before_state,state,deadline,reason) values('"+upgrade_attempt+"','"+upgrade_transfer+"',true,'{\"inventory\":\"9000\",\"closet\":\"1000\"}','review',clock_timestamp()-interval '1 hour','Historical attempt has no durable submission fence; elapsed time cannot authorize replay.');")
            sql(migration.read_text())
            if migration.name.startswith('202610290144_'):
                assert sql("select state='watching' and soft_retry_window_started_at is not null and deadline>clock_timestamp() from khub_bot.closet_recovery_attempts where attempt='"+upgrade_attempt+"';")=='t'
                assert sql("select state from khub_bot.closet_transfers where id='"+upgrade_transfer+"';")=='unknown'
                assert sql("select count(*) from khub_bot.closet_soft_retries where transfer_id='"+upgrade_transfer+"';")=='0'
                sql("select public.bot_reconcile_closet_transfer('"+upgrade_transfer+"',true,'local upgrade fixture cleanup');")
                print('PASS: upgrade re-observes an old unchanged legacy review without submitting or immediately approving a retry')
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

        from datetime import datetime,timezone
        seller,_=account(98001,48889601,'Bundle Seller')
        buyer,_=account(98002,48889602,'Bundle Buyer')
        other,_=account(98003,48889603,'Bundle Other')
        sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp();")
        def call(query,uid=seller,error=None):return sql('set role authenticated;'+query,uid,error)
        parts=[{'id':2,'quantity':3},{'id':364,'quantity':5}]
        def create(escrow=True,buyout='null',items=None):
            return call('select public.create_bundle_auction('+lit(json.dumps(parts if items is None else items))+f",100,24,{buyout},{str(escrow).lower()});")
        ids=iter(range(98100,99000))
        def ingest(aid,kind,meat=0,items=None,actor=48889601,reservation=None):
            mid=str(next(ids))
            epoch=sql('select floor(extract(epoch from clock_timestamp()))::bigint;')
            received=sql(f'select to_timestamp({epoch});')
            payload={'id':mid,'sender_id':actor,'sender_name':'Bundle fixture','received_at':received,
                'command':{'type':kind,'auction_id':aid},'meat':meat,'items':items or [],
                'raw':{'id':mid,'fromid':str(actor),'fromname':'Bundle fixture','type':'normal','message':kind.upper()+' '+aid,'azunixtime':epoch}}
            if reservation: payload['command']['reservation_id']=reservation
            if kind in ('bid','buy','fill'):
                scan=json.loads(sql('select public.bot_begin_inbox_scan();'))['id']
                sql(f"select public.bot_stage_inbox_scan('{scan}',"+lit(json.dumps([payload]))+');')
            query='set role service_role;select public.bot_ingest_mail('+lit(json.dumps(payload))+');'
            return mid,sql(query),query
        def row(aid):return json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{aid}';"))
        def quantities(where):return json.loads(sql("select coalesce(jsonb_object_agg(item_id,q),'{}') from (select item_id,sum(quantity)::text q from khub_bot.deliveries where item_id is not null and "+where+' group by item_id)s;'))
        def expire(aid):
            sql(f"update public.auctions set created_at=clock_timestamp()-interval '2 days',end_time=clock_timestamp()-interval '120 seconds',escrow_buyout_received_at=case when escrow_buyout_received_at is not null then clock_timestamp()-interval '120 seconds' else null end,item_escrowed_at=case when escrow_mode then clock_timestamp()-interval '1 day' else null end where id='{aid}';")
            scan=json.loads(sql('select public.bot_begin_inbox_scan();'))['id']
            sql(f"select public.bot_stage_inbox_scan('{scan}','[]');select public.bot_finish_inbox_scan('{scan}');select public.bot_tick();")
        for invalid in [[],[parts[0]],[parts[0],parts[0]],[{'id':2,'quantity':0},parts[1]],[{'id':2,'quantity':5000000001},parts[1]]]:
            call('select public.create_bundle_auction('+lit(json.dumps(invalid)) + ',100,24);',error='bundle')
        call('select public.create_bundle_auction('+lit(json.dumps([{'id':1900000,'quantity':1},parts[1]]))+',100,24);',error='catalog')
        sql('set role anon;select public.create_bundle_auction('+lit(json.dumps(parts))+',100,24);',error='permission denied')
        print('PASS: invalid, duplicate, ineligible, out-of-range and anonymous bundles rejected')
        for title in ['x'*101, 'bad\nname', '<b>name</b>', 'bad\u202ename']:
            call('select public.create_bundle_auction('+lit(json.dumps(parts))+',100,24,p_title=>'+lit(title)+');',error='Bundle title')
        lot=call('select public.create_bundle_auction('+lit(json.dumps(parts))+",100,24,5000,p_title=>'  Friends & Collectibles  ',p_image_item_id=>364);")
        assert row(lot)['item']=='Bundle: Friends & Collectibles'
        assert row(lot)['status']=='pending_escrow'
        assert json.loads(call(f"select public.read_auction_card_context(array['{lot}']::uuid[]);"))['rows']==[]
        sql(f"set role anon;select public.read_auction_card_context(array['{lot}']::uuid[]);",error='permission denied')
        call(f"select public.read_auction_card_context(array_fill('{lot}'::uuid,array[25]));",error='at most 24')
        sql(f"update public.auctions set item='changed' where id='{lot}';",error='cannot change')
        assert row(lot)['image']==row(lot)['bundle_items'][1]['image']
        call('select public.create_bundle_auction('+lit(json.dumps(parts))+',100,24,p_image_item_id=>1);',error='cover image')
        print('PASS: optional title validated, trimmed and immutable; cover must be a real component')
        # Default cover uses highest UNIT quote, not component ID or lot quantity.
        sql("insert into khub_bot.market_prices(item_id,price_meat,available,observed_at,checked_at) values(2,100,true,clock_timestamp(),clock_timestamp()),(364,200,true,clock_timestamp(),clock_timestamp()) on conflict(item_id) do update set price_meat=excluded.price_meat,available=true;")
        auto_cover=create(items=[{'id':2,'quantity':1000},{'id':364,'quantity':1}])
        assert row(auto_cover)['image']==row(auto_cover)['bundle_items'][1]['image']
        explicit_cover=call('select public.create_bundle_auction('+lit(json.dumps(parts))+",100,24,p_image_item_id=>2);")
        assert row(explicit_cover)['image']==row(explicit_cover)['bundle_items'][0]['image']
        sql("delete from khub_bot.market_prices where item_id in (2,364);")
        fallback_cover=create()
        assert row(fallback_cover)['image']==row(fallback_cover)['bundle_items'][0]['image']
        print('PASS: highest-priced component is default cover, explicit choice wins, unavailable quotes have stable fallback')

        frozen=row(lot)['bundle_items'];assert len(frozen)==2 and row(lot)['quantity']==1
        for wrong,meat,actor in [([{'id':2,'quantity':1}],0,48889601),([parts[0]],0,48889601),([*parts,{'id':1,'quantity':1}],0,48889601),(parts,1,48889601),(parts,0,48889602)]:
            mid,result,_=ingest(lot,'list',meat,wrong,actor)
            assert result!='accepted' and row(lot)['status']=='pending_escrow'
            assert quantities(f"receipt_id='{mid}'")=={str(p['id']):str(p['quantity']) for p in wrong}
        print('PASS: partial/extra/Meat/wrong-seller deposits fully refunded; no partial activation')
        baseline=json.loads(sql('select public.bot_liabilities();'))['items']
        mid,result,replay=ingest(lot,'list',items=parts);assert result=='accepted',result
        assert row(lot)['status']=='active'
        listing_count=sql('select count(*) from public.auctions;')
        for escrow in ['true','false']:
            call('select public.create_bundle_auction('+lit(json.dumps(parts))+f",100,24,p_escrow_mode=>{escrow},p_title=>'  Friends & Collectibles  ');",error='live bundle auction already uses this exact name')
        assert sql('select count(*) from public.auctions;')==listing_count
        case_distinct=call('select public.create_bundle_auction('+lit(json.dumps(parts))+",100,24,p_title=>'friends & collectibles');")
        assert row(case_distinct)['status']=='pending_escrow'
        print('PASS: exact live custom bundle names rejected before creating records; trimming and case-sensitive matches respected')
        liabilities=json.loads(sql('select public.bot_liabilities();'))['items']
        for p in parts:assert int(liabilities[str(p['id'])])-int(baseline.get(str(p['id']),0))==p['quantity']
        before=sql('select count(*) from khub_bot.deliveries;');sql(replay);assert sql('select count(*) from khub_bot.deliveries;')==before
        sql(f"update public.auctions set bundle_items='[]' where id='{lot}';",error='cannot change')
        print('PASS: complete deposit activates once; every component protected; contents immutable')
        details=json.loads(call(f"select public.read_auction_page('detail','{lot}');",buyer))['rows'][0]
        assert details['is_bundle'] and details['bundle_items']==frozen
        for view in ['browse','seller','profile']:
            target=lit(seller) if view=='seller' else 'null'
            page=json.loads(call(f"select public.read_auction_page('{view}',{target},'','all','ending',1);"))
            assert any(r['id']==lot and r['is_bundle'] for r in page['rows'])
        page=json.loads(call(f"select public.read_auction_page('seller','{seller}',{lit(frozen[1]['name'])},'all','ending',1);",buyer))
        assert any(r['id']==lot for r in page['rows'])
        home=json.loads(call('select public.read_home_auctions();',buyer));assert home['privacy_version']==1
        context=json.loads(call(f"select public.read_auction_card_context(array['{lot}','{lot}']::uuid[]);",buyer))
        assert len(context['rows'])==1 and context['rows'][0]['seller_id']==seller
        assert context['rows'][0]['seller_username']=='Bundle Seller'
        assert context['rows'][0]['bundle_items']==frozen
        assert 'bid_count' not in context['rows'][0]
        sql("insert into khub_bot.market_prices(item_id,price_meat,observed_at,checked_at,available) values(2,1000,clock_timestamp(),clock_timestamp(),true),(364,2000,clock_timestamp(),clock_timestamp(),true) on conflict(item_id) do update set price_meat=excluded.price_meat,available=true;")
        assert sql(f"select khub_bot.lot_market_value(a) from public.auctions a where id='{lot}';")=='13000'
        print('PASS: public/private/home projections, component search and full-lot market valuation')
        # The cache hook is optional and failures cannot reject accepted funds.
        cache_secret='ab'*32
        sql("insert into khub_bot.public_cache_webhook_config(id,endpoint,signing_secret) values(true,'https://cache.example/api/public-auctions/invalidate',"+lit(cache_secret)+');')
        for role in ['anon','authenticated','service_role']:
            sql('set role '+role+';select * from khub_bot.public_cache_webhook_config;',error='permission denied')
            sql('set role '+role+';select khub_bot.send_public_cache_invalidation();',error='permission denied')
        cache_revision=int(sql('select revision from khub_bot.public_cache_revision;'))
        first_mid,first_result,first_replay=ingest(lot,'bid',200,actor=48889603)
        assert first_result=='accepted' and row(lot)['current_bid']==200
        assert int(sql('select revision from khub_bot.public_cache_revision;'))==cache_revision+1
        assert int(sql('select enqueue_failures from khub_bot.public_cache_revision;'))==1
        sql(first_replay)
        assert int(sql('select revision from khub_bot.public_cache_revision;'))==cache_revision+1
        # Offline pg_net boundary: enqueue is transactional, without any real HTTP.
        sql('''create schema net;
            create table net.fixture_requests(id bigserial primary key,url text,body jsonb,headers jsonb,timeout_milliseconds integer);
            create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) returns bigint
            language sql as $$insert into net.fixture_requests(url,body,headers,timeout_milliseconds)
                values(url,body,headers,timeout_milliseconds) returning id;$$;
            select khub_bot.send_public_cache_invalidation();''')
        hook=json.loads(sql('select body from net.fixture_requests order by id desc limit 1;'))
        assert set(hook)=={'revision','signature'}
        assert hook['revision']==str(cache_revision+1)
        assert hook['signature']==hmac.new(cache_secret.encode(),('khub-public-auctions:v1:'+hook['revision']).encode(),hashlib.sha256).hexdigest()
        assert cache_secret not in sql('select to_jsonb(r) from net.fixture_requests r order by id desc limit 1;')
        print('PASS: bot accepted bids invalidate once; replays do not; hook failure preserves accepted funds; only signed revision queued')
        own_context=json.loads(call(f"select public.read_auction_card_context(array['{lot}']::uuid[]);",other))['rows'][0]
        other_context=json.loads(call(f"select public.read_auction_card_context(array['{lot}']::uuid[]);",buyer))['rows'][0]
        assert own_context['highest_bidder_id']==other
        assert other_context['highest_bidder_id'] is None
        assert other_context['highest_bidder_username'].startswith('Bidder ')
        print('PASS: private card context rejects anonymous/unbounded/draft reads; preserves names and viewer-specific bidder privacy')
        mid,result,replay=ingest(lot,'bid',6000,actor=48889602);assert result=='accepted',result
        assert row(lot)['status']=='active' and row(lot)['escrow_buyout_received_at'] is not None
        expire(lot)  # Simulate elapsed grace, then complete a new scan; never bypass authorization.
        assert row(lot)['status']=='settling' and row(lot)['final_price']==5000
        assert quantities(f"auction_id='{lot}' and kind='sale_item'")=={'2':'3','364':'5'}
        assert sql(f"select sum(meat) from khub_bot.deliveries where auction_id='{lot}' and kind='sale_meat';")=='4750'
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{mid}' and dedupe_key like 'excess:%';")=='1000'
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{mid}' and dedupe_key like 'outbid:%' and recipient_id=48889603;")=='200'
        before=sql('select count(*) from khub_bot.deliveries;');sql(replay);sql('select public.bot_tick();');assert sql('select count(*) from khub_bot.deliveries;')==before
        messages=json.loads(sql(f"select jsonb_agg(khub_bot.friendly_message(d)) from khub_bot.deliveries d where auction_id='{lot}' and kind='sale_item';"))
        assert all('Attached in this message:' in m and 'separately tracked' in m for m in messages)
        deliveries=json.loads(sql(f"select jsonb_agg(id) from khub_bot.deliveries where auction_id='{lot}' and state='pending';"))
        held=sql(f"select id from khub_bot.deliveries where auction_id='{lot}' and kind='sale_item' limit 1;")
        deliveries.remove(held);sql(f"update khub_bot.deliveries set state='unknown' where id='{held}';")
        for delivery in deliveries:
            attempt=sql(f"update khub_bot.deliveries set state='sending',attempt=gen_random_uuid() where id='{delivery}' returning attempt;")
            sql(f"select public.bot_ack_delivery('{delivery}','{attempt}',true,'Disposable local test verified receipt.');")
        assert row(lot)['status']=='settling'
        sql(f"select public.bot_reconcile_delivery('{held}',true,'Disposable local test verified recipient and exact assets.');")
        assert row(lot)['status']=='completed'
        reused=call('select public.create_bundle_auction('+lit(json.dumps(parts))+",100,24,p_title=>'Friends & Collectibles');")
        assert row(reused)['id']!=lot and row(reused)['item']==row(lot)['item']
        # Two concurrent Direct creations must not both pass a live-name check.
        query="set request.jwt.claim.sub="+lit(seller)+";set role authenticated;select public.create_bundle_auction("+lit(json.dumps(parts))+",100,24,p_escrow_mode=>false,p_title=>'Concurrent custom title');"
        processes=[subprocess.Popen([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',query],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
        outputs=[p.communicate(timeout=15) for p in processes]
        assert sorted(p.returncode for p in processes)==[0,1],outputs
        assert any('live bundle auction already uses this exact name' in err for out,err in outputs)
        print('PASS: historical bundle names reusable; concurrent live Direct title creation permits exactly one auction')
        assert sql(f"select available from khub_bot.auction_market_prices where auction_id='{lot}';")=='f'
        seller_stats=json.loads(call(f"select public.read_auction_page('seller','{seller}','','all','ending',1);",buyer))['seller']['stats']
        assert int(seller_stats['escrow_units'])==8 and int(seller_stats['escrow_sales'])==1
        print('PASS: whole-bundle buyout, exact fee/payout/excess, no duplicate sends; unresolved component prevents completion')
        for outcome in ['cancel','unsold']:
            aid=create();assert ingest(aid,'list',items=parts)[1]=='accepted'
            if outcome=='cancel':call(f"select public.cancel_auction('{aid}');")
            else:expire(aid)
            assert quantities(f"auction_id='{aid}' and kind='return_item'")=={'2':'3','364':'5'}
        direct=create(False);call(f"select public.place_bid('{direct}',200);",buyer);expire(direct)
        assert row(direct)['status']=='awaiting_trade' and row(direct)['bundle_items']==frozen
        timed=create();assert ingest(timed,'list',items=parts)[1]=='accepted'
        assert ingest(timed,'bid',200,actor=48889602)[1]=='accepted';expire(timed)
        assert row(timed)['status']=='settling' and quantities(f"auction_id='{timed}' and kind='sale_item'")=={'2':'3','364':'5'}
        print('PASS: cancellation/unsold returns, timed sale and Direct trade preserve all contents')
        gift_lot=create()
        gift_mid=str(next(ids));epoch=sql('select floor(extract(epoch from clock_timestamp()))::bigint;')
        raw={'id':gift_mid,'fromid':'48889601','fromname':'Bundle fixture','type':'normal','message':'LIST '+gift_lot,'azunixtime':epoch}
        original={**raw,'type':'giftshop','message':raw['message']+'<table class="item" rel="id=1167&n=1"><tr><td><img></td></tr></table>'}
        raw['gift_original']={**original,'message':original['message']+'<p>Inside Note:<p>Enjoy!'}
        gift={'id':gift_mid,'sender_id':48889601,'sender_name':'Bundle fixture','received_at':sql(f'select to_timestamp({epoch});'),
            'command':{'type':'list','auction_id':gift_lot},'meat':0,'items':parts,'raw':raw}
        def rpc(name,*values):return sql('select public.'+name+'('+','.join(lit(json.dumps(value))+'::jsonb' if isinstance(value,(dict,list)) else lit(value) for value in values)+');')
        sql('select public.bot_ingest_mail('+lit(json.dumps(gift))+');',error='not been verified')
        rpc('bot_register_gift_mail',[{'id':gift_mid,'wrapper_id':1167,'opened':False,'raw':original}])
        owed=json.loads(sql('select public.bot_liabilities();'))
        before={'meat':str(int(owed['meat'])+1000000),'items':dict(owed['items'])};before['items']['1167']=str(int(before['items'].get('1167',0))+10)
        attempt=json.loads(rpc('bot_claim_gift_open',before))
        after={'meat':before['meat'],'items':dict(before['items'])};after['items']['1167']=str(int(after['items']['1167'])-1)
        for entry in parts:after['items'][str(entry['id'])]=str(int(after['items'].get(str(entry['id']),0))+entry['quantity'])
        rpc('bot_finish_gift_open',attempt['id'],gift,after)
        assert rpc('bot_ingest_mail',gift)=='accepted' and row(gift_lot)['status']=='active'
        print('PASS: an unverified gift cannot fund a bundle; proven opening with every component activates normally')
        huge=[{'id':2,'quantity':5000000000},{'id':364,'quantity':5}]
        large=create(items=huge);assert ingest(large,'list',items=huge)[1]=='accepted'
        call(f"select public.cancel_auction('{large}');")
        assert quantities(f"auction_id='{large}' and kind='return_item'")=={'2':'5000000000','364':'5'}
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{large}' and kind='return_item' and item_id=2;")=='5'
        assert sql(f"select max(quantity) from khub_bot.deliveries where auction_id='{large}' and kind='return_item';")=='1000000000'
        print('PASS: bundle statistics count actual units; 5-billion component splits into exact safe delivery chunks')
        # New read-only sort applies before pagination, with explicit sorts retained.
        sort_lots=[]
        for index,hours in enumerate([48,20,72,1,2,3,4]):
            aid=call('select public.create_bundle_auction('+lit(json.dumps(parts))+f",100,24,p_escrow_mode=>false,p_title=>'Sort fixture {index}');")
            sql(f"update public.auctions set end_time=clock_timestamp()+interval '{hours} hours',created_at=clock_timestamp()-interval '{8-index} hours' where id='{aid}';")
            sort_lots.append(aid)
        result=json.loads(call("select public.read_filtered_auction_page('browse',null,'Sort fixture','active','recommended',1,'all','all',null,null);",buyer))
        assert [r['id'] for r in result['rows']]==[sort_lots[i] for i in [3,4,5,6,2,1,0]]
        result=json.loads(call("select public.read_filtered_auction_page('browse',null,'Sort fixture','active','newest',1,'all','all',null,null);",buyer))
        assert [r['id'] for r in result['rows']]==list(reversed(sort_lots))
        before_revision=int(sql('select revision from khub_bot.public_cache_revision;'))
        before_requests=int(sql('select count(*) from net.fixture_requests;'))
        call(f"select public.place_bid('{sort_lots[0]}',100);",buyer)
        assert int(sql('select revision from khub_bot.public_cache_revision;'))==before_revision+1
        assert int(sql('select count(*) from net.fixture_requests;'))==before_requests+1
        call(f"select public.place_bid('{sort_lots[0]}',1);",other,error='at least')
        sql(f"begin;set role authenticated;select public.place_bid('{sort_lots[1]}',100);rollback;",buyer)
        assert int(sql('select revision from khub_bot.public_cache_revision;'))==before_revision+1
        assert int(sql('select count(*) from net.fixture_requests;'))==before_requests+1
        print('PASS: website bids invalidate; rejected and rolled-back bids queue nothing; private hook configuration denied to API roles')
        print('PASS: urgent auctions first, then newest; explicit newest sorting unchanged')
        # Buyout predicates apply to the full matching set before count/pagination.
        buyout_lots=[]
        for index in range(26):
            aid=call('select public.create_bundle_auction('+lit(json.dumps(parts))+f",100,24,p_instant_purchase_price=>5000,p_escrow_mode=>false,p_title=>'Buyout fixture {index}');")
            buyout_lots.append(aid)
        no_buyout=call('select public.create_bundle_auction('+lit(json.dumps(parts))+",100,24,p_escrow_mode=>false,p_title=>'Buyout fixture without');")
        def buyout_page(mode,page=1,uid=buyer,view='browse',target='null'):
            return json.loads(call(f"select public.read_filtered_auction_page('{view}',{target},'Buyout fixture','active','newest',{page},'all','all',null,null,'{mode}');",uid))
        first=buyout_page('with');second=buyout_page('with',2)
        assert first['total']==26 and len(first['rows'])==24 and len(second['rows'])==2
        assert all(r['instant_purchase_price']=='5000' or r['instant_purchase_price']==5000 for r in first['rows']+second['rows'])
        assert buyout_page('without')['total']==1 and buyout_page('without')['rows'][0]['id']==no_buyout
        assert buyout_page('any')['total']==27
        assert buyout_page('with',uid=seller,view='seller',target=lit(seller))['total']==26
        assert buyout_page('with',uid=seller,view='others')['total']==0
        anonymous=json.loads(sql("set role anon;select public.read_filtered_auction_page('browse',null,'Buyout fixture','active','newest',1,'all','all',null,null,'with');"))
        assert anonymous['total']==26 and all(r.get('usernames_visible') is False for r in anonymous['rows']), anonymous
        assert 'Bundle Seller' not in json.dumps(anonymous)
        # Both filters combine BEFORE pagination; ordinary listings remain in No.
        def bundle_page(mode,buyout='any',page=1,search='Buyout fixture'):
            return json.loads(call(f"select public.read_filtered_auction_page('browse',null,{lit(search)},'active','newest',{page},'all','all',null,null,'{buyout}','{mode}');",buyer))
        assert bundle_page('with','with')['total']==26
        assert len(bundle_page('with','with',2)['rows'])==2
        assert bundle_page('with','without')['total']==1
        assert bundle_page('without')['total']==0
        plain=call("select public.create_auction('asbestos ore',1,100,24,null,null,364,false);")
        singles=bundle_page('without',search='asbestos ore')
        assert plain in [r['id'] for r in singles['rows']]
        assert all(len(r.get('bundle_items',[]))<=1 for r in singles['rows'])
        bundles=bundle_page('with',search='asbestos ore')
        assert all(len(r['bundle_items'])>1 for r in bundles['rows'])
        assert bundle_page('any',search='asbestos ore')['total']==singles['total']+bundles['total']
        call(f"select public.cancel_auction('{plain}');")
        print('PASS: Bundle All/Yes/No combines with Buyout and preserves pagination and single-item listings')
        for fixture in [*buyout_lots,no_buyout]: call(f"select public.cancel_auction('{fixture}');")
        print('PASS: buyout filters preserve full counts, pagination, ownership filtering and anonymous privacy')
        # 148/149: shared display work never becomes financial authority.
        sql("update khub_bot.public_discovery_snapshot set refreshed_at=clock_timestamp()-interval '61 seconds';")
        public_args=f"'seller','{seller}','Sort fixture','active','newest',1,'all','all',null,null"
        public_page=json.loads(call('select public.read_public_auction_page('+public_args+');',buyer))
        original_page=json.loads(call('select public.read_filtered_auction_page('+public_args+');',buyer))
        assert public_page['seller'] is None and public_page['bids']==[]
        assert public_page['total']==original_page['total']
        assert [r['id'] for r in public_page['rows']]==[r['id'] for r in original_page['rows']]
        cached=sql('select refreshed_at::text from khub_bot.public_discovery_snapshot;')
        for term in ['Sort fixture','tooth','ore','']:
            call(f"select public.read_public_auction_page('browse',null,{lit(term)},'active','newest',1,'all','all',null,null);",buyer)
        assert sql('select refreshed_at::text from khub_bot.public_discovery_snapshot;')==cached
        assert sql('select price_bounds=khub_bot.public_auction_price_bounds() from khub_bot.public_discovery_snapshot;')=='t'
        # Another aggregate builder cannot make public readers wait on its lock,
        # and it never owns the financial advisory lock.
        sql("update khub_bot.public_discovery_snapshot set refreshed_at=clock_timestamp()-interval '61 seconds';")
        stale_time=sql('select refreshed_at::text from khub_bot.public_discovery_snapshot;')
        holder=subprocess.Popen([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',"begin;select pg_advisory_xact_lock(3888763);select pg_sleep(2);commit;"],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        try:
            import time
            for _ in range(100):
                if sql("select exists(select 1 from pg_locks where locktype='advisory' and objid=3888763 and granted);")=='t':break
                time.sleep(.01)
            else:raise AssertionError('Aggregate fixture did not acquire its lock')
            call('select public.read_public_auction_page('+public_args+');',buyer)
            assert sql('select refreshed_at::text from khub_bot.public_discovery_snapshot;')==stale_time
            assert sql('select pg_try_advisory_xact_lock(3888760);')=='t'
        finally:
            holder.communicate(timeout=5)
            assert holder.returncode==0
        sql('select public.bot_refresh_public_discovery();')

        private=json.loads(call(f"select public.read_seller_auction_context('{seller}',array['{sort_lots[0]}']::uuid[]);",buyer))
        assert private['seller']==original_page['seller'] and private['rows'][0]['seller_id']==seller
        anon=json.loads(sql(f"set role anon;select public.read_seller_auction_context('{seller}',array[]::uuid[]);"))
        assert anon['rows']==[] and anon['seller']['username']=='Player profile'
        assert anon['seller']['stats']==original_page['seller']['stats']
        call(f"select public.read_seller_auction_context('{seller}',array_fill('{sort_lots[0]}'::uuid,array[25]));",buyer,error='at most 24')
        sql('set role anon;select * from khub_bot.public_discovery_snapshot;',error='permission denied')
        sql('set role anon;select public.bot_read_work_queue();',error='permission denied')
        access=json.loads(call('select public.read_my_account_access();'))
        assert access['kol_player_id']==48889601 and access['kol_player_name'] is not None
        sql('set role anon;select public.read_my_account_access();',error='permission denied')
        hints=json.loads(sql('set role service_role;select public.bot_read_work_queue();'))
        assert isinstance(hints['deliveries_pending'],bool) and isinstance(hints['buy_groups'],list)
        print('PASS: public snapshots reused across filter keys; public seller rows match existing pagination; summaries/private context and identity stay uncached and permission-checked')

        # Representative selective search: verify literal equivalence AND an
        # actual index plan on a disposable dataset, without production statistics.
        sql("create table public.efficiency_search_fixture(id integer primary key,item text,bundle_items jsonb);")
        sql("insert into public.efficiency_search_fixture select x,'Ordinary item '||x,'[]'::jsonb from generate_series(1,6000) x;")
        search_rows=[(6001,'NeedleCase 100%_value\\path',[]),(6002,'A bundle',[{'name':'Another NeedleCase','quantity':1},{'name':'other','quantity':2}]),(6003,'No joined match',[{'name':'left','quantity':1},{'name':'right','quantity':1}])]
        for key,name,contents in search_rows:
            sql(f"insert into public.efficiency_search_fixture values({key},{lit(name)},{lit(json.dumps(contents))});")
        ns=sql("select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm';")
        sql(f"create index efficiency_name_idx on public.efficiency_search_fixture using gin(lower(item) {ns}.gin_trgm_ops);create index efficiency_bundle_idx on public.efficiency_search_fixture using gin(khub_bot.bundle_search_names(bundle_items) {ns}.gin_trgm_ops);analyze public.efficiency_search_fixture;")
        for term in ['NeedleCase','  needlecase  ','100%','_value','\\path','left'+chr(31)+'right','']:
            old=f"(strpos(lower(a.item),lower(btrim({lit(term)})))>0 or exists(select 1 from jsonb_array_elements(a.bundle_items) c where strpos(lower(c->>'name'),lower(btrim({lit(term)})))>0))"
            new=f"(lower(a.item) like khub_bot.literal_auction_pattern({lit(term)}) or (khub_bot.bundle_search_names(a.bundle_items) like khub_bot.literal_auction_pattern({lit(term)}) and exists(select 1 from jsonb_array_elements(a.bundle_items) c where strpos(lower(c->>'name'),lower(btrim({lit(term)})))>0)))"
            assert sql('select array_agg(id order by id) from public.efficiency_search_fixture a where '+old)==sql('select array_agg(id order by id) from public.efficiency_search_fixture a where '+new),term
        plan=json.loads(sql("explain (analyze,buffers,format json) select id from public.efficiency_search_fixture a where lower(a.item) like khub_bot.literal_auction_pattern('NeedleCase') or (khub_bot.bundle_search_names(a.bundle_items) like khub_bot.literal_auction_pattern('NeedleCase') and exists(select 1 from jsonb_array_elements(a.bundle_items) c where strpos(lower(c->>'name'),'needlecase')>0));"))
        assert 'efficiency_name_idx' in json.dumps(plan) and 'efficiency_bundle_idx' in json.dumps(plan)
        assert plan[0]['Plan']['Actual Rows']==2
        sql('drop table public.efficiency_search_fixture;')
        print('PASS: indexed substring search preserves case, whitespace, wildcard, backslash and component boundaries; selective EXPLAIN ANALYZE uses both GIN indexes')


        order=call("select public.create_buy_auction(2,10,200,24,'finished');")
        required=int(sql(f"select funding_required from khub_bot.buy_orders where auction_id='{order}';"))
        assert ingest(order,'fund',required)[1]=='accepted'
        reservation=json.loads(call(f"select public.reserve_buy_quantity('{order}',2);",buyer))
        owner_card=json.loads(call(f"select public.read_auction_card_context(array['{order}']::uuid[]);",seller))['rows'][0]
        buyer_card=json.loads(call(f"select public.read_auction_card_context(array['{order}']::uuid[]);",buyer))['rows'][0]
        unrelated_card=json.loads(call(f"select public.read_auction_card_context(array['{order}']::uuid[]);",other))['rows'][0]
        assert 'balance_meat' in owner_card and 'balance_meat' not in buyer_card and 'balance_meat' not in unrelated_card
        assert buyer_card['my_reservation']['id']==reservation['id'] and unrelated_card['my_reservation'] is None
        print('PASS: uncached Buy context keeps balances owner-only and reservations isolated per viewer')
        mid,result,_=ingest(order,'fill',items=[{'id':2,'quantity':2}],actor=48889602,reservation=reservation['id'])
        assert result=='accepted',result
        stats=json.loads(sql(f"select khub_bot.buy_profile_totals('{seller}');"))
        assert stats['buy_orders_created']=='1' and stats['buy_orders_bought_units']=='0'
        sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where receipt_id='{mid}' and dedupe_key like 'buy-fill-payment:%';")
        stats=json.loads(sql(f"select khub_bot.buy_profile_totals('{seller}');"))
        assert stats['buy_orders_bought_units']=='2'
        assert int(stats['buy_orders_spent'])==int(sql(f"select payment_meat+commission_meat from khub_bot.buy_fulfillments where receipt_id='{mid}';"))
        stats=json.loads(sql(f"select khub_bot.buy_profile_totals('{buyer}');"))
        assert stats['buy_order_sales']=='1' and stats['buy_order_units']=='2' and stats['buy_orders_created']=='0'
        print('PASS: created/fulfilled Buy order stats distinguish players and exclude unpaid fulfillments')
        no_attachment_revision=sql('select revision from khub_bot.public_cache_revision;')
        mid,result,replay=ingest(gift_lot,'bid',0,actor=48889602)
        assert result=='bid_help',result
        reply=sql(f"select coalesce(d.display_message,khub_bot.friendly_message(d)) from khub_bot.deliveries d where receipt_id='{mid}';")
        assert 'No attached Meat or items were detected.' in reply and 'Your request was not accepted.' in reply
        before=sql(f"select count(*) from khub_bot.deliveries where receipt_id='{mid}';")
        sql(replay)
        assert sql(f"select count(*) from khub_bot.deliveries where receipt_id='{mid}';")==before
        assert sql(f"select count(*) from public.bids where auction_id='{gift_lot}';")=='0'
        assert sql('select revision from khub_bot.public_cache_revision;')==no_attachment_revision
        print('PASS: no-attachment bids receive the existing concise reply once; never become funded bids')
        # Higher-valued completed lots must not displace lower-valued active lots.
        high_active=call('select public.create_bundle_auction('+lit(json.dumps([{'id':2,'quantity':1},{'id':364,'quantity':1}]))+",60000000,24,p_escrow_mode=>false);")
        sql('update khub_bot.market_prices set price_meat=50000000 where item_id=2;')
        high_home=json.loads(call('select public.read_home_auctions();',buyer))
        high_ids=high_home['sections']['highRollers']
        assert lot in high_ids and high_active in high_ids
        assert high_ids.index(high_active)<high_ids.index(lot)
        by_id={r['id']:r for r in high_home['rows']}
        completed_flags=[by_id[aid]['status']=='completed' for aid in high_ids]
        assert completed_flags==sorted(completed_flags)
        print('PASS: homepage High Rollers selects all active lots before completed trades, even when completed values are higher')
        # Multi-item envelopes preserve all original ledger rows and reservations.
        sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where state not in ('sent','cancelled'); update khub_bot.closet_transfers set state='moved' where state<>'moved';")
        def queued_batch(key, count=10, meat=19):
            attachments=[{'id':900000+i,'quantity':i+1} for i in range(count)]
            sql("select khub_bot.queue("+lit(key)+",null,null,48889602,'refund',"+str(meat)+","+lit(json.dumps(attachments))+"::jsonb,'same return');")
            sql("update khub_bot.deliveries set display_message='Your items and Meat are returned.',display_footer='' where dedupe_key like "+lit(key+':%')+";")
        def batch_claim(key):
            for _ in range(30):
                d=json.loads(sql('set role service_role;select public.bot_claim_delivery_batch(5);') or 'null')
                assert d is not None
                if d['dedupe_key'].startswith(key+':'):return d
                sql("select public.bot_ack_delivery('"+d['id']+"','"+d['attempt']+"',true,'local test confirmed send');")
            raise AssertionError('test queue never reached')
        # Exercise real templates, not just synthetic matching messages.
        real_reject=create()
        rejected_mid,rejected_result,_=ingest(real_reject,'list',19,parts)
        assert rejected_result not in ('accepted','activated')
        real_key='rejected:'+rejected_mid
        d=batch_claim(real_key)
        assert len(d['items'])==2 and d['meat']=='19',d
        assert 'Request not accepted' in d['display_message']
        sql("select public.bot_ack_delivery('"+d['id']+"','"+d['attempt']+"',true,'verified real rejected bundle return');")
        real_return=create();assert ingest(real_return,'list',items=parts)[1]=='accepted'
        call(f"select public.cancel_auction('{real_return}');")
        return_key=sql(f"select regexp_replace(dedupe_key,':(item:[0-9]+|meat):[0-9]+$','') from khub_bot.deliveries where auction_id='{real_return}' and kind='return_item' limit 1;")
        d=batch_claim(return_key)
        assert len(d['items'])==2 and 'bundle items are being returned' in d['display_message'],d
        checks=json.loads(sql('select public.bot_mailbox_check_deliveries();'))
        saved=next(x for x in checks if x['id']==d['id'])
        assert saved['expected_message']==d['display_message']+'\n\n'+d['reference_marker']+(('\n'+d['display_footer']) if d.get('display_footer') else '')
        assert 'Attached in this message:' not in d['display_message']
        original=sql("select display_message from khub_bot.deliveries where id='"+d['id']+"';")
        assert 'Attached in this message:' in original
        sql("select public.bot_split_delivery_batch('"+d['id']+"','"+d['attempt']+"');")
        assert sql("select display_message from khub_bot.deliveries where id='"+d['id']+"';")==original
        sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where auction_id='{real_return}';")
        # Operator gift-return templates also differ per item; the envelope
        # normalizes them without altering their original frozen ledger messages.
        sql("select khub_bot.queue('gift-return:fixture',null,null,48889602,'refund',19,'[{\"id\":2,\"quantity\":3},{\"id\":364,\"quantity\":5}]'::jsonb,'Operator-requested return of verified gift contents.');")
        # A real receipt is required in the template; reuse the rejected receipt.
        sql("update khub_bot.deliveries set receipt_id="+lit(rejected_mid)+" where dedupe_key like 'gift-return:fixture:%';")
        d=batch_claim('gift-return:fixture')
        assert len(d['items'])==2 and d['meat']=='19' and 'Your gift contents are being returned' in d['display_message'],d
        sql("select public.bot_ack_delivery('"+d['id']+"','"+d['attempt']+"',true,'verified operator gift contents return');")
        print('PASS: actual rejected bundle, canceled bundle and operator gift-return templates group correctly; frozen originals survive gift fallback')
        queued_batch('multi-test')
        before=json.loads(sql('select public.bot_liabilities();'))
        d=batch_claim('multi-test')
        assert len(d['items'])==10 and d['meat']=='19' and d['mail_batch']==d['id'],d
        assert sql("select count(*) from khub_bot.deliveries where mail_batch='"+d['id']+"' and state='sending';")=='11'
        assert json.loads(sql('select public.bot_liabilities();'))==before
        checks=json.loads(sql('select public.bot_mailbox_check_deliveries();'))
        assert len(checks)==1 and len(checks[0]['items'])==10 and checks[0]['meat']=='19'
        sql("select public.bot_ack_delivery('"+d['id']+"','"+d['attempt']+"',true,'verified local envelope send');")
        assert sql("select count(*) from khub_bot.deliveries where mail_batch='"+d['id']+"' and state='sent';")=='11'
        print('PASS: 10 item types plus Meat share one envelope; all 11 ledger rows reserved then acknowledged together')
        queued_batch('multi-limit',13,0)
        d=batch_claim('multi-limit');assert len(d['items'])==11
        sql("select public.bot_ack_delivery('"+d['id']+"','"+d['attempt']+"',true,'verified first limited envelope');")
        d=batch_claim('multi-limit');assert len(d['items'])==2
        sql("select public.bot_ack_delivery('"+d['id']+"','"+d['attempt']+"',true,'verified final limited envelope');")
        queued_batch('multi-uncertain',3,0)
        d=batch_claim('multi-uncertain')
        sql("select public.bot_ack_delivery('"+d['id']+"','"+d['attempt']+"',false,'send response timed out');")
        result={'status':'not_found','candidate_ids':[]}
        sql("select public.bot_record_mailbox_check('"+d['id']+"','"+d['attempt']+"',"+lit(json.dumps(result))+"::jsonb);")
        assert sql("select count(*) from khub_bot.delivery_mailbox_reviews where resolved_at is null and delivery_id in (select id from khub_bot.deliveries where mail_batch='"+d['id']+"');")=='3'
        assert len(json.loads(sql('select public.bot_mailbox_check_deliveries();')))==1
        # A member cannot be resent or individually marked sent. Reconciliation
        # through any member applies to the original full envelope atomically.
        child=sql("select id from khub_bot.deliveries where mail_batch='"+d['id']+"' and id<>'"+d['id']+"' limit 1;")
        sql("select public.bot_ack_delivery('"+child+"','"+d['attempt']+"',true,'invalid partial acknowledgment');",error='batch reference')
        assert sql("select count(*) from khub_bot.deliveries where mail_batch='"+d['id']+"' and state='unknown';")=='3'
        verified={'status':'verified','candidate_ids':['123456789'],'message_id':'123456789','message_hash':'a'*64}
        sql("select public.bot_record_mailbox_check('"+d['id']+"','"+d['attempt']+"',"+lit(json.dumps(verified))+"::jsonb);")
        assert sql("select count(*) from khub_bot.deliveries where mail_batch='"+d['id']+"' and state='sent';")=='3'
        assert sql("select count(*) from khub_bot.delivery_mailbox_reviews where resolved_at is null and delivery_id in (select id from khub_bot.deliveries where mail_batch='"+d['id']+"');")=='0'
        print('PASS: >11 types split safely; uncertain envelope isolates all members; one exact Sent Mail recovery resolves all')
        queued_batch('multi-manual',3,0)
        d=batch_claim('multi-manual')
        child=sql("select id from khub_bot.deliveries where mail_batch='"+d['id']+"' and id<>'"+d['id']+"' limit 1;")
        full=json.loads(sql("set role service_role;select public.bot_lookup_delivery('"+child+"');"))
        assert full['id']==d['id'] and len(full['items'])==3
        sql("update khub_bot.deliveries set attempt=gen_random_uuid() where id='"+child+"';")
        sql("select public.bot_ack_delivery('"+d['id']+"','"+d['attempt']+"',true,'stale child claim must roll back');",error='claim does not match')
        assert sql("select count(*) from khub_bot.deliveries where mail_batch='"+d['id']+"' and state='sending';")=='3'
        sql("update khub_bot.deliveries set attempt='"+d['attempt']+"' where id='"+child+"';")
        sql("select public.bot_ack_delivery('"+d['id']+"','"+d['attempt']+"',false,'uncertain local test envelope');")
        sql("select public.bot_reconcile_delivery('"+child+"',false,'manually verified no envelope sent');")
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like 'multi-manual:%' and state='pending' and mail_batch is null and not mail_batch_disabled;")=='3'
        regrouped=batch_claim('multi-manual');assert len(regrouped['items'])==3
        sql("select public.bot_ack_delivery('"+regrouped['id']+"','"+regrouped['attempt']+"',true,'verified regrouped regular envelope');")
        queued_batch('multi-held',4,0)
        held=sql("select id from khub_bot.deliveries where dedupe_key like 'multi-held:%' order by id limit 1;")
        sql("insert into khub_bot.gift_delivery_waits(delivery_id,retry_after,failures,stage) values('"+held+"',clock_timestamp()+interval '1 day',1,'wrapping_solvency');")
        queued_batch('multi-other-plan',2,0)
        d=batch_claim('multi-held');assert len(d['items'])==3
        assert sql("select state from khub_bot.deliveries where id='"+held+"';")=='pending'
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like 'multi-other-plan:%' and state='pending';")=='2'
        sql("select public.bot_ack_delivery('"+d['id']+"','"+d['attempt']+"',true,'verified eligible siblings only');")
        sql("select public.bot_split_delivery_batch('"+d['id']+"','"+d['attempt']+"');",error='Batch claim changed')
        sql('set role anon;select public.bot_claim_delivery_batch(5);',error='permission denied')
        print('PASS: member lookup shows full envelope; stale claims roll back atomically; manual not-sent preserves all debts; held/unrelated rows excluded')
        queued_batch('multi-gift',3,0)
        d=batch_claim('multi-gift')
        sql("select public.bot_split_delivery_batch('"+d['id']+"','"+d['attempt']+"');")
        sql("select public.bot_split_delivery_batch('"+d['id']+"','"+d['attempt']+"');")
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like 'multi-gift:%' and state='pending' and mail_batch is null and mail_batch_disabled;")=='3'
        single=batch_claim('multi-gift');assert single['mail_batch'] is None and 'items' not in single
        sql("select public.bot_ack_delivery('"+single['id']+"','"+single['attempt']+"',true,'verified individual gift send');")
        print('PASS: known non-attempt gift fallback splits idempotently; subsequent claims remain individual')
        # 141: full bundle context appears in notices, settlements, rejections,
        # and explicit Direct Trade reminders, while gift fallback identifies the
        # individual attachment without confusing it with the entire bundle.
        sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where state='pending';")
        rich_title='Adventures & friends'
        rich=call('select public.create_bundle_auction('+lit(json.dumps(parts))+',100,24,p_title=>'+lit(rich_title)+');')
        rich_mid,rich_result,_=ingest(rich,'list',items=parts);assert rich_result=='accepted'
        # Use the canonical stored title, including the existing Bundle: prefix.
        escaped=sql(f"select khub_bot.escape_report_kmail(item) from public.auctions where id='{rich}';")
        name2=sql("select khub_bot.escape_report_kmail(name) from khub_bot.catalog where id=2;")
        name364=sql("select khub_bot.escape_report_kmail(name) from khub_bot.catalog where id=364;")
        context=escaped+'\nBundle contents:\n- 3 × '+name2+'\n- 5 × '+name364
        activation=batch_claim('activated:'+rich_mid)
        assert context in activation['display_message'],activation
        assert ' × 1\nBundle contents:' not in activation['display_message']
        sql("select public.bot_ack_delivery('"+activation['id']+"','"+activation['attempt']+"',true,'verified bundle activation notice');")
        first_bid,_,_=ingest(rich,'bid',100,actor=48889602)
        bid=batch_claim('bid-accepted:'+first_bid);assert context in bid['display_message']
        sql("select public.bot_ack_delivery('"+bid['id']+"','"+bid['attempt']+"',true,'verified bundle bid confirmation');")
        second_bid,_,_=ingest(rich,'bid',200,actor=48889603)
        outbid=batch_claim('outbid:'+second_bid);assert context in outbid['display_message']
        sql("select public.bot_ack_delivery('"+outbid['id']+"','"+outbid['attempt']+"',true,'verified bundle outbid refund');")
        expire(rich)
        sale_key=sql(f"select regexp_replace(dedupe_key,':(item:[0-9]+|meat):[0-9]+$','') from khub_bot.deliveries where auction_id='{rich}' and kind='sale_item' limit 1;")
        winnings=batch_claim(sale_key)
        assert len(winnings['items'])==2 and context in winnings['display_message']
        assert winnings['display_message'].count('This message contains:')==1
        assert '- 3 × '+name2 in winnings['display_message'].split('This message contains:')[1]
        assert '- 5 × '+name364 in winnings['display_message'].split('This message contains:')[1]
        sql("select public.bot_split_delivery_batch('"+winnings['id']+"','"+winnings['attempt']+"');")
        gift_part=batch_claim(sale_key)
        assert context in gift_part['display_message'] and 'Attached in this message: ' in gift_part['display_message']
        assert 'This message contains:' not in gift_part['display_message']
        attachment_name=name2 if gift_part['item_id']==2 else name364
        assert str(gift_part['quantity'])+' x '+attachment_name in gift_part['display_message']
        # The individual gift body is exactly what recovery will look for.
        check=next(x for x in json.loads(sql('select public.bot_mailbox_check_deliveries();')) if x['id']==gift_part['id'])
        assert check['expected_message']==gift_part['display_message']+'\n\n'+gift_part['reference_marker']
        sql("select public.bot_ack_delivery('"+gift_part['id']+"','"+gift_part['attempt']+"',true,'verified individual winning bundle gift');")
        sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where auction_id='{rich}' and state='pending';")
        # Actual Buy-auction rejection containing multiple item types plus Meat.
        buy_bad_mid,_,_=ingest(order,'fill',meat=7,items=parts,actor=48889602)
        buy_return=batch_claim('buy-rejected:'+buy_bad_mid)
        assert len(buy_return['items'])==2 and buy_return['meat']=='7',buy_return
        assert 'This message contains:' in buy_return['display_message']
        sql("select public.bot_ack_delivery('"+buy_return['id']+"','"+buy_return['attempt']+"',true,'verified grouped Buy rejection refund');")
        # Preformatted reminders do not call friendly_message: insertion trigger
        # must add the same context without changing the trade instructions.
        direct_context_lot=create(False);call(f"select public.place_bid('{direct_context_lot}',200);",buyer);expire(direct_context_lot)
        direct_body=sql(f"select display_message from khub_bot.deliveries where auction_id='{direct_context_lot}' and dedupe_key like 'direct-trade-reminder:%' limit 1;")
        assert 'Bundle contents:\n- 3 × '+name2+'\n- 5 × '+name364 in direct_body
        assert 'Do not send these items or Meat to kHub; this is a Direct Trade.' in direct_body
        # Preparing a message twice must not duplicate either list. Already
        # sending/unknown/sent bodies must not be changed by later state updates.
        assert sql("select khub_bot.prepare_bundle_mail(d,d.display_message)=d.display_message from khub_bot.deliveries d where id='"+gift_part['id']+"';")=='t'
        frozen_before=sql("select display_message from khub_bot.deliveries where id='"+gift_part['id']+"';")
        sql("update khub_bot.deliveries set display_message=display_message where id='"+gift_part['id']+"';")
        assert sql("select display_message from khub_bot.deliveries where id='"+gift_part['id']+"';")==frozen_before
        print('PASS: bundle lists under escaped titles in activation/bids/outbid/winnings/Direct reminders; per-gift contents explicit and frozen; Buy rejections grouped')
        # 142: reference-targeted income lookup distinguishes a new donation from
        # an older uncertain move, without relying on today's live balances.
        donation_payload={'sender_id':2949208,'sender_name':'Sheber','meat':4444444,'items':[],
            'raw':{'type':'normal','fromname':'Sheber'}}
        old_payload={'sender_id':123,'sender_name':'Earlier donor','meat':700,'items':[],
            'raw':{'type':'normal','fromname':'Earlier donor'}}
        for mid,payload in [('206249968',donation_payload),('206248232',old_payload)]:
            sql("insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result) values("+lit(mid)+","+str(payload['sender_id'])+",clock_timestamp(),"+lit(json.dumps(payload))+"::jsonb,'donation');")
        old_c=sql("select id from khub_bot.closet_transfers where receipt_id='206248232';")
        old_ref=sql("select 'C-'||reference_number from khub_bot.closet_transfers where id='"+old_c+"';")
        diagnostic={'stage':'balance_mismatch','httpStatus':302,'before':{'inventory':'5000','closet':'1000'},
            'after':{'inventory':'5000','closet':'1000'}}
        sql("update khub_bot.closet_transfers set state='unknown',attempt=gen_random_uuid(),before_state='{\"inventory\":\"5000\",\"closet\":\"1000\"}',evidence="+lit('Closet outcome uncertain. '+json.dumps(diagnostic))+" where id='"+old_c+"';")
        older=json.loads(sql('set role service_role;select public.bot_lookup_closet_transfer('+lit(old_ref)+');'))
        assert older['source_player_name']=='Earlier donor' and older['source_player_id']==123 and older['receipt_id']=='206248232'
        income=json.loads(sql("set role service_role;select public.bot_income_status('M-206249968');"))
        assert income['sender_name']=='Sheber' and income['received_meat']=='4444444'
        assert len(income['transfers'])==1 and income['transfers'][0]['state']=='pending'
        assert old_ref in income['blocked_by'] and income['transfers'][0]['receipt_id']=='206249968'
        assert json.loads(sql("set role service_role;select public.bot_income_status('M-999999999');"))['found'] is False
        sql("set role anon;select public.bot_income_status('M-206249968');",error='permission denied')
        # The command is genuinely read-only: neither uncertain nor pending moves
        # are resolved by checking their references.
        assert sql("select state from khub_bot.closet_transfers where id='"+old_c+"';")=='unknown'
        assert sql("select state from khub_bot.closet_transfers where receipt_id='206249968';")=='pending'
        print('PASS: donor/source context and exact receipt lookup distinguish pending donation from older unknown move; anonymous access denied')
        # An opened, untracked gift is an expected review outcome, not a failing
        # transaction. Repeated identical mail makes no new row/update/deposit.
        raw_gift={'id':'206200142','type':'giftshop','fromid':'123','fromname':'Gift donor','azunixtime':'1793200000','message':'Saved opened gift'}
        envelope={'id':raw_gift['id'],'wrapper_id':None,'opened':True,'raw':raw_gift}
        query='set role service_role;select public.bot_register_gift_mail('+lit(json.dumps([envelope]))+'::jsonb);'
        registered=json.loads(sql(query));assert raw_gift['id'] in registered['reviews']
        review_xmin=sql("select xmin::text from khub_bot.gift_mail_reviews where mail_id='206200142';")
        sql(query);sql(query)
        assert sql("select xmin::text from khub_bot.gift_mail_reviews where mail_id='206200142';")==review_xmin
        assert sql("select count(*) from khub_bot.receipts where mail_id='206200142';")=='0'
        assert sql("select count(*) from khub_bot.incoming_gifts where mail_id='206200142';")=='0'
        sql("update khub_bot.gift_mail_reviews set resolved_at=clock_timestamp(),resolution='local verified review fixture' where mail_id='206200142';")
        sql(query)
        assert sql("select resolved_at is not null from khub_bot.gift_mail_reviews where mail_id='206200142';")=='t'
        envelope['raw']={**raw_gift,'message':'Changed saved mail contents'}
        sql('set role service_role;select public.bot_register_gift_mail('+lit(json.dumps([envelope]))+'::jsonb);')
        assert sql("select resolved_at is null from khub_bot.gift_mail_reviews where mail_id='206200142';")=='t'
        print('PASS: untracked opened gifts create one review without repeated exceptions/updates or new funds; changed mail reopens review safely')
        # 143: use disposable financial fixtures only. Original production rows
        # are never changed by installing the migration itself.
        sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where state not in ('sent','cancelled'); update khub_bot.closet_transfers set state='moved' where state<>'moved'; update khub_bot.gift_mail_reviews set resolved_at=clock_timestamp(),resolution='local fixture reset' where resolved_at is null;")
        big_snapshot={'meat':'9000000000000000','closetMeat':'1000','items':{},'closetItems':{}}
        # Display metadata travels with the claim; no extra bot read per transfer.
        for context_auction,is_bundle,total in [(plain,False,None),(large,True,'5000000005')]:
            sql("select khub_bot.queue_closet('logging-context-"+context_auction+"','sale_fee',null,'"+context_auction+"',700,'[]');")
            context=json.loads(sql('set role service_role;select public.bot_claim_closet_transfer_v2('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');"))
            listing=row(context_auction)
            assert context['auction_id']==context_auction and context['auction_number']==listing['auction_number']
            assert context['auction_item']==listing['item'] and context['auction_quantity']==str(listing['quantity'])
            assert context['auction_is_bundle'] is is_bundle and context['auction_bundle_units']==total
            assert 'recovery' in context and 'soft_retry' in context
            sql("select public.bot_arm_closet_transfer('"+context['id']+"','"+context['attempt']+"');")
            sql("select public.bot_ack_closet_transfer('"+context['id']+"','"+context['attempt']+"',true,'local verified logging fixture');")
        print('PASS: commission claims include canonical auction number, title, quantity and exact large bundle total while preserving recovery metadata')
        counter=0
        def recovery_claim():
            global counter
            counter+=1
            sql("select khub_bot.queue_closet('recovery-test-"+str(counter)+"','sale_fee',null,null,700,'[]');")
            return json.loads(sql('set role service_role;select public.bot_claim_closet_transfer_v2('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');"))
        def due_for(d):
            sql("update khub_bot.closet_recovery_attempts set next_check_at=clock_timestamp()-interval '1 second' where attempt='"+d['attempt']+"';")
            return next(x for x in json.loads(sql('select public.bot_due_closet_recovery();')) if x['closet_reference']==d['closet_reference'])
        def arm(d):sql("select public.bot_arm_closet_transfer('"+d['id']+"','"+d['attempt']+"');")
        def uncertain(d):sql("select public.bot_ack_closet_transfer('"+d['id']+"','"+d['attempt']+"',false,'local fixture lost response');")
        def observe(d,check,closet='1000',inventory='8999999999999300',failed=False,error=None):
            payload={'read_failed':True} if failed else {'closet':closet,'inventory':inventory}
            result=sql("select public.bot_record_closet_recovery('"+d['id']+"','"+d['attempt']+"','"+check['check_id']+"',"+lit(json.dumps(payload))+"::jsonb);",error=error)
            return None if error else json.loads(result)
        d=recovery_claim();assert d['closet_recovery_version']==1
        assert due_for(d)['recovery_status']=='not_attempted'
        assert sql("select state from khub_bot.closet_transfers where id='"+d['id']+"';")=='pending'
        sql("select public.bot_arm_closet_transfer('"+d['id']+"','"+d['attempt']+"');",error='attempt changed')
        fresh=json.loads(sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');"))
        assert fresh['id']==d['id'] and fresh['attempt']!=d['attempt']
        arm(fresh)
        sql("select public.bot_arm_closet_transfer('"+fresh['id']+"','"+fresh['attempt']+"');",error='already armed')
        uncertain(fresh)
        sql('select public.bot_isolate_closet_transfers();')
        assert sql("select count(*) from khub_bot.closet_transfer_reviews where transfer_id='"+fresh['id']+"';")=='0'
        check=due_for(fresh)
        assert observe(fresh,check,'1700','5000')['status']=='moved'
        assert observe(fresh,check,'1700','5000')['status']=='moved' # lost RPC response replay
        assert sql("select count(*) from khub_bot.closet_recovery_observations where attempt='"+fresh['attempt']+"';")=='1'
        sql("select public.bot_ack_closet_transfer('"+fresh['id']+"','"+fresh['attempt']+"',true,'late successful acknowledgment');")
        print('PASS: never-armed attempts requeue with stale-write fencing; exact delayed closet delta resolves despite later inventory changes; acknowledgment/recovery idempotent')
        d=recovery_claim();arm(d);uncertain(d)
        for n in range(5):
            if n==4:sql("update khub_bot.closet_recovery_attempts set deadline=clock_timestamp()-interval '1 second' where attempt='"+d['attempt']+"';")
            check=due_for(d);result=observe(d,check)
            assert result['status']==('review' if n==4 else 'watching')
        assert sql("select state from khub_bot.closet_transfers where id='"+d['id']+"';")=='unknown'
        assert sql("select count(*) from khub_bot.closet_recovery_observations where attempt='"+d['attempt']+"';")=='5'
        assert d['closet_reference'] not in [x['closet_reference'] for x in json.loads(sql('select public.bot_due_closet_recovery();'))]
        sql('select public.bot_isolate_closet_transfers();select public.bot_isolate_closet_transfers();')
        assert sql("select count(*) from khub_bot.closet_transfer_reviews where transfer_id='"+d['id']+"';")=='1'
        assert json.loads(sql('select public.bot_worker_status();'))['closetRecoveryReviewKey']
        sql("select khub_bot.queue_closet('recovery-blocked-meat','sale_fee',null,null,700,'[]');")
        assert sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');")==''
        print('PASS: incomplete/too-short observation history cannot authorize a soft retry; review alerts deduplicate; same-asset holds remain')
        sql("update khub_bot.closet_transfers set state='moved' where state<>'moved';")
        d=recovery_claim();arm(d);uncertain(d);check=due_for(d)
        assert observe(d,check,'1350')['status']=='review'
        assert sql("select state from khub_bot.closet_transfers where id='"+d['id']+"';")=='unknown'
        sql("update khub_bot.closet_transfers set state='moved' where id='"+d['id']+"';")
        d=recovery_claim();arm(d);uncertain(d)
        stale=due_for(d);current=due_for(d)
        observe(d,stale,'1700',error='stale observation')
        assert observe(d,current,failed=True)['status']=='watching'
        assert sql("select state from khub_bot.closet_transfers where id='"+d['id']+"';")=='unknown'
        lookup=json.loads(sql('select public.bot_lookup_closet_transfer('+lit(d['closet_reference'])+');'))
        assert lookup['recovery']['state']=='watching' and lookup['recovery_observations'][0]['snapshot']['read_failed']
        sql("update khub_bot.closet_transfers set state='moved' where id='"+d['id']+"';")
        # An older worker's claim has NO native pre-submit marker. Import it as
        # legacy; even the apparent expected delta cannot be attributed safely.
        sql("select khub_bot.queue_closet('recovery-legacy','sale_fee',null,null,700,'[]');")
        legacy=json.loads(sql('select public.bot_claim_closet_transfer('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');"))
        uncertain(legacy)
        check=next(x for x in json.loads(sql('select public.bot_due_closet_recovery();')) if x['closet_reference']==legacy['closet_reference'])
        assert check['legacy'] and observe(legacy,check,'1700')['status']=='watching'
        assert sql("select armed_at is null from khub_bot.closet_recovery_attempts where attempt='"+legacy['attempt']+"';")=='t'
        sql("update khub_bot.closet_recovery_attempts set deadline=clock_timestamp()-interval '1 second' where attempt='"+legacy['attempt']+"';")
        assert observe(legacy,due_for(legacy),'1700')['status']=='review'
        sql("set role anon;select public.bot_due_closet_recovery();",error='permission denied')
        sql("set role authenticated;select public.bot_arm_closet_transfer('"+legacy['id']+"','"+legacy['attempt']+"');",error='permission denied')
        print('PASS: partial changes, failed reads, stale leases, legacy attempts and unauthorized callers cannot trigger unsafe completion or replay; observations survive separate DB calls')
        # An unresolved Meat move must not prevent recovery of a different item.
        sql("select khub_bot.queue_closet('recovery-item','sale_fee',null,null,0,'[{\"id\":2,\"quantity\":3}]');")
        item_snapshot={**big_snapshot,'items':{'2':'9000000000000000'},'closetItems':{'2':'5'}}
        item_move=json.loads(sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(item_snapshot))+"::jsonb,0,0,'{}');"))
        assert item_move['item_id']==2;arm(item_move);uncertain(item_move)
        assert observe(item_move,due_for(item_move),'8','2')['status']=='moved'
        assert sql("select state from khub_bot.closet_transfers where id='"+legacy['id']+"';")=='unknown'
        sql("update khub_bot.closet_transfers set state='moved' where state<>'moved';")
        d=recovery_claim();arm(d)
        sql("select public.bot_release_unsubmitted_closet('"+d['id']+"','"+d['attempt']+"');")
        after_release=json.loads(sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');"))
        sql("select public.bot_release_unsubmitted_closet('"+d['id']+"','"+d['attempt']+"');") # old response replay cannot cancel new claim
        assert sql("select attempt::text from khub_bot.closet_transfers where id='"+d['id']+"';")==after_release['attempt']
        sql("select public.bot_arm_closet_transfer('"+d['id']+"','"+d['attempt']+"');",error='attempt changed')
        arm(after_release);uncertain(after_release)
        sql("select khub_bot.queue_closet('recovery-other-writer','sale_fee',null,null,700,'[]');update khub_bot.closet_transfers set state='unknown',attempt=gen_random_uuid(),before_state='{\"inventory\":\"9000\",\"closet\":\"1000\"}' where dedupe_key='recovery-other-writer:meat:0';")
        assert observe(after_release,due_for(after_release),'1700')['status']=='review'
        assert sql("select state from khub_bot.closet_transfers where id='"+after_release['id']+"';")=='unknown'
        print('PASS: unrelated asset recovers while Meat remains held; known pre-request failure safely releases armed marker; replay cannot cancel fresh claim; concurrent writers require review')
        # A queued row with existing completion proof must be repaired, not paid
        # twice; an armed-but-unresolved queued row is contradictory and held.
        sql("update khub_bot.closet_transfers set state='moved' where state<>'moved';")
        d=recovery_claim();arm(d);uncertain(d)
        assert observe(d,due_for(d),'1700')['status']=='moved'
        sql("update khub_bot.closet_transfers set state='pending',attempt=null where id='"+d['id']+"';")
        assert sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');")==''
        assert sql("select state from khub_bot.closet_transfers where id='"+d['id']+"';")=='moved'
        d=recovery_claim();arm(d);uncertain(d)
        sql("update khub_bot.closet_transfers set state='pending',attempt=null where id='"+d['id']+"';")
        assert sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');")==''
        assert sql("select state from khub_bot.closet_transfers where id='"+d['id']+"';")=='unknown'
        assert sql("select state from khub_bot.closet_recovery_attempts where attempt='"+d['attempt']+"';")=='review'
        sql('select public.bot_isolate_closet_transfers();')
        first_report=sql("select report_id from khub_bot.closet_transfer_reviews where transfer_id='"+d['id']+"';")
        sql("select public.bot_reconcile_closet_transfer('"+d['id']+"',false,'local operator verified exact request never moved');")
        assert sql("select state from khub_bot.closet_recovery_attempts where attempt='"+d['attempt']+"';")=='not_moved'
        again=json.loads(sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');"))
        assert again['id']==d['id'] and again['attempt']!=d['attempt']
        arm(again);uncertain(again)
        sql("update khub_bot.closet_recovery_attempts set deadline=clock_timestamp()-interval '1 second' where attempt='"+again['attempt']+"';")
        assert observe(again,due_for(again))['status']=='review'
        sql('select public.bot_isolate_closet_transfers();select public.bot_isolate_closet_transfers();')
        second_report=sql("select report_id from khub_bot.closet_transfer_reviews where transfer_id='"+again['id']+"';")
        assert second_report!=first_report
        assert sql("select status from khub_bot.bug_reports where id='"+first_report+"';")=='resolved'
        assert sql("select status from khub_bot.bug_reports where id='"+second_report+"';")=='open'
        print('PASS: pending row with completion proof repaired without a write; queued authorized attempt quarantined; manual reconciliation retires old schedule and permits a new fenced claim')
        # 144: owner-authorized, one-time closet-only soft retry after actual
        # scheduled observations. Simulate clock history, not a five-minute sleep.
        def clear_closet_fixture():
            sql("update khub_bot.closet_transfers set state='moved' where state<>'moved';update khub_bot.closet_soft_retries set status='review' where status in ('approved','ready','claimed');")
        def stable_soft_window(d,legacy_mode=False,failed_read=False,baseline='1000'):
            field='created_at' if legacy_mode else 'armed_at'
            sql("update khub_bot.closet_recovery_attempts set "+field+"=clock_timestamp()-interval '5 minutes 5 seconds',deadline=clock_timestamp()-interval '1 second' where attempt='"+d['attempt']+"';")
            for minute in range(4,0,-1):
                snapshot={'closet':baseline,'inventory':'8999999999999300'}
                if failed_read and minute==1:snapshot={'read_failed':True}
                sql("insert into khub_bot.closet_recovery_observations(check_id,attempt,observed_at,snapshot,outcome) values('"+str(uuid4())+"','"+d['attempt']+"',clock_timestamp()-interval '"+str(minute)+" minutes',"+lit(json.dumps(snapshot))+"::jsonb,'watching');")
            return due_for(d)
        clear_closet_fixture()
        d=recovery_claim();arm(d);uncertain(d)
        check=stable_soft_window(d)
        assert observe(d,check)['status']=='soft_retry'
        assert observe(d,check)['status']=='soft_retry' # replay is not a second allowance
        assert sql("select count(*) from khub_bot.closet_soft_retries where transfer_id='"+d['id']+"';")=='1'
        assert sql("select state from khub_bot.closet_transfers where id='"+d['id']+"';")=='pending'
        # Old claims cannot bypass the fresh pre-retry check.
        assert sql('select public.bot_claim_closet_transfer('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');")==''
        retry=json.loads(sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');"))
        assert retry['id']==d['id'] and retry['attempt']!=d['attempt'] and retry['soft_retry'] is True
        arm(retry);uncertain(retry)
        check=stable_soft_window(retry)
        assert observe(retry,check)['status']=='review'
        assert 'Soft retry 1/1' in sql("select reason from khub_bot.closet_recovery_attempts where attempt='"+retry['attempt']+"';")
        assert sql("select state from khub_bot.closet_transfers where id='"+retry['id']+"';")=='unknown'
        assert sql("select count(*) from khub_bot.closet_soft_retries where transfer_id='"+d['id']+"';")=='1'
        print('PASS: five stable readable checks approve exactly one soft retry; replay/restart do not replenish allowance; second failure stops for review')
        clear_closet_fixture()
        d=recovery_claim();arm(d);uncertain(d);assert observe(d,stable_soft_window(d))['status']=='soft_retry'
        # Original transfer completes just before a new claim: no retry submitted.
        late_snapshot={**big_snapshot,'closetMeat':'1700'}
        assert sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(late_snapshot))+"::jsonb,0,0,'{}');")==''
        assert sql("select state from khub_bot.closet_transfers where id='"+d['id']+"';")=='moved'
        assert sql("select status from khub_bot.closet_soft_retries where transfer_id='"+d['id']+"';")=='cancelled'
        assert sql("select retry_attempt is null from khub_bot.closet_soft_retries where transfer_id='"+d['id']+"';")=='t'
        clear_closet_fixture()
        d=recovery_claim();arm(d);uncertain(d);assert observe(d,stable_soft_window(d))['status']=='soft_retry'
        partial_snapshot={**big_snapshot,'closetMeat':'1350'}
        assert sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(partial_snapshot))+"::jsonb,0,0,'{}');")==''
        assert sql("select status from khub_bot.closet_soft_retries where transfer_id='"+d['id']+"';")=='review'
        assert sql("select state from khub_bot.closet_transfers where id='"+d['id']+"';")=='unknown'
        print('PASS: fresh late-completion check cancels retry; partial changes quarantine it without an extra deposit')
        clear_closet_fixture()
        d=recovery_claim();arm(d);uncertain(d);check=stable_soft_window(d,failed_read=True)
        assert observe(d,check)['status']=='watching'
        assert sql("select count(*) from khub_bot.closet_soft_retries where transfer_id='"+d['id']+"';")=='0'
        clear_closet_fixture()
        sql("select khub_bot.queue_closet('soft-legacy','sale_fee',null,null,700,'[]');")
        legacy_soft=json.loads(sql('select public.bot_claim_closet_transfer('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');"))
        uncertain(legacy_soft)
        sql('select public.bot_due_closet_recovery();')
        assert observe(legacy_soft,stable_soft_window(legacy_soft,legacy_mode=True))['status']=='soft_retry'
        print('PASS: failed reads do not authorize a retry; legacy attempts can use the explicitly authorized soft policy after fresh stable observations')
        clear_closet_fixture()
        d=recovery_claim();arm(d);uncertain(d);assert observe(d,stable_soft_window(d))['status']=='soft_retry'
        # Reserve checks remain enforced and approval rolls back on failure.
        poor={**big_snapshot,'meat':'0'}
        assert sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(poor))+"::jsonb,0,0,'{}');")==''
        assert sql("select status from khub_bot.closet_soft_retries where transfer_id='"+d['id']+"';")=='approved'
        protected=int(json.loads(sql('select public.bot_liabilities();'))['meat'])
        only_one_free={**big_snapshot,'meat':str(protected+700)}
        assert sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(only_one_free))+"::jsonb,0,0,'{}');")==''
        retry=json.loads(sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');"))
        sql("update khub_bot.closet_soft_retries set revalidated_at=clock_timestamp()-interval '11 seconds' where transfer_id='"+d['id']+"';")
        sql("select public.bot_arm_closet_transfer('"+retry['id']+"','"+retry['attempt']+"');",error='snapshot is stale')
        sql("select public.bot_release_unsubmitted_closet('"+retry['id']+"','"+retry['attempt']+"');")
        fresh_retry=json.loads(sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(big_snapshot))+"::jsonb,0,0,'{}');"))
        assert fresh_retry['soft_retry'] is True and fresh_retry['attempt']!=retry['attempt']
        arm(fresh_retry)
        sql("select public.bot_ack_closet_transfer('"+fresh_retry['id']+"','"+fresh_retry['attempt']+"',true,'local confirmed soft retry');")
        assert sql("select status from khub_bot.closet_soft_retries where transfer_id='"+d['id']+"';")=='completed'
        assert sql("select count(*) from khub_bot.closet_soft_retries where transfer_id='"+d['id']+"';")=='1'
        print('PASS: soft retry retains escrow/reserve protections; stale snapshot prevents submission; a known non-submission can refresh without spending another physical retry')
        clear_closet_fixture()
        sql("select khub_bot.queue_closet('soft-item','sale_fee',null,null,0,'[{\"id\":900003,\"quantity\":3}]');")
        one_item_stack={**big_snapshot,'items':{'900003':'3'},'closetItems':{'900003':'5'}}
        item_soft=json.loads(sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(one_item_stack))+"::jsonb,0,0,'{}');"))
        arm(item_soft);uncertain(item_soft)
        check=stable_soft_window(item_soft,baseline='5')
        assert observe(item_soft,check,'5','3')['status']=='soft_retry'
        item_retry=json.loads(sql('select public.bot_claim_closet_transfer_v2('+lit(json.dumps(one_item_stack))+"::jsonb,0,0,'{}');"))
        assert item_retry['soft_retry'] is True and item_retry['quantity']==3
        arm(item_retry)
        sql("select public.bot_ack_closet_transfer('"+item_retry['id']+"','"+item_retry['attempt']+"',true,'confirmed item soft retry');")
        assert sql("select status from khub_bot.closet_soft_retries where transfer_id='"+item_soft['id']+"';")=='completed'
        print('PASS: item transfers receive the same one-time soft retry; an unprotected single owned stack does not require unrelated extra items')
    finally:
        if started:pg('-m','immediate','stop')
