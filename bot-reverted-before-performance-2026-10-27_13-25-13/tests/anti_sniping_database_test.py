"""Exercise anti-sniping, receipt-time escrow bidding and safe settlement against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/anti_sniping_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-anti-sniping-',dir='/tmp') as folder:
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
            if migration.name<'202610230099_':sql(migration.read_text())
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
        # The upgrade changes no previous auction, bid or frozen message data.
        historical=create();bid(historical,100)
        frozen=sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        sql(next(p for p in migrations if p.name.startswith('202610230099_')).read_text())
        assert frozen==sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        assert events(historical)==[]
        # Regular early bids do not alter the deadline.
        ident=create();original=row(ident)['end_time'];bid(ident,100)
        assert row(ident)['end_time']==original and events(ident)==[]
        # Accepted Direct bids reset to 60s remaining, including successive bids.
        set_end(ident,"clock_timestamp()+interval '30 seconds'")
        bid(ident,110,other);first=events(ident)[0]
        assert row(ident)['end_time']==first['new_end_time']
        assert sql(f"select new_end_time=received_at+interval '60 seconds' and new_end_time<previous_end_time+interval '45 seconds' from khub_bot.auction_bid_extensions where bid_id='{first['bid_id']}';")=='t'
        bid(ident,120,buyer);ev=events(ident);assert len(ev)==2
        assert ev[1]['previous_end_time']==ev[0]['new_end_time']
        assert sql(f"select new_end_time-previous_end_time<interval '5 seconds' from khub_bot.auction_bid_extensions where bid_id='{ev[1]['bid_id']}';")=='t'
        end=row(ident)['end_time'];bid(ident,120,other,error='at least');bid(ident,130,buyer,error='already the highest');bid(ident,130,seller,error='own auction')
        assert row(ident)['end_time']==end and len(events(ident))==2
        # A stale browser request cannot revive an ended auction.
        ended=create();set_end(ended,"clock_timestamp()-interval '1 second'")
        bid(ended,100,error='ended');assert events(ended)==[]
        # Simultaneous bidders serialize against the same updated deadline.
        concurrent=create();set_end(concurrent,"clock_timestamp()+interval '30 seconds'")
        def attempt(value):
            amount,uid=value
            try:bid(concurrent,amount,uid);return True
            except AssertionError as error:
                assert 'at least' in str(error),str(error)
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(attempt,[(100,buyer),(110,other)]))
        assert any(results) and row(concurrent)['current_bid']==110
        ev=events(concurrent);assert len(ev) in (1,2) and row(concurrent)['end_time']==ev[-1]['new_end_time']
        # Direct buyouts stay immediate and do not create extension events.
        instant=create(buyout=200);set_end(instant,"clock_timestamp()+interval '30 seconds'");original=row(instant)['end_time']
        bid(instant,300)
        assert row(instant)['status']=='awaiting_trade' and row(instant)['current_bid']==200 and row(instant)['end_time']==original and events(instant)==[]
        # A chosen custom end time is the initial deadline, not an anti-sniping exemption.
        custom=call("select public.create_auction('seal tooth',1,100,24,null,null,2,false,clock_timestamp()+interval '30 seconds');",seller)
        chosen=row(custom)['custom_end_at'];bid(custom,100)
        assert row(custom)['custom_end_at']==chosen and len(events(custom))==1
        assert row(custom)['end_time']!=chosen
        # Receipt timestamps, NOT processing time, extend a delayed Escrow chain.
        target=funded();epoch=int(sql('select floor(extract(epoch from clock_timestamp()))::bigint;'))
        set_end(target,f'to_timestamp({epoch-240})')
        first=mail(target,'bid',100,received=epoch-245)
        second=mail(target,'bid',110,actor=48889603,received=epoch-200)
        third=mail(target,'bid',120,received=epoch-145)
        boundary=mail(target,'bid',130,actor=48889603,received=epoch-85)
        late=mail(target,'bid',140,actor=48889603,received=epoch-84)
        scan=stage([late,third,first,second,boundary])
        ingest(second,error='timestamp and message-ID order')
        assert ingest(first)=='accepted';assert row(target)['end_time']==sql(f'select to_jsonb(to_timestamp({epoch-185}))#>>\'{{}}\';')
        assert ingest(second)=='accepted' and ingest(third)=='accepted'
        assert ingest(boundary)=='Bidding is closed.' and ingest(late)=='Bidding is closed.'
        assert len(events(target))==3
        assert ingest(first)=='duplicate' and len(events(target))==3
        assert row(target)['current_bid']==120
        assert sql(f"select bool_and(e.new_end_time=e.received_at+interval '60 seconds' and e.received_at=r.received_at) from khub_bot.auction_bid_extensions e join khub_bot.receipts r on r.mail_id=e.receipt_id where e.auction_id='{target}';")=='t'
        assert int(sql("select sum(meat) from khub_bot.deliveries where receipt_id in ("+','.join(lit(m['id']) for m in [first,second,third,boundary,late])+") and kind='refund';"))==480
        assert row(target)['status']=='active'
        sql(f"select public.bot_finish_inbox_scan('{scan}');")
        assert row(target)['status']=='settling' and row(target)['final_price']==120
        # Website refresh/finalizers cannot close at the original deadline once extended.
        live=funded();epoch=int(sql('select floor(extract(epoch from clock_timestamp()))::bigint;'))
        set_end(live,f'to_timestamp({epoch+20})');m=mail(live,'bid',100,received=epoch)
        scan=stage([m]);assert ingest(m)=='accepted';sql(f"select public.bot_finish_inbox_scan('{scan}');select public.finalize_auction('{live}');select public.bot_tick();")
        assert row(live)['status']=='active' and len(events(live))==1
        assert sql(f"select end_time=to_timestamp({epoch+60}) from public.auctions where id='{live}';")=='t'
        # Opened gift bids use their original receipt timestamp through the same writer.
        wrapped=funded();epoch=int(sql('select floor(extract(epoch from clock_timestamp()))::bigint;'));set_end(wrapped,f'to_timestamp({epoch-120})')
        m=mail(wrapped,'bid',100,received=epoch-125)
        envelope={**m['raw'],'type':'giftshop','message':'BID '+wrapped+'<table class="item" rel="id=1167&n=1"><tr><td><img></td></tr></table>'}
        m['raw']['gift_original']={**envelope,'message':envelope['message']+'<p>Inside Note:<p>Bid<center>You gain 100 Meat</center>'}
        sql('select public.bot_register_gift_mail('+lit(json.dumps([{'id':m['id'],'wrapper_id':1167,'opened':False,'raw':envelope}]))+');')
        before={'meat':'1000000','items':{'1167':'1','2':'1000'}}
        operation=json.loads(sql('select public.bot_claim_gift_open('+lit(json.dumps(before))+');'))
        after={'meat':'1000100','items':{'1167':'0','2':'1000'}}
        sql('select public.bot_finish_gift_open('+lit(operation['id'])+','+lit(json.dumps(m))+','+lit(json.dumps(after))+');')
        stage([m]);assert ingest(m)=='accepted';assert len(events(wrapped))==1
        assert events(wrapped)[0]['received_at']==sql(f"select to_jsonb(to_timestamp({epoch-125}))#>>'{{}}';")
        assert sql(f"select end_time=to_timestamp({epoch-65}) from public.auctions where id='{wrapped}';")=='t'
        # Exact 60-second boundary is unchanged; outside the last minute is unchanged.
        for remaining in [60,61]:
            target=funded();epoch=int(sql('select floor(extract(epoch from clock_timestamp()))::bigint;'))
            set_end(target,f'to_timestamp({epoch-100})');m=mail(target,'bid',100,received=epoch-100-remaining)
            original=row(target)['end_time'];stage([m]);assert ingest(m)=='accepted'
            assert row(target)['end_time']==original and events(target)==[]
        # Escrow buyout retains the original receipt timestamp and closes normally.
        instant=create(True,200);assert ingest(mail(instant,'list',quantity=1,actor=48889601))=='accepted'
        epoch=int(sql('select floor(extract(epoch from clock_timestamp()))::bigint;'));set_end(instant,f'to_timestamp({epoch-120})')
        m=mail(instant,'bid',250,received=epoch-121);original=row(instant)['end_time'];scan=stage([m]);assert ingest(m)=='accepted'
        assert events(instant)==[] and row(instant)['end_time']==original
        sql(f"select public.bot_finish_inbox_scan('{scan}');")
        assert row(instant)['status']=='settling' and row(instant)['final_price']==200
        assert int(sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{m['id']}' and kind='refund';"))==50
        # Buy orders keep their scheduled expiry after funding and partial fills.
        order=call("select public.create_buy_auction(2,10,200,24,'finished');",seller)
        assert ingest(mail(order,'fund',2100,actor=48889601))=='accepted'
        set_end(order,"clock_timestamp()+interval '30 seconds'");original=row(order)['end_time']
        res=json.loads(call(f"select public.reserve_buy_quantity('{order}',2);",buyer))
        m=mail(order,'fill',quantity=2);m['command']['reservation_id']=res['id'];stage([m]);assert ingest(m)=='accepted'
        assert row(order)['end_time']==original and events(order)==[]
        pg('-l',str(Path(folder)/'postgres.log'),'-m','fast','-w','restart')
        assert len(events(ident))==2
        for role in ['anon','authenticated','service_role']:
            sql('set role '+role+f";select khub_bot.extend_sell_auction('{ident}','{ev[0]['bid_id']}',clock_timestamp());",error='permission denied')
        print('PASS: Direct repeated/concurrent last-minute bids reset to 60s; Escrow uses original receipt time across delayed chained bids; exact/late boundaries; failed/duplicate bids; normal buyouts/refunds and Buy orders unchanged; upgrade preserves history; audit/restart/permissions')
    finally:
        if started:pg('-m','immediate','stop')
