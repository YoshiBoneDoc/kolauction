"""Exercise tiered escrow fees and actual queued payouts against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/tiered_fees_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-fees-',dir='/tmp') as folder:
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
        fee_migration=next(p for p in migrations if p.name=='202610210069_tiered_escrow_fees.sql')
        for migration in migrations:
            if migration.name<fee_migration.name: sql(migration.read_text())
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
        seller,_=account(86901,4888901,'Fee Seller')
        buyer,_=account(86902,4888902,'Fee Buyer')
        mail_serial=iter(range(86910,89999))
        def send(lot,kind,amount=0):
            mid=str(next(mail_serial))
            sid=4888901 if kind=='list' else 4888902
            payload={'id':mid,'sender_id':sid,'sender_name':'Fee Seller' if kind=='list' else 'Fee Buyer',
                'received_at':'2026-10-22T12:00:00Z','command':{'type':kind,'auction_id':lot},'meat':amount,
                'items':[{'id':2,'quantity':3}] if kind=='list' else [],
                'raw':{'id':mid,'fromid':str(sid),'type':'normal','message':kind.upper()+' '+lot}}
            return sql('set role service_role; select public.bot_ingest_mail('+lit(json.dumps(payload))+');')
        def lot(buyout=None,escrow=True):
            ident=sql(f"select public.create_auction('seal tooth',3,1,24,null,{buyout if buyout is not None else 'null'},2,{'true' if escrow else 'false'});",seller)
            if escrow: assert send(ident,'list')=='accepted'
            return ident
        def drain():
            deliveries=[]
            while True:
                raw=sql('set role service_role; select public.bot_claim_delivery(2);')
                if not raw: break
                d=json.loads(raw);deliveries.append(d)
                sql(f"set role service_role; select public.bot_ack_delivery('{d['id']}','{d['attempt']}',true,'Isolated fixture send acknowledged; no KoL network used.');")
            return deliveries
        def close(ident):
            sql(f"update public.auctions set created_at=now()-interval '2 days',end_time=now()-interval '1 day' where id='{ident}'; select public.bot_tick();")
        def row(ident): return json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{ident}';"))
        def fees(ident): return int(sql(f"select coalesce(sum(meat),0) from khub_bot.closet_transfers where auction_id='{ident}' and source='sale_fee';"))
        def fingerprint():
            return {t:sql(f"select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') from {t} x;")
                for t in ['khub_bot.deliveries','khub_bot.closet_transfers','khub_bot.receipts','public.bids']}
        drain()
        historical=lot();assert send(historical,'bid',10000)=='accepted';close(historical);drain()
        assert row(historical)['fee_meat']==750
        finalized=lot();assert send(finalized,'bid',10000)=='accepted';close(finalized)
        open_standard=lot();assert send(open_standard,'bid',10000000)=='accepted'
        sql('update khub_bot.settings set fee_bps=200;')
        discounted=lot()
        sql('update khub_bot.settings set fee_bps=0;')
        free=lot()
        sql('update khub_bot.settings set fee_bps=750;')
        before=fingerprint();historical_before=row(historical);finalized_before=row(finalized)
        sql(fee_migration.read_text())
        for migration in migrations:
            if migration.name>fee_migration.name: sql(migration.read_text())
        assert fingerprint()==before,'Migration rewrote existing assets/messages/fees'
        assert {k:v for k,v in row(historical).items() if k!='fee_policy'}==historical_before
        assert {k:v for k,v in row(finalized).items() if k!='fee_policy'}==finalized_before
        assert row(historical)['fee_policy']==row(finalized)['fee_policy']=='flat'
        assert row(open_standard)['fee_policy']=='tiered_v1'
        assert row(discounted)['fee_policy']==row(free)['fee_policy']=='flat'
        duration_direct=sql("select public.create_auction('seal tooth',3,100,336,null,null,2,false);",seller)
        duration_escrow=sql("select public.create_auction('seal tooth',3,100,336,null,null,2,true);",seller)
        for ident in [duration_direct,duration_escrow]:
            assert sql(f"select duration_hours=336 and end_time-created_at=interval '336 hours' from public.auctions where id='{ident}';")=='t'
        assert send(duration_escrow,'list')=='accepted'
        assert sql(f"select status='active' and abs(extract(epoch from end_time-item_escrowed_at)-336*3600)<1 from public.auctions where id='{duration_escrow}';")=='t'
        for invalid in [335,337]:
            sql(f"select public.create_auction('seal tooth',3,100,{invalid},null,null,2,false);",seller,error='valid auction duration')
        sql(f"update public.auctions set duration_hours=337 where id='{duration_direct}';",error='auctions_duration_hours_check')
        print('PASS: 14-day Direct/Escrow auctions and exact 336-hour deposit-start timing; unsupported durations rejected by RPC and table constraint')
        print('PASS: migration preserves historical/finalized ledgers and frozen messages; open standard auctions switch to lower tiers; existing free/discounted terms stay intact')

        from fractions import Fraction
        def expected(price):
            widths=[1000000,9000000,90000000,900000000,price]
            denominators=[20,25,Fraction(100,3),50,100]
            total=Fraction(0);remaining=price
            for width,divisor in zip(widths,denominators):
                part=min(width,remaining);total+=Fraction(part)/divisor;remaining-=part
            return int(total)
        values=[0,1,19,20,21,99,999999,1000000,1000001,1000024,9999999,10000000,10000001,
            99999999,100000000,100000001,999999999,1000000000,1000000001,10000000000,9007199254740991]
        frontend=ROOT/'src/lib/escrowFees.js'
        if frontend.exists():
            preview_js="import {escrowFee} from "+json.dumps(frontend.as_uri())+"; console.log(JSON.stringify("+json.dumps(values)+".map(escrowFee)));"
            previews=json.loads(subprocess.check_output(['node','--input-type=module','-e',preview_js],text=True))
            assert previews==[expected(price) for price in values],'Website estimates diverge from the independent oracle'
        for price in values:
            actual=int(sql(f'select khub_bot.tiered_escrow_fee({price});'))
            assert actual==expected(price),(price,actual,expected(price))
            assert 0<=actual<=price
            if price<9007199254740991: assert int(sql(f'select khub_bot.tiered_escrow_fee({price+1});'))>=actual
        for invalid in ['null','-1','9007199254740992']:
            sql(f'select khub_bot.tiered_escrow_fee({invalid});',error='Invalid escrow sale price')
        for role in ['anon','authenticated']:
            sql(f'set role {role}; select khub_bot.tiered_escrow_fee(100);',error='permission denied')
            sql(f'set role {role}; update public.auctions set fee_meat=0;',error='permission denied')
        sql(f"update public.auctions set fee_policy='flat' where id='{open_standard}';",error='fixed')
        assert json.loads(sql('set role service_role; select public.bot_inspect();'))['escrowFeePolicy']['name']=='tiered_v1'
        print('PASS: independent rational-number oracle, every tier boundary, tiny/fractional rounding, monotonicity and maximum exact price; private calculators and immutable fee policies')

        # Changing the obsolete flat-rate setting cannot disable the new schedule.
        sql('update khub_bot.settings set fee_bps=0;')
        new=lot();assert row(new)['fee_bps']==500 and row(new)['fee_policy']=='tiered_v1'
        direct=lot(escrow=False);assert row(direct)['fee_bps']==0 and row(direct)['fee_policy']=='flat'
        sql('update khub_bot.settings set fee_bps=500;')
        drain()
        close(open_standard)
        assert row(open_standard)['fee_meat']==410000
        drain()
        for ident,price,rate in [(discounted,10000,200),(free,10000,0)]:
            assert send(ident,'bid',price)=='accepted';close(ident)
            assert row(ident)['fee_meat']==price*rate//10000
            drain()
        for price in [20,999999,1000000,10000001,100000000,1000000001,10000000000]:
            ident=lot();assert send(ident,'bid',price)=='accepted'
            held_before_close=sql("select public.bot_gift_wrapping_liabilities()->>'meat';")
            close(ident)
            assert sql("select public.bot_gift_wrapping_liabilities()->>'meat';")==held_before_close,'Gift wrapping could consume commission awaiting player deliveries'
            result=row(ident);fee=expected(price)
            assert result['fee_meat']==fee and result['final_price']==price
            assert fees(ident)==0,'Fee queued before player deliveries completed'
            records=drain()
            payments=[d for d in records if d['auction_id']==ident and d['kind']=='sale_meat']
            prizes=[d for d in records if d['auction_id']==ident and d['kind']=='sale_item']
            assert sum(int(d['meat']) for d in payments)==price-fee
            assert sum(int(d['quantity']) for d in prizes)==3
            assert all('Commission (tiered): '+f'{fee:,}'+' Meat' in d['display_message'] for d in payments)
            assert fees(ident)==fee and row(ident)['status']=='completed'
            assert int(sql("select (public.bot_gift_wrapping_liabilities()->>'meat')::numeric-(public.bot_liabilities()->>'meat')::numeric;"))==int(sql("select coalesce(sum(meat),0) from khub_bot.closet_transfers where state in ('pending','moving','unknown');")), 'Commission double-counted or lost after delivery completion'
            before=fingerprint();sql('select public.bot_tick();');assert fingerprint()==before
        print('PASS: actual funded KMail bids -> deadline settlement -> claimed seller payments/items -> acknowledgments -> exact fee closet queue; split payouts and repeat finalization never duplicate commission; gift wrapping protects fees both before and after delivery completion')

        buyout=lot(buyout=10000000)
        assert send(buyout,'buy',12000000)=='accepted'
        assert row(buyout)['final_price']==10000000 and row(buyout)['fee_meat']==410000
        records=drain()
        assert sum(int(d['meat']) for d in records if d['auction_id']==buyout and d['kind']=='sale_meat')==9590000
        assert sum(int(d['meat']) for d in records if d['recipient_id']==4888902 and d['kind']=='refund')==2000000
        assert fees(buyout)==410000
        cancelled=lot();sql(f"select public.cancel_auction('{cancelled}');",seller);drain()
        unsold=lot();close(unsold);drain()
        for ident in [cancelled,unsold]:
            assert row(ident)['fee_meat']==0 and fees(ident)==0
            assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{ident}' and kind='sale_meat';")=='0'
        sql(f"select public.place_bid('{direct}',10000);",buyer);close(direct)
        assert row(direct)['fee_meat']==0 and fees(direct)==0
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{direct}';")=='0'
        print('PASS: buyout fee uses accepted price rather than excess attached Meat; full excess refund; cancelled/unsold/direct auctions incur no commission or extra payments')
    finally:
        if started: pg('-m','fast','-w','stop')
