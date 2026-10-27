"""Giftable catalog eligibility and preserved financial flows against all migrations.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/giftable_catalog_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-giftable-catalog-',dir='/tmp') as folder:
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
        catalog_path=ROOT/'bot/catalog/items.json'
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
        seller,_=account(89601,48889601,'Receipt Seller')
        buyer,_=account(89602,48889602,'Receipt Buyer')
        other,_=account(89603,48889603,'Receipt Other')
        from concurrent.futures import ThreadPoolExecutor
        from datetime import datetime,timezone
        def call(query,uid=buyer,error=None):return sql('set role authenticated;'+query,uid,error)
        ids=iter(range(99600,99999))
        def stamp(epoch):return datetime.fromtimestamp(epoch,timezone.utc).isoformat()
        def create(escrow=False,buyout=None):
            return call(f"select public.create_auction('seal tooth',1,100,24,null,{buyout or 'null'},2,{'true' if escrow else 'false'});",seller)
        def row(ident):return json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{ident}';"))
        def events(ident):return json.loads(sql(f"select coalesce(jsonb_agg(to_jsonb(e) order by recorded_at,bid_id),'[]') from khub_bot.auction_bid_extensions e where auction_id='{ident}';"))
        def bid(ident,amount,uid=buyer,error=None):return call(f"select public.place_bid('{ident}',{amount});",uid,error)
        def mail(ident,kind,meat=0,quantity=0,actor=48889602,received=None,mid=None):
            if received is None:received=int(sql('select floor(extract(epoch from clock_timestamp()))::bigint;'))
            mid=str(mid or next(ids))
            return {'id':mid,'sender_id':actor,'sender_name':'Timing fixture','received_at':stamp(received),'command':{'type':kind,'auction_id':ident},
                'meat':meat,'items':[{'id':2,'quantity':quantity}] if quantity else [],
                'raw':{'id':mid,'fromid':str(actor),'fromname':'Timing fixture','type':'normal','message':kind.upper()+' '+ident,'azunixtime':str(received)}}
        def ingest(m,error=None):return sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(m))+');',error=error)
        def stage(mails):
            scan=json.loads(sql('select public.bot_begin_inbox_scan();'))['id']
            sql(f"select public.bot_stage_inbox_scan('{scan}',"+lit(json.dumps(mails))+');')
            return scan
        def funded():
            ident=create(True)
            assert ingest(mail(ident,'list',quantity=1,actor=48889601))=='accepted'
            return ident
        def set_end(ident,expr):
            sql(f"update public.auctions set created_at=clock_timestamp()-interval '2 days',end_time={expr},item_escrowed_at=case when escrow_mode then clock_timestamp()-interval '1 day' else item_escrowed_at end where id='{ident}';")
        available=json.loads(sql('select public.read_item_catalog();'))['items']
        expected=sorted(i['id'] for i in catalog if (i['tradeable'] or i.get('giftable',False)) and not i.get('is_gift_package',False))
        assert [i['id'] for i in available]==expected
        for item_id in [3116,11494,1511,3948]:
            item=next(i for i in available if i['id']==item_id)
            assert item['giftable'] and not item['tradeable']
            for escrow in [False,True]:
                aid=call('select public.create_auction('+lit(item['name'])+f",2,100,24,null,null,{item_id},{str(escrow).lower()});",seller)
                assert row(aid)['item_id']==item_id
            aid=call('select public.create_auction('+lit(item['name'])+f",2,100,24,null,null,{item_id},true,clock_timestamp()+interval '1 day');",seller)
            assert row(aid)['custom_end_at'] is not None
            buy=call(f"select public.create_buy_auction({item_id},2,100,24,'finished');",seller)
            assert row(buy)['auction_kind']=='buy'
        print('PASS: all four requested gift collectibles can create Direct, Escrow, custom-ending Sell and Buy auctions')

        packages=[i for i in catalog if i.get('is_gift_package')]
        assert len(packages)>=21
        for item in packages+[next(i for i in catalog if i['id']==43)]:
            assert not any(i['id']==item['id'] for i in available)
            call('select public.create_auction('+lit(item['name'])+f",1,100,24,null,null,{item['id']},false);",seller,error='Gift packages')
            call(f"select public.create_buy_auction({item['id']},1,100,24,'finished');",seller,error='Gift packages')
        print(f'PASS: all {len(packages)} package types and a quest-only item are denied by the server as well as omitted from the catalog')

        # Ordinary KMail is sufficient for gift items. No special-case transport,
        # new wrapping charge, or change to deposit validation is introduced.
        aid=call("select public.create_auction('stuffed Hodgman',2,100,24,null,null,3116,true);",seller)
        deposit=mail(aid,'list',quantity=2,actor=48889601)
        deposit['items'][0]['id']=3116
        assert ingest(deposit)=='accepted' and row(aid)['status']=='active'
        bid_mail=mail(aid,'bid',200)
        stage([bid_mail]);assert ingest(bid_mail)=='accepted'
        assert ingest(bid_mail)=='duplicate'
        set_end(aid,"clock_timestamp()-interval '120 seconds'")
        scan=stage([])
        sql(f"select public.bot_finish_inbox_scan('{scan}');select public.bot_tick();")
        assert row(aid)['status']=='settling'
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{aid}' and item_id=3116 and quantity=2 and kind='sale_item';")=='1'
        print('PASS: ordinary-KMail gift-item deposit, bid deduplication and escrow settlement queue the exact collectible quantity once')

        buy=call("select public.create_buy_auction(1511,4,200,24,'finished');",seller)
        funding=int(sql(f"select funding_required from khub_bot.buy_orders where auction_id='{buy}';"))
        assert ingest(mail(buy,'fund',funding,actor=48889601))=='accepted'
        reservation=json.loads(call(f"select public.reserve_buy_quantity('{buy}',2);"))
        fill=mail(buy,'fill',quantity=2)
        fill['items'][0]['id']=1511
        fill['command']['reservation_id']=reservation['id']
        stage([fill]);assert ingest(fill)=='accepted' and ingest(fill)=='duplicate'
        assert sql(f"select purchased_quantity from khub_bot.buy_orders where auction_id='{buy}';")=='2'
        assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{fill['id']}' and kind='sale_meat';")=='400'
        # Finished-mode orders hold partial purchases until closing, as before.
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{buy}' and item_id=1511;")=='0'
        call(f"select public.cancel_auction('{buy}');",seller)
        assert sql(f"select sum(quantity) from khub_bot.deliveries where auction_id='{buy}' and item_id=1511;")=='2'
        print('PASS: Buy reservation and partial fulfillment pay the full seller amount and create one gift-item obligation without duplication')

        # Invalid reference metadata cannot partially replace the good snapshot.
        before=sql('select public.read_item_catalog();')
        bad=[dict(i) for i in catalog]
        bad[0]['giftable']='true'
        sql('select public.bot_replace_item_catalog('+lit(json.dumps(bad))+",now(),repeat('b',64));",error='Invalid gift eligibility metadata')
        assert before==sql('select public.read_item_catalog();')
        missing_package=[dict(i) for i in catalog]
        del missing_package[0]['is_gift_package']
        sql('select public.bot_replace_item_catalog('+lit(json.dumps(missing_package))+",now(),repeat('b',64));",error='Invalid gift eligibility metadata')
        assert before==sql('select public.read_item_catalog();')
        for role in ['anon','authenticated']:
            sql('set role '+role+";select public.bot_replace_item_catalog('[]',now(),repeat('a',64));",error='permission denied')
        print('PASS: malformed imports roll back atomically and public users cannot alter eligibility')

        # Old bot snapshots contain neither new flag. They remain importable,
        # but cannot accidentally grant gift/package eligibility. Existing
        # auctions, receipts and transfer obligations must survive either import.
        ledger=sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')
        legacy=[{k:v for k,v in i.items() if k not in ('giftable','is_gift_package')} for i in catalog]
        sql('select public.bot_replace_item_catalog('+lit(json.dumps(legacy))+",now(),repeat('c',64));")
        assert not any(i['id']==3116 for i in json.loads(sql('select public.read_item_catalog();'))['items'])
        sql('select public.bot_replace_item_catalog('+lit(json.dumps(catalog))+",now(),repeat('d',64));")
        assert any(i['id']==3116 for i in json.loads(sql('select public.read_item_catalog();'))['items'])
        assert ledger==sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')
        assert row(aid)['status']=='settling'
        print('PASS: old catalog imports fail closed for gift eligibility; refreshed metadata restores it without altering financial obligations')
    finally:
        if started:pg('-m','fast','-w','stop')
