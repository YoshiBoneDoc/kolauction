"""Mixed-asset escrow accounting, intake, settlement, delivery and recovery.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/mr_a_escrow_database_test.py
"""
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
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
        
        read_probe="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','khub_bot') and p.prokind='f' and (p.proname like 'read_%' or p.proname in ('bot_tick','bot_finish_inbox_scan','finalize_auction','finalize_expired_auctions','bot_worker_status')) and p.proname<>'read_public_auction_live_batch';"""
        for migration in migrations:
            if '193_automatic' in migration.name: before_reads=sql(read_probe)
            if '265_leaderboard_alt' in migration.name:
                sql("set session_replication_role=replica;insert into public.profiles(id,khub_username,kol_player_id,kol_player_name,kol_verified_at) values('00000000-0000-0000-0000-000000000099','FixtureAlt',99999999,'Anrath1',now());set session_replication_role=origin;")
            if '269_escrow_fee_engine' in migration.name:
                sql("insert into khub_bot.promotional_escrow_volume values('sell:historical','00000000-0000-0000-0000-000000000099',19000000,0,now());")
                preserved_volume=sql('select jsonb_agg(to_jsonb(v)) from khub_bot.promotional_escrow_volume v;')
            sql(migration.read_text())
            if '269_escrow_fee_engine' in migration.name:
                assert preserved_volume==sql('select jsonb_agg(to_jsonb(v)) from khub_bot.promotional_escrow_volume v;')
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

        assert sql('select enabled from khub_bot.fee_engine_state;')=='f'
        def quote(price,quantity=1,kind='sell',actor=owner):
            return json.loads(sql(f"set role authenticated;select public.escrow_fee_quote({price},{quantity},'{kind}');",actor))
        assert quote(10000000)['fee']=='0'
        sql('set role authenticated;select public.activate_escrow_fee_engine();',owner,'permission denied')
        old_buy=sql("set role authenticated;select public.create_buy_auction(2,1,4000000,24,'immediate');",owner)
        old_funding=sql(f"select funding_required from khub_bot.buy_orders where auction_id='{old_buy}';")
        sql('set role service_role;select public.activate_escrow_fee_engine();')
        assert sql(f"select funding_required from khub_bot.buy_orders where auction_id='{old_buy}';")==old_funding
        assert sql(f"select legacy from khub_bot.auction_fee_terms where auction_id='{old_buy}';")=='t'
        assert quote(10000000)['engine_enabled']
        assert quote(10000000)['promotion']['name']=='Giving Thanks: November Promotion'
        def buy(price=4000000,qty=2):
            return sql(f"set role authenticated;select public.create_buy_auction(2,{qty},{price},24,'immediate');",owner)
        def sell():
            return sql("set role authenticated;select public.create_auction('seal tooth',1,10000000,24,null,null,2,true);",owner)
        aid=buy()
        assert sql(f"select funding_required from khub_bot.buy_orders where auction_id='{aid}';")=='8400000'
        def settle(aid,key,amount,original=999999999,free=False):
            return int(sql(f"select khub_bot.settle_locked_escrow_fee('{aid}','{key}','{owner}',{amount},{original},{str(free).lower()});"))
        assert settle(aid,'buy:first',19000000)==0
        assert settle(aid,'buy:cross',2000000)==0
        assert settle(aid,'buy:paid',100000000)==2000000
        assert settle(aid,'buy:paid',100000000)==2000000
        assert settle(aid,'buy:free-cohort',1000000,free=True)==0
        sql(f"select khub_bot.settle_locked_escrow_fee('{aid}','buy:paid','{owner}',100000001,999999999);",error='identity changed')
        sql(f"insert into khub_bot.loyalty_accounts values('{owner}',3000000000,4) on conflict(user_id) do update set volume=3000000000,tier=4;")
        diamond=buy(10000000,1)
        assert settle(diamond,'buy:diamond',100000000)==1000000

        # Rates at every bracket boundary; no progressive normal calculation.
        expected=[[500,400,300,200],[400,300,250,150],[300,250,200,125],[250,200,150,100],[200,150,100,50]]
        for tier,rates in enumerate(expected):
            for amount,index in [(9999999,0),(10000000,1),(99999999,1),(100000000,2),(999999999,2),(1000000000,3)]:
                assert int(sql(f"select khub_bot.flat_band_fee({amount},khub_bot.fee_bands(bps)) from khub_bot.loyalty_rates where tier={tier};"))==amount*rates[index]//10000
        sql(f"insert into khub_bot.leaderboard_totals values('{other}',1000,100,1000),('{owner}',100,10,100) on conflict(profile_id) do update set volume=excluded.volume,trades=excluded.trades,donated=excluded.donated;")
        assert quote(100000000)['eligibility']['top3']
        ranked=buy(100000000,1)
        sql(f"insert into public.player_ignores(user_id,kol_player_id) select '{owner}',kol_player_id from public.profiles where id='{other}';")
        assert not quote(100000000)['eligibility']['donor']
        boards=json.loads(sql('set role authenticated;select public.read_leaderboards();',owner))
        assert boards['volume'][0]['id']==owner and boards['volume'][0]['rank']==2
        assert boards['fee_eligibility']['top3'] and not boards['fee_eligibility']['leader']
        sql(f"delete from public.player_ignores where user_id='{owner}';delete from khub_bot.leaderboard_totals where profile_id in ('{owner}','{other}');")
        assert settle(ranked,'buy:lost-rank',100000000)==750000
        assert quote(100000000)['normal_fee']=='1000000'
        # Top donor wins over every normal benefit and November's paid rate.
        sql(f"insert into khub_bot.leaderboard_totals values('{owner}',0,0,1);")
        donor=buy(100000000,1)
        assert settle(donor,'buy:donor',100000000)==0
        sql(f"delete from khub_bot.leaderboard_totals where profile_id='{owner}';")
        # Configured future promotion is a draft; preview has no live side effects.
        sql(f"insert into khub_bot.administrators(user_id,note) select id,'Fixture' from public.profiles where id='{owner}';")
        config={'name':'Future test','description':'Fixture','mode':'lower','tiers':[0,1,2,3,4],'allowance':'0','donor_waiver':True,'sell':[{'from':0,'bps':25}],'buy':[{'from':0,'bps':30}],'info_message':'','form_message':''}
        def admin(action,ident=None,revision=None,config=None,confirmation=None,request=None):
            args={'p_action':action,'p_id':ident,'p_revision':revision,'p_config':config,'p_confirmation':confirmation,'p_request':request or str(uuid4())}
            values=','.join(k+'=>'+('null' if v is None else lit(json.dumps(v))+'::jsonb' if isinstance(v,dict) else str(v) if isinstance(v,int) else lit(v)) for k,v in args.items())
            return json.loads(sql('set role authenticated;select public.admin_escrow_promotions('+values+');',owner))
        draft=admin('save',config=config)
        preview=admin('preview',draft['id'])
        assert len(preview['examples'])>=200 and preview['conflicts']
        assert 'Future test' in preview['messages']['info']
        sql('set role authenticated;select public.admin_escrow_promotions();',other,'Administrator')
        # Existing November cannot silently be replaced.
        sql(f"set role authenticated;select public.admin_escrow_promotions('publish','{draft['id']}',1,null,null,null,{lit(preview['confirmation'])},'{uuid4()}');",owner,'Conflicts')
        rows=admin('read')['promotions'];nov=next(p for p in rows if p['legacy'])
        admin('end',nov['id'],nov['revision'],confirmation='CONFIRM')
        assert quote(10000000)['enabled'] is False
        # November is intentionally settlement-time; future promotions are pinned.
        assert settle(diamond,'buy:after-nov',100000000)==1000000
        published=admin('publish',draft['id'],draft['revision'],confirmation=preview['confirmation'])
        pinned=buy(10000000,2)
        assert settle(pinned,'buy:pinned-first',10000000)==30000
        admin('end',published['id'],published['revision'],confirmation='CONFIRM')
        assert settle(pinned,'buy:pinned-after-end',10000000)==30000
        assert not quote(10000000)['enabled']


        # Replacement can explicitly override normal discounts, with safe reserves.
        replacement={**config,'mode':'replace','donor_waiver':False,'buy':[{'from':0,'bps':700}]}
        d=admin('save',config=replacement);pr=admin('preview',d['id'])
        pub=admin('publish',d['id'],d['revision'],confirmation=pr['confirmation'])
        expensive=buy(4000000,2)
        assert int(sql(f"select funding_required from khub_bot.buy_orders where auction_id='{expensive}';"))==8560000
        assert settle(expensive,'buy:replacement',4000000)==280000
        admin('cancel',pub['id'],pub['revision'],confirmation='CONFIRM')
        assert settle(expensive,'buy:replacement-cancelled',4000000)==280000
        # Preview, drafts and validation failures must never write live balances.
        before=sql('select jsonb_agg(to_jsonb(v)) from khub_bot.promotional_escrow_volume v;')
        invalid={**config,'name':None}
        sql('select khub_bot.validate_promotion('+lit(json.dumps(invalid))+');',error='Invalid promotion')
        assert sql('select jsonb_agg(to_jsonb(v)) from khub_bot.promotional_escrow_volume v;')==before
        # Shared allowance is serialized under concurrent independent connections.
        shared={**config,'allowance':'20000000','sell':[{'from':0,'bps':100}],'buy':[{'from':0,'bps':100}]}
        d=admin('save',config=shared);pr=admin('preview',d['id']);pub=admin('publish',d['id'],d['revision'],confirmation=pr['confirmation'])
        concurrent=buy(20000000,4)
        def race(i):return settle(concurrent,'buy:race-'+str(i),20000000)
        with ThreadPoolExecutor(max_workers=4) as pool: fees=list(pool.map(race,range(4)))
        assert sorted(fees)==[0,200000,200000,200000],fees
        admin('end',pub['id'],pub['revision'],confirmation='CONFIRM')
        # Scheduling and expiration are timestamp predicates, not UI jobs.
        d=admin('save',config=config)
        future=sql("select (clock_timestamp()+interval '1 day')::text;")
        d=json.loads(sql(f"set role authenticated;select public.admin_escrow_promotions('save','{d['id']}',1,"+lit(json.dumps(config))+f",'{future}',null,null,'{uuid4()}');",owner))
        pr=admin('preview',d['id']);pub=admin('publish',d['id'],d['revision'],confirmation=pr['confirmation'])
        assert not quote(10000000)['enabled']
        assert sql("select khub_bot.live_escrow_promotion(clock_timestamp()+interval '2 days');")==pub['id']
        admin('cancel',pub['id'],pub['revision'],confirmation='CONFIRM')
        assert settle(old_buy,'buy:legacy-fallback',4000000,170000)==170000
        # Real receipt/reservation/settlement paths, with no game/network calls.
        mail_seq=200000
        def mail(ident,cmd,actor=owner,meat=0,qty=0):
            global mail_seq
            mail_seq+=1
            stamp=json.loads(sql("select jsonb_build_object('received_at',date_trunc('second',t),'epoch',floor(extract(epoch from t))::bigint) from (select clock_timestamp() t) clock;"))
            return {'id':str(mail_seq),'sender_id':int(sql(f"select kol_player_id from public.profiles where id='{actor}';")),
                'sender_name':'Fixture sender','received_at':stamp['received_at'],'meat':meat,
                'command':{'type':cmd,'auction_id':ident},'items':([{'id':2,'quantity':qty}] if qty else []),'raw':{'type':'normal','azunixtime':str(stamp['epoch'])}}
        def ingest(payload):
            if payload['command']['type'] in ('fill','bid','buy'):
                scan=json.loads(sql('select public.bot_begin_inbox_scan();'))
                sql(f"select public.bot_stage_inbox_scan('{scan['id']}',"+lit(json.dumps([payload]))+');')
            return sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(payload))+');')
        real=buy(4000000,10)
        required=int(sql(f"select funding_required from khub_bot.buy_orders where auction_id='{real}';"))
        assert required==40800000
        assert ingest(mail(real,'fund',meat=required))=='accepted'
        def fill(ident,qty):
            res=json.loads(sql(f"set role authenticated;select public.reserve_buy_quantity('{ident}',{qty});",other))
            payload=mail(ident,'fill',actor=other,qty=qty);payload['command']['reservation_id']=res['id']
            assert ingest(payload)=='accepted'
            assert ingest(payload)=='duplicate'
        fill(real,1);fill(real,9)
        accounting=json.loads(sql(f"select to_jsonb(o) from khub_bot.buy_orders o where auction_id='{real}';"))
        assert accounting['commission_meat']==620000 and accounting['purchase_meat']==40000000
        assert accounting['funded_meat']==accounting['balance_meat']+accounting['purchase_meat']+accounting['commission_meat']+accounting['refunded_meat']
        sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where auction_id='{real}';select public.bot_tick();")
        assert int(sql(f"select coalesce(sum(meat),0) from khub_bot.deliveries where auction_id='{real}' and dedupe_key like 'buy-order-refund:%';"))==180000
        # Real Sell commission is deducted from proceeds, not charged to buyer.
        real_sell=sql("set role authenticated;select public.create_auction('seal tooth',1,1000000000,24,null,1000000000,2,true);",owner)
        assert ingest(mail(real_sell,'list',qty=1))=='accepted'
        sql(f"update public.auctions set created_at=now()-interval '10 minutes',item_escrowed_at=now()-interval '5 minutes' where id='{real_sell}';")
        purchase=mail(real_sell,'buy',actor=other,meat=1000000000)
        epoch=int(purchase['raw']['azunixtime'])-120
        purchase['raw']['azunixtime']=str(epoch);purchase['received_at']=datetime.fromtimestamp(epoch,timezone.utc).isoformat()
        assert ingest(purchase)=='accepted'
        sql(f"update public.auctions set created_at=now()-interval '10 minutes',end_time=now()-interval '1 minute' where id='{real_sell}';")
        scan=json.loads(sql('select public.bot_begin_inbox_scan();'))
        sql(f"select public.bot_stage_inbox_scan('{scan['id']}','[]');select public.bot_finish_inbox_scan('{scan['id']}');")
        sale=json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{real_sell}';"))
        assert sale['fee_meat']==5000000,sale
        assert int(sql(f"select sum(meat) from khub_bot.deliveries where auction_id='{real_sell}' and kind='sale_meat';"))==995000000

        # Mixed payment keeps the existing Meat cap and permanent waiver ledger.
        sql("insert into khub_bot.market_prices values(194,70000000,now()-interval '1 minute',now()-interval '1 minute',true);")
        sql('set role service_role;select public.set_mr_a_escrow_enabled(true);')
        listing={'item':'seal tooth','itemId':2,'quantity':1,'minBidMeat':140000000,'auctionTime':'24','instantPurchasePrice':140000000,'escrowMode':True}
        mixed=sql('set role authenticated;select public.create_mr_a_auction('+lit(json.dumps(listing))+',70000000);',owner)
        assert ingest(mail(mixed,'list',qty=1))=='accepted'
        sql(f"update public.auctions set created_at=now()-interval '10 minutes',item_escrowed_at=now()-interval '5 minutes' where id='{mixed}';")
        purchase=mail(mixed,'buy',actor=other);purchase['items']=[{'id':194,'quantity':2}]
        epoch=int(purchase['raw']['azunixtime'])-120
        purchase['raw']['azunixtime']=str(epoch);purchase['received_at']=datetime.fromtimestamp(epoch,timezone.utc).isoformat()
        assert ingest(purchase)=='accepted'
        scan=json.loads(sql('select public.bot_begin_inbox_scan();'))
        sql(f"select public.bot_stage_inbox_scan('{scan['id']}','[]');select public.bot_finish_inbox_scan('{scan['id']}');")
        mixed_state=json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{mixed}';"))
        assert mixed_state['calculated_fee_meat']==1400000 and mixed_state['fee_meat']==0 and mixed_state['waived_fee_meat']==1400000,mixed_state
        assert sql(f"select khub_bot.settle_mr_a_fee(a) from public.auctions a where id='{mixed}';")=='0'
        assert sql(f"select sum(quantity) from khub_bot.deliveries where auction_id='{mixed}' and kind='sale_meat' and item_id=194;")=='2'
        print('PASS fee engine: gate, November preservation, lower benefits, previews/conflicts, pinned promos, real partial Buy fills/reserves/refunds and Sell settlement')
    finally:
        if started: pg('-m','immediate','-w','stop')
