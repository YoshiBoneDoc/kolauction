"""Mr. A Direct creation, bidding, buyouts, authorization and bot notices.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/mr_a_payments_database_test.py
"""
import json
from datetime import datetime, timezone
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
        
        read_probe="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','khub_bot') and p.prokind='f' and (p.proname like 'read_%' or p.proname in ('bot_tick','bot_finish_inbox_scan','finalize_auction','finalize_expired_auctions','bot_worker_status')) and p.proname<>'read_public_auction_live_batch';"""
        for migration in migrations:
            if '193_automatic' in migration.name: before_reads=sql(read_probe)
            sql(migration.read_text())
            if '193_automatic' in migration.name:
                assert sql(read_probe)==before_reads, 'Relisting changed browsing, polling or finalization entry points'
        # Capture webhook payloads locally, without network or credentials.
        sql("""create schema net;
            create table net.test_requests(body jsonb);
            create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin insert into net.test_requests values(body);return 1;end;$$;
            insert into khub_bot.public_cache_webhook_config values(true,'https://fixture.invalid/api/public-auctions/invalidate',repeat('a',64));""")
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
        owner=account(99001,48889901,'Relist Seller')
        other=account(99002,48889902,'Relist Buyer')
        third=account(99003,48889903,'Mixed Bidder')
        def quote(age='1 minute', available=True, price=70000000):
            sql(f"insert into khub_bot.market_prices values(194,{price},now()-interval '{age}',now()-interval '{age}',{str(available).lower()}) on conflict(item_id) do update set price_meat=excluded.price_meat,observed_at=excluded.observed_at,checked_at=excluded.checked_at,available=excluded.available;")
        def create(rate=70000000, uid=owner, error=None, **extra):
            listing={'item':'seal tooth','itemId':2,'quantity':1,'minBidMeat':1000000,'auctionTime':'24',
                     'instantPurchasePrice':150000000,'escrowMode':False,**extra}
            return sql('set role authenticated;select public.create_mr_a_auction('+lit(json.dumps(listing))+f'::jsonb,{rate});',uid,error)
        def state(aid): return json.loads(sql(f"select row_to_json(a) from public.auctions a where id='{aid}';"))
        def bid(aid,m,q,uid=other,error=None):
            return sql(f"set role authenticated;select public.place_mixed_bid('{aid}',{m},{q});",uid,error)
        quote()
        aid=create()
        a=state(aid)
        assert a['mr_a_rate']==70000000 and a['mr_a_reference']==70000000
        assert a['payment_mr_a']==0 and a['current_bid']==0
        # Frozen terms cannot be changed, even by a privileged accidental write.
        sql(f"update public.auctions set mr_a_rate=71000000 where id='{aid}';",error='immutable')
        sql(f"update public.auctions set mr_a_observed_at=now() where id='{aid}';",error='immutable')
        create(rate=66000000,error='within 5 percent')
        create(rate=74000000,error='within 5 percent')
        create(rate=66500000);create(rate=73500000)
        create(escrowMode=True,error='not enabled')
        create(auctionKind='buy',error='Direct Sell')
        create(giveawayTitle='No',error='Direct Sell')
        create(autoRelist=True,error='Direct Sell')
        # Missing/unavailable/stale/future references fail; no partial listing remains.
        before=int(sql('select count(*) from public.auctions;'))
        for age,available in [('27 hours',True),('1 minute',False),('-1 minute',True)]:
            quote(age,available);create(error='fresh Mr. A')
        sql('delete from khub_bot.market_prices where item_id=194;')
        create(error='fresh Mr. A')
        assert int(sql('select count(*) from public.auctions;'))==before
        quote()
        # Existing auctions retain their rate after market changes or staleness.
        quote('27 hours',True,90000000)
        bid(aid,6000000,1)
        a=state(aid)
        assert (a['current_bid'],a['payment_meat'],a['payment_mr_a'])==(76000000,6000000,1)
        assert a['mr_a_rate']==70000000
        bid(aid,7000000,1,error='highest bidder')
        bid(aid,0,1,third,error='at least')
        bid(aid,0,2,owner,error='own auction')
        bid(aid,-1,2,third,error='nonnegative')
        bid(aid,1,9007199254740991,third,error='Invalid payment value')
        bid(aid,0,3,third,error='exceeds the buyout')
        assert state(aid)['current_bid']==76000000
        # Legacy Meat-only bids reset the actual composition without losing history.
        sql(f"set role authenticated;select public.place_bid('{aid}',80000000);",third)
        assert state(aid)['payment_meat']==80000000 and state(aid)['payment_mr_a']==0
        bid(aid,0,2)
        assert state(aid)['current_bid']==140000000 and state(aid)['payment_meat']==0
        # History retains each original payment and private bidder rules.
        history=json.loads(sql(f"set role authenticated;select public.read_auction_bid_history('{aid}');",owner))
        assert [(b['payment_meat'],b['payment_mr_a']) for b in history['bids']]==[(6000000,1),(80000000,0),(0,2)]
        live=json.loads(sql(f"set role anon;select public.read_public_auction_live_batch(array['{aid}'::uuid]);"))['rows'][0]
        assert live['mr_a_rate']==70000000 and live['payment_mr_a']==2 and live['payment_meat']==0
        assert not any('bidder' in key for key in live)
        detail=json.loads(sql(f"set role anon;select public.read_public_auction_detail_state('{aid}');"))['rows'][0]
        assert detail['mr_a_rate']==70000000 and detail['payment_mr_a']==2
        # Buyout trims only Meat, preserves all Mr. A's, and replay cannot alter it.
        bid(aid,20000000,2,third)
        a=state(aid)
        assert a['status']=='awaiting_trade' and a['final_price']==150000000
        assert (a['payment_meat'],a['payment_mr_a'])==(10000000,2)
        count=int(sql(f"select count(*) from public.bids where auction_id='{aid}';"))
        bid(aid,20000000,2,third)
        assert int(sql(f"select count(*) from public.bids where auction_id='{aid}';"))==count
        bid(aid,80000000,1,third,error='closed')
        assert state(aid)['payment_mr_a']==2
        notices=json.loads(sql(f"select jsonb_agg(display_message) from khub_bot.deliveries where auction_id='{aid}' and dedupe_key like 'direct-trade-reminder:%';"))
        assert len(notices)==2 and all('2 Mr. A(s) + 10,000,000 Meat (150,000,000 Meat value)' in body for body in notices),notices
        # Direct trading never creates escrow asset obligations.
        assert int(sql(f"select count(*) from khub_bot.deliveries where auction_id='{aid}' and (meat>0 or quantity>0);"))==0
        # Authentication grants and table writes do not expose composition mutation.
        sql(f"set role anon;select public.place_mixed_bid('{aid}',1,1);",error='permission denied')
        sql(f"set role authenticated;update public.auctions set payment_mr_a=0 where id='{aid}';",other,error='permission denied')
        sql(f"set role authenticated;update public.bids set payment_mr_a=0 where auction_id='{aid}';",other,error='permission denied')
        quote()
        # Unsupported/legacy auction kinds cannot acquire mixed bids.
        plain=sql("select public.create_auction('seal tooth',1,1000000,24,null,null,2,false);",owner)
        bid(plain,0,1,error='does not accept')
        sql(f"set role authenticated;select public.place_bid('{plain}',1000000);",other)
        assert state(plain)['current_bid']==1000000 and state(plain)['mr_a_rate'] is None
        expired=create()
        sql(f"update public.auctions set created_at=now()-interval '1 day',end_time=now()-interval '1 minute' where id='{expired}';")
        bid(expired,0,1,error='ended')
        held=create()
        sql(f"update public.auctions set status='on_hold' where id='{held}';")
        bid(held,0,1,error='administrator review')
        # Bundle creation also validates and freezes terms atomically.
        bundle=create(bundleItems=[{'id':2,'quantity':2},{'id':194,'quantity':1}])
        bid(bundle,6000000,1)
        assert state(bundle)['payment_mr_a']==1 and len(state(bundle)['bundle_items'])==2
        # Same item as the lot is still just a Direct obligation, not a deposit.
        same=create(item='Mr. Accessory',itemId=194)
        bid(same,0,1)
        assert state(same)['payment_mr_a']==1
        print('Mr. A Direct database regressions passed')
    finally:
        if started: pg('-m','immediate','-w','stop')
