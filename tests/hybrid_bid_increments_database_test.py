"""Exercise hybrid bid increments and funded-refund behavior against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/hybrid_bid_increments_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-hybrid-',dir='/tmp') as folder:
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
        for migration in migrations: sql(migration.read_text())
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
        from fractions import Fraction
        from math import ceil
        import random
        maximum=9007199254740991
        seller,_=account(87101,48887101,'Hybrid Seller')
        first,_=account(87102,48887102,'Hybrid Buyer One')
        second,_=account(87103,48887103,'Hybrid Buyer Two')
        mail_ids=iter(range(87110,89999))
        def expected(current):
            if current<1000: return 10
            if current<10000: return 100
            if current<100000: return 1000
            if current<1000000: return 10000
            rate,unit=(Fraction(3,100),10000) if current<10000000 else (Fraction(2,100),100000) if current<100000000 else (Fraction(1,100),500000) if current<10000000000 else (Fraction(1,200),500000)
            return ceil(current*rate/unit)*unit
        examples=[(1750000,60000,1810000),(7500000,230000,7730000),(15000000,300000,15300000),
            (350000000,3500000,353500000),(15000000000,75000000,15075000000)]
        boundaries=[0,1,999,1000,9999,10000,99999,100000,999999,1000000,1000001,9999999,
            10000000,10000001,99999999,100000000,100000001,9999999999,10000000000,10000000001,maximum]
        rng=random.Random(71)
        prices=sorted(set(boundaries+[current for current,_,_ in examples]+[rng.randrange(maximum) for _ in range(150)]))
        database=json.loads(sql('select jsonb_agg(jsonb_build_array(x,khub_bot.bid_increment(x),khub_bot.minimum_auction_bid(1,x)) order by x) from unnest(array['+','.join(str(p) for p in prices)+']::bigint[]) x;'))
        assert database==[[p,expected(p),p+expected(p) if p else 1] for p in prices]
        frontend=ROOT/'src/lib/bidIncrements.js'
        if frontend.exists():
            js='import {bidIncrement,minimumAuctionBid} from '+json.dumps(frontend.as_uri())+'; console.log(JSON.stringify('+json.dumps(prices)+'.map(currentBid=>[currentBid,bidIncrement(currentBid),minimumAuctionBid({minBidMeat:1,currentBid})])));'
            previews=json.loads(subprocess.check_output(['node','--input-type=module','-e',js],text=True))
            assert previews==[[p,inc,nxt if nxt<=maximum else None] for p,inc,nxt in database]
        for invalid in [-1,maximum+1]: sql(f'select khub_bot.bid_increment({invalid});',error='Invalid current bid')
        for role in ['anon','authenticated']: sql(f'set role {role}; select khub_bot.bid_increment(1750000);',error='permission denied')
        print('PASS: independent exact-fraction oracle matches SQL and frontend across every bracket/rounding boundary, all examples, 150 random large bids and maximum safe price')

        def mail(ident,kind,amount=0,actor=48887102):
            mid=str(next(mail_ids))
            payload={'id':mid,'sender_id':actor,'sender_name':'Hybrid Seller' if actor==48887101 else 'Hybrid Buyer One' if actor==48887102 else 'Hybrid Buyer Two',
                'received_at':'2026-10-22T12:00:00Z','command':{'type':kind,'auction_id':ident},'meat':amount,
                'items':[{'id':2,'quantity':1}] if kind=='list' else [],
                'raw':{'id':mid,'fromid':str(actor),'type':'normal','message':kind.upper()+' '+ident}}
            return payload
        def ingest(payload): return sql('set role service_role; select public.bot_ingest_mail('+lit(json.dumps(payload))+');')
        def lot(escrow=False,minimum=1,buyout=None):
            ident=sql(f"select public.create_auction('seal tooth',1,{minimum},24,null,{buyout if buyout else 'null'},2,{'true' if escrow else 'false'});",seller)
            if escrow: assert ingest(mail(ident,'list',actor=48887101))=='accepted'
            return ident
        def row(ident): return json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{ident}';"))
        def bid(ident,amount,escrow=False,actor=first):
            if escrow: return ingest(mail(ident,'bid',amount,48887102 if actor==first else 48887103))
            return sql(f"select public.place_bid('{ident}',{amount});",actor)

        # The first bid is the exact seller floor, independent of its bracket.
        for escrow,minimum in [(False,1750000),(True,1000000)]:
            ident=lot(escrow,minimum)
            if escrow:
                low=mail(ident,'bid',minimum-1)
                assert f'{minimum:,}' in ingest(low)
                assert int(sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{low['id']}' and kind='refund';"))==minimum-1
            else: sql(f"select public.place_bid('{ident}',{minimum-1});",first,error=f'{minimum:,}')
            bid(ident,minimum,escrow)
            assert row(ident)['current_bid']==minimum

        # Real Direct writes and funded Escrow intake: one Meat below the
        # calculated minimum is rejected; equality is accepted, even over a tier.
        for escrow in [False,True]:
            for current in [999,1000,999999,1000000,1000001,1750000,7500000,9999999,15000000,
                99000000,100000000,100000001,350000000,9999999999,10000000000,15000000000]:
                ident=lot(escrow);bid(ident,current,escrow)
                required=current+expected(current)
                before=row(ident)
                if escrow:
                    rejected=mail(ident,'bid',required-1,48887103)
                    result=ingest(rejected)
                    assert f'{required:,} Meat' in result,(current,result)
                    assert row(ident)==before
                    assert int(sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{rejected['id']}' and kind='refund';"))==required-1
                    snapshot=sql(f"select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d where receipt_id='{rejected['id']}';")
                    assert ingest(rejected)=='duplicate'
                    assert sql(f"select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d where receipt_id='{rejected['id']}';")==snapshot
                else: sql(f"select public.place_bid('{ident}',{required-1});",second,error=f'{required:,}')
                bid(ident,required,escrow,second)
                assert row(ident)['current_bid']==required
                assert sql(f"select count(*) from public.bids where auction_id='{ident}';")=='2'
        print('PASS: exact seller floors and exact-next-minimum acceptance in real Direct and funded Escrow bidding; bracket crossings use the current bid; rejected funded bids refund fully and deduplicate')

        # Buyout is intentionally not aligned to the rounding unit and below
        # the ordinary next minimum. Both explicit BUY and typed BID work.
        price=20200001
        for escrow in [False,True]:
            for route in ['bid','buy','above']:
                ident=lot(escrow,buyout=price);bid(ident,20000000,escrow)
                if escrow:
                    amount=price+100 if route=='above' else price
                    payload=mail(ident,'buy' if route=='buy' else 'bid',amount,48887103)
                    assert ingest(payload)=='accepted'
                    if route=='above': assert sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{payload['id']}' and kind='refund' and recipient_id=48887103;")=='100'
                elif route=='buy': sql(f"select public.purchase_auction('{ident}');",second)
                else: bid(ident,price+100 if route=='above' else price,False,second)
                assert row(ident)['final_price']==price
                assert row(ident)['status']==('settling' if escrow else 'awaiting_trade')
        print('PASS: below-increment exact/non-rounded buyouts via BID and BUY in both modes, accepted buyout price unchanged and excess funded Meat refunded')
        max_lot=lot();bid(max_lot,maximum)
        sql(f"select public.place_bid('{max_lot}',{maximum});",second,error='maximum supported bid')
        last_buyout=lot(buyout=maximum);bid(last_buyout,maximum-1);bid(last_buyout,maximum,actor=second)
        assert row(last_buyout)['final_price']==maximum
        print('PASS: very large Direct bids remain exact; ordinary bidding stops at the supported maximum while a final exact buyout remains valid')
    finally:
        if started: pg('-m','fast','-w','stop')
