"""Exercise receipt-time escrow bidding and safe settlement against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/receipt_time_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-receipt-time-',dir='/tmp') as folder:
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

        from datetime import datetime,timezone
        seller,_=account(89601,48889601,'Receipt Seller')
        buyer,_=account(89602,48889602,'Receipt Buyer')
        other,_=account(89603,48889603,'Receipt Other')
        epoch=int(sql("select floor(extract(epoch from clock_timestamp()))::bigint;"))
        def stamp(seconds): return datetime.fromtimestamp(seconds,timezone.utc).isoformat()
        serial_mail=iter(range(89610,89699))
        def listing(seconds=-90,buyout=None):
            ident=sql(f"select public.create_auction('seal tooth',1,100,24,null,{buyout or 'null'},2,true);",seller)
            payload={'id':str(next(serial_mail)),'sender_id':48889601,'sender_name':'Receipt Seller','received_at':stamp(epoch-200),
                'command':{'type':'list','auction_id':ident},'meat':0,'items':[{'id':2,'quantity':1}],'raw':{'type':'normal','azunixtime':epoch-200}}
            assert sql('select public.bot_ingest_mail('+lit(json.dumps(payload))+');')=='accepted'
            sql(f"update public.auctions set created_at=to_timestamp({epoch-100000}),item_escrowed_at=to_timestamp({epoch-10000}),end_time=to_timestamp({epoch+seconds}) where id='{ident}';")
            return ident
        bid_ids=iter(range(89700,89999))
        def mail(ident,amount,received,actor=48889602,mid=None):
            return {'id':str(mid or next(bid_ids)),'sender_id':actor,'sender_name':'Receipt Buyer','received_at':stamp(received),
                'command':{'type':'bid','auction_id':ident},'meat':amount,'items':[],
                'raw':{'type':'normal','azunixtime':received}}
        def begin(): return json.loads(sql('set role service_role;select public.bot_begin_inbox_scan();'))['id']
        def stage(scan,mails): return json.loads(sql(f"set role service_role;select public.bot_stage_inbox_scan('{scan}',{lit(json.dumps(mails))});"))
        def ingest(m,error=None): return sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(m))+');',error=error)
        def finish(scan,error=None): return sql(f"set role service_role;select public.bot_finish_inbox_scan('{scan}');",error=error)
        def row(ident): return json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{ident}';"))
        def sale_count(ident): return int(sql(f"select count(*) from khub_bot.deliveries where auction_id='{ident}' and kind in ('sale_item','sale_meat','return_item');"))
        target=listing()
        sql(f"select public.finalize_auction('{target}');set role anon;select public.finalize_expired_auctions();")
        sql('set role service_role;select public.bot_tick();')
        assert row(target)['status']=='active' and sale_count(target)==0
        first=mail(target,100,epoch-92)
        tied=mail(target,100,epoch-92,48889603)
        higher=mail(target,110,epoch-91,48889603)
        boundary=mail(target,120,epoch-90)
        late=mail(target,130,epoch-89)
        ingest(first,error='complete staged inbox')
        scan=begin();queued=stage(scan,[late,higher,tied,first,boundary])
        assert [m['id'] for m in queued]==[m['id'] for m in [first,tied,higher,boundary,late]]
        ingest(higher,error='timestamp and message-ID order')
        finish(scan,error='Pending bid mail')
        assert ingest(first)=='accepted'
        assert ingest(tied)!='accepted'
        assert ingest(higher)=='accepted'
        assert ingest(boundary)=='Bidding is closed.' and ingest(late)=='Bidding is closed.'
        assert sale_count(target)==0
        assert finish(scan)=='1'
        assert row(target)['final_price']==110 and row(target)['winner_id']==other
        assert row(target)['status']=='settling' and sale_count(target)==2
        finish(scan,error='fresh complete inbox')
        refund=int(sql("select coalesce(sum(meat),0) from khub_bot.deliveries where receipt_id in ('89701','89703','89704') and kind='refund';"))
        assert refund==350
        print('PASS: delayed pre-deadline bids; exact cutoff and later rejection; same-second ID ordering and increments; only post-scan settlement releases assets')
        waiting=listing(-10)
        scan=begin();m=mail(waiting,100,epoch-11);stage(scan,[m]);assert ingest(m)=='accepted'
        assert finish(scan)=='0' and row(waiting)['status']=='active' and sale_count(waiting)==0
        sql(f"update public.auctions set end_time=to_timestamp({epoch-90}) where id='{waiting}';select public.finalize_expired_auctions();select public.bot_tick();")
        assert sale_count(waiting)==0
        newscan=begin();stage(newscan,[]);assert finish(newscan)=='1'
        print('PASS: 60-second grace uses scan start; website/old-worker finalizers cannot bypass the fresh post-grace scan')
        old_snapshot=listing()
        scan=begin()
        sql(f"update khub_bot.inbox_scans set started_at=to_timestamp({epoch-91}) where id='{scan}';")
        m=mail(old_snapshot,100,epoch-92);stage(scan,[m]);assert ingest(m)=='accepted'
        assert finish(scan)=='0' and sale_count(old_snapshot)==0
        scan=begin();stage(scan,[]);assert finish(scan)=='1'
        stale=begin();sql(f"update khub_bot.inbox_scans set started_at=clock_timestamp()-interval '16 minutes' where id='{stale}';")
        sql(f"select public.bot_stage_inbox_scan('{stale}','[]');",error='fresh complete inbox')
        print('PASS: a scan begun before closing cannot settle later; expired scan tokens require a fresh read')
        instant=listing(86400,500)
        scan=begin();m=mail(instant,600,epoch-90);stage(scan,[m]);assert ingest(m)=='accepted'
        assert row(instant)['status']=='active' and sale_count(instant)==0
        assert datetime.fromisoformat(row(instant)['escrow_buyout_received_at']).timestamp()==epoch-90
        assert finish(scan)=='1'
        assert row(instant)['final_price']==500 and row(instant)['status']=='settling'
        assert datetime.fromisoformat(row(instant)['instant_purchased_at']).timestamp()==epoch-90
        assert int(sql(f"select sum(meat) from khub_bot.deliveries where receipt_id='{m['id']}' and dedupe_key like 'excess:%';"))==100
        projected=json.loads(sql(f"set request.jwt.claim.sub='{seller}';select public.read_auction_page('detail','{instant}');"))
        assert projected['rows'][0]['receipt_time_bidding'] and projected['server_time']
        print('PASS: buyout cutoff and final timestamp use KoL time; exact excess refund; payouts wait for scan completion')
        recovered=listing()
        scan=begin();m=mail(recovered,100,epoch-91);stage(scan,[m])
        nextscan=begin();assert stage(nextscan,[])==[m]
        assert ingest(m)=='accepted' and ingest(m)=='duplicate'
        assert finish(nextscan)=='1'
        assert sql(f"select count(*) from public.bids where auction_id='{recovered}';")=='1'
        print('PASS: staged bids recover durably after interruption; replay never duplicates bids or payouts')
        held=listing(3600)
        scan=begin();m=mail(held,100,epoch-50);stage(scan,[m]);assert ingest(m)=='accepted';finish(scan)
        scan=begin();earlier=mail(held,110,epoch-51);stage(scan,[earlier]);assert ingest(earlier)!='accepted'
        assert row(held)['status']=='on_hold' and row(held)['escrow_timing_review']
        assert finish(scan)=='0' and sale_count(held)==0
        assert sql(f"select count(*) from khub_bot.deliveries where dedupe_key='escrow-timing-review:{held}';")=='1'
        print('PASS: out-of-order recovery holds only the affected auction and records an admin alert')
        unopened=listing(3600)
        sql(f"update public.auctions set item_escrowed_at=to_timestamp({epoch-30}) where id='{unopened}';")
        scan=begin();early=mail(unopened,100,epoch-31);stage(scan,[early]);assert ingest(early)=='Bidding is closed.'
        opening_second=mail(unopened,100,epoch-30);scan=begin();stage(scan,[opening_second]);assert ingest(opening_second)=='accepted';finish(scan)
        print('PASS: pre-activation mail rejects; bids in the activation second remain eligible')
        empty=listing()
        scan=begin();stage(scan,[]);assert finish(scan)=='1'
        assert sale_count(empty)==1 and row(empty)['settlement_outcome']=='ended_no_bids'
        direct=sql("select public.create_auction('seal tooth',1,100,24,null,null,2,false);",seller)
        sql(f"select public.place_bid('{direct}',100);",buyer)
        sql(f"update public.auctions set created_at=to_timestamp({epoch-100000}),end_time=to_timestamp({epoch-90}) where id='{direct}';select public.finalize_expired_auctions();")
        assert row(direct)['status']=='awaiting_trade'
        scan=begin();invalid=mail(held,120,epoch-40);invalid['raw']['azunixtime']+=1
        sql(f"select public.bot_stage_inbox_scan('{scan}',{lit(json.dumps([invalid]))});",error='Invalid KoL bid timestamp')
        for role in ['anon','authenticated']:
            for call in ['public.bot_begin_inbox_scan()',f"public.bot_stage_inbox_scan('{scan}','[]')",f"public.bot_finish_inbox_scan('{scan}')"]:
                sql(f'set role {role};select {call};',error='permission denied')
        for table in ['inbox_scans','inbox_bid_mail','escrow_mail_order','escrow_close_authorizations']:
            sql(f'set role service_role;select * from khub_bot.{table};',error='permission denied')
        print('PASS: unsold escrow and Direct behavior; canonical timestamps; service-only RPCs and private staging')
    finally:
        if started: pg('-m','fast','-w','stop')
