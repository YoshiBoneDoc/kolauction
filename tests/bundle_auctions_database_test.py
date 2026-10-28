"""Bundle auction financial safety against ALL local SQL migrations.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/bundle_auctions_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-bot-only-expiration-',dir='/tmp') as folder:
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
        for migration in migrations:
            sql(migration.read_text())
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
        def ingest(aid,kind,meat=0,items=None,actor=48889601):
            mid=str(next(ids))
            epoch=sql('select floor(extract(epoch from clock_timestamp()))::bigint;')
            received=sql(f'select to_timestamp({epoch});')
            payload={'id':mid,'sender_id':actor,'sender_name':'Bundle fixture','received_at':received,
                'command':{'type':kind,'auction_id':aid},'meat':meat,'items':items or [],
                'raw':{'id':mid,'fromid':str(actor),'fromname':'Bundle fixture','type':'normal','message':kind.upper()+' '+aid,'azunixtime':epoch}}
            if kind in ('bid','buy'):
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
        lot=create(buyout='5000');assert row(lot)['status']=='pending_escrow'
        frozen=row(lot)['bundle_items'];assert len(frozen)==2 and row(lot)['quantity']==1
        for wrong,meat,actor in [([{'id':2,'quantity':1}],0,48889601),([parts[0]],0,48889601),([*parts,{'id':1,'quantity':1}],0,48889601),(parts,1,48889601),(parts,0,48889602)]:
            mid,result,_=ingest(lot,'list',meat,wrong,actor)
            assert result!='accepted' and row(lot)['status']=='pending_escrow'
            assert quantities(f"receipt_id='{mid}'")=={str(p['id']):str(p['quantity']) for p in wrong}
        print('PASS: partial/extra/Meat/wrong-seller deposits fully refunded; no partial activation')
        baseline=json.loads(sql('select public.bot_liabilities();'))['items']
        mid,result,replay=ingest(lot,'list',items=parts);assert result=='accepted',result
        assert row(lot)['status']=='active'
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
        sql("insert into khub_bot.market_prices(item_id,price_meat,observed_at,checked_at,available) values(2,1000,clock_timestamp(),clock_timestamp(),true),(364,2000,clock_timestamp(),clock_timestamp(),true) on conflict(item_id) do update set price_meat=excluded.price_meat,available=true;")
        assert sql(f"select khub_bot.lot_market_value(a) from public.auctions a where id='{lot}';")=='13000'
        print('PASS: public/private/home projections, component search and full-lot market valuation')
        assert ingest(lot,'bid',200,actor=48889603)[1]=='accepted'
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
    finally:
        if started:pg('-m','immediate','stop')
