"""Exercise Direct Trade conclusion and 24-hour reminder notices against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/direct_trade_reminders_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-direct-reminders-',dir='/tmp') as folder:
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
            if migration.name<'202610230100_':sql(migration.read_text())
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
            sql(f"update public.auctions set created_at=clock_timestamp()-interval '4 days',end_time={expr},item_escrowed_at=case when escrow_mode then clock_timestamp()-interval '1 day' else item_escrowed_at end where id='{ident}';")
        # Previously closed history and all financial records remain untouched.
        old=create();bid(old,100);set_end(old,"clock_timestamp()-interval '1 second'")
        sql('select public.finalize_expired_auctions();')
        frozen=sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        sql(next(p for p in migrations if p.name.startswith('202610230100_')).read_text())
        assert frozen==sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        assert sql('select count(*) from khub_bot.direct_trade_reminders;')=='0'
        sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where state='pending';")
        def notices(ident,phase=None):
            extra=f" and n.phase={lit(phase)}" if phase else ''
            return json.loads(sql(f"select coalesce(jsonb_agg(to_jsonb(n)||jsonb_build_object('delivery',to_jsonb(d)) order by n.phase,n.recipient_role),'[]') from khub_bot.direct_trade_reminders n left join khub_bot.deliveries d on d.id=n.delivery_id where n.auction_id='{ident}'{extra};"))
        def close(age='1 second',buyout=False):
            ident=create(buyout=200 if buyout else None)
            if buyout: call(f"select public.purchase_auction('{ident}');")
            else:
                bid(ident,100);set_end(ident,f"clock_timestamp()-interval '{age}'")
                sql('select public.finalize_expired_auctions();')
            return ident
        def claim():return json.loads(sql('set role service_role;select public.bot_claim_delivery(5);') or 'null')
        def acknowledge(d):sql(f"set role service_role;select public.bot_ack_delivery('{d['id']}','{d['attempt']}',true,'offline fixture confirmed sent');")
        ident=close()
        first=notices(ident,'conclusion')
        assert len(first)==2 and len(notices(ident))==4
        for n in first:
            d=n['delivery'];body=d['message']
            assert d['state']=='pending' and d['kind']=='notice' and d['meat']==0 and d['quantity']==0
            assert '48 hours from the auction ending' in body and 'Complete by:' in body and ' UTC.' in body
            assert '1 x seal tooth' in body and '100 Meat' in body and 'mark the trade complete' in body
            assert 'Do not send these items or Meat to kHub' in body
            expected=48889602 if n['recipient_role']=='seller' else 48889601
            assert f'(#{expected})' in body
            assert ('You are the seller' if n['recipient_role']=='seller' else 'You are the buyer') in body
        assert {n['delivery']['recipient_id'] for n in first}=={48889601,48889602}
        assert all(n['delivery'] is None for n in notices(ident,'24_hours'))
        sql('set role service_role;select public.bot_claim_delivery(4);',error='message version 5')
        # Concurrent maintenance cannot duplicate notices. Existing dispatch sends
        # one at a time; its uncertain-send guard remains intact until acknowledgment.
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _:sql('select khub_bot.maintain_direct_trade_reminders();'),range(4)))
        sent=[]
        for _ in range(2):
            d=claim();sent.append(d)
            sql('set role service_role;select public.bot_claim_delivery(5);',error='Uncertain delivery requires reconciliation')
            acknowledge(d)
        assert len({d['id'] for d in sent})==2 and claim() is None
        for _ in range(3):sql('select public.bot_tick();')
        assert len([n for n in notices(ident) if n['delivery']])==2
        not_due=close('23 hours 59 minutes')
        sql('select public.bot_tick();')
        assert all(n['delivery'] is None and n['suppressed_at'] is None for n in notices(not_due,'24_hours'))
        # Buyouts start the clock at their actual early close, not the original deadline.
        early=close(buyout=True)
        a=row(early)
        for n in notices(early):
            assert n['closed_at']==a['instant_purchased_at']
        # Deferred processing sends only the current reminder, not stale initial mail.
        due=close('24 hours 1 second')
        stages=notices(due)
        assert all(n['suppressed_at'] and n['delivery'] is None for n in stages if n['phase']=='conclusion')
        assert all(n['delivery'] and '24-hour reminder' in n['delivery']['message'] for n in stages if n['phase']=='24_hours')
        expired=close('49 hours')
        assert all(n['suppressed_at'] and n['delivery'] is None for n in notices(expired))
        # One participant's confirmation does not complete the trade or suppress both reminders.
        partial=close()
        call(f"select public.confirm_auction_trade('{partial}');",seller)
        sql(f"with t as (select clock_timestamp()-interval '24 hours 1 second' as closed) update khub_bot.direct_trade_reminders set closed_at=t.closed,due_at=t.closed+case when phase='conclusion' then interval '0' else interval '24 hours' end,deadline_at=t.closed+interval '48 hours' from t where auction_id='{partial}';")
        sql('select public.bot_tick();')
        second=notices(partial,'24_hours')
        assert len(second)==2 and all(n['delivery'] for n in second)
        assert 'already confirmed' in next(n['delivery']['message'] for n in second if n['recipient_role']=='seller')
        # Recheck completion at claim time; queued unsent messages are canceled.
        call(f"select public.confirm_auction_trade('{partial}');",buyer)
        sql('select public.bot_claim_delivery(5);')
        assert all(n['delivery']['state']=='cancelled' for n in notices(partial,'24_hours'))
        # Other pending notices do not prevent a completed trade's stale notice suppression.
        completed=close()
        call(f"select public.confirm_auction_trade('{completed}');",seller)
        call(f"select public.confirm_auction_trade('{completed}');",buyer)
        sql('select public.bot_tick();')
        assert all(n['suppressed_at'] for n in notices(completed))
        assert all(n['delivery']['state']=='cancelled' for n in notices(completed,'conclusion'))
        # An uncertain send is immutable and never blindly retried or canceled.
        uncertain=close()
        first=notices(uncertain,'conclusion')[0]['delivery']
        sql(f"update khub_bot.deliveries set state='unknown',attempt='{uuid4()}',evidence='offline timeout' where id='{first['id']}';")
        original=sql(f"select to_jsonb(d) from khub_bot.deliveries d where id='{first['id']}';")
        call(f"select public.confirm_auction_trade('{uncertain}');",seller)
        call(f"select public.confirm_auction_trade('{uncertain}');",buyer)
        sql('select public.bot_tick();')
        assert original==sql(f"select to_jsonb(d) from khub_bot.deliveries d where id='{first['id']}';")
        # Canceled, unsold and Escrow auctions never enroll.
        unsold=create();set_end(unsold,"clock_timestamp()-interval '1 second'")
        cancelled=create();call(f"select public.cancel_auction('{cancelled}');",seller)
        escrow=funded();set_end(escrow,"clock_timestamp()-interval '1 second'")
        sql('select public.finalize_expired_auctions();')
        assert notices(unsold)==notices(cancelled)==notices(escrow)==[]
        buy_order=call("select public.create_buy_auction(2,10,100,24,'finished');")
        call(f"select public.cancel_auction('{buy_order}');")
        assert notices(buy_order)==[]
        # Large quantities and whole-listing prices are not confused with per-item prices.
        bulk=call("select public.create_auction('seal tooth',2000000,100,24,null,null,2,false);",seller)
        bid(bulk,1234567);set_end(bulk,"clock_timestamp()-interval '1 second'")
        sql('select public.finalize_expired_auctions();')
        assert all('2,000,000 x seal tooth' in n['delivery']['message'] and '1,234,567 Meat' in n['delivery']['message'] for n in notices(bulk,'conclusion'))
        # No identity guessing: an unverified player leaves its notice recoverable.
        missing=create();bid(missing,100);set_end(missing,"clock_timestamp()-interval '1 second'")
        sql(f"update public.profiles set kol_verified_at=null where id='{buyer}';select public.finalize_expired_auctions();")
        assert all(n['delivery'] is None for n in notices(missing))
        sql(f"update public.profiles set kol_verified_at=clock_timestamp(),kol_player_name='<Buyer & Name>' where id='{buyer}';select public.bot_tick();")
        assert all(n['delivery'] for n in notices(missing,'conclusion'))
        assert '&lt;Buyer &amp; Name&gt;' in next(n['delivery']['message'] for n in notices(missing,'conclusion') if n['recipient_role']=='seller')
        # Private schedule and entry points are never exposed to regular users.
        sql('set role authenticated;select * from khub_bot.direct_trade_reminders;',error='permission denied')
        sql('set role service_role;select khub_bot.maintain_direct_trade_reminders();',error='permission denied')
        assert json.loads(sql('set role service_role;select public.bot_inspect();'))['directTradeRemindersVersion']==1
        # Recovery after a database/worker restart still retains unique delivery IDs.
        before=sql('select jsonb_agg(to_jsonb(n) order by auction_id,phase,recipient_role) from khub_bot.direct_trade_reminders n;')
        pg('-m','fast','-w','stop');started=False
        pg('-l',str(Path(folder)/'postgres.log'),'-o',f"-F -h '' -k {folder}",'-w','start');started=True
        sql('select public.bot_tick();')
        assert before==sql('select jsonb_agg(to_jsonb(n) order by auction_id,phase,recipient_role) from khub_bot.direct_trade_reminders n;')
        print('PASS: Direct Trade conclusion/24-hour notices, exact natural/buyout deadlines, both participants, deduplication/concurrent claims, stale suppression, unknown-send recovery, private verified identities, unchanged history and restart safety')
    finally:
        if started:pg('-m','fast','-w','stop')
