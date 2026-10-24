"""Exercise nonblocking isolation of uncertain closet moves against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/closet_isolation_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-closet-isolation-',dir='/tmp') as folder:
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
            if migration.name<'202610240106_':sql(migration.read_text())
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

        def service(query,error=None):return sql('set role service_role;'+query,error=error)
        def move(key,item=None,qty=0,meat=0,state='pending'):
            return sql(f"insert into khub_bot.closet_transfers(dedupe_key,source,meat,item_id,quantity,state,attempt,before_state,evidence) values('{key}','sale_fee',{meat},{'null' if item is None else item},{qty},'{state}',gen_random_uuid(),jsonb_build_object('inventory','1000','closet','0'),'Fixture verification required') returning id;")
        uncertain=move('uncertain-meat',meat=50,state='unknown')
        uncertain_item=move('uncertain-item',item=1,qty=3,state='moving')
        queued_meat=move('queued-meat',meat=25)
        queued_item=move('queued-same-item',item=1,qty=2)
        unrelated=move('queued-other-item',item=2,qty=2)
        saved=sql('select jsonb_agg(to_jsonb(c) order by id) from khub_bot.closet_transfers c;')
        migration=next(p for p in migrations if p.name=='202610240106_isolate_uncertain_closet_moves.sql')
        sql(migration.read_text())
        assert saved==sql('select jsonb_agg(to_jsonb(c) order by id) from khub_bot.closet_transfers c;')
        assert json.loads(service('select public.bot_inspect();'))['closetIsolationVersion']==1
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(lambda _:service('select public.bot_isolate_closet_transfers();'),range(2)))
        assert sql('select count(*) from khub_bot.closet_transfer_reviews;')=='2'
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like 'closet-review:%';")=='2'
        assert sql("select count(*) from khub_bot.bug_reports where is_system and body like 'Closet transfer C-%';")=='2'
        assert sql("select count(*) from khub_bot.deliveries where dedupe_key like 'closet-review:%' and (meat<>0 or item_id is not null or quantity<>0);")=='0'
        sql('set role authenticated;select public.bot_isolate_closet_transfers();',error='permission denied')
        sql('set role anon;select * from khub_bot.closet_transfer_reviews;',error='permission denied')
        # Versioned dispatcher can claim ready payouts despite unknown closet moves.
        payout=sql("insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,meat,message,display_message) values('funded-test',888,'refund',100,'Refund','Refund') returning id;")
        assert int(json.loads(service('select public.bot_dispatch_liabilities();'))['meat'])>=100
        sent=[]
        for _ in range(3):
            d=json.loads(service('select public.bot_claim_delivery(5);'));sent.append(d['id'])
            service(f"select public.bot_ack_delivery('{d['id']}','{d['attempt']}',true,'Mock verified send evidence');")
        assert payout in sent
        assert service('select public.bot_claim_delivery(5);')==''
        # Same-asset closet moves wait; an unrelated item can still be banked.
        snapshot={'meat':'1000','closetMeat':'0','items':{'1':'20','2':'20'},'closetItems':{}}
        def claim():return service('select public.bot_claim_closet_transfer('+lit(json.dumps(snapshot))+",0,0,'{}');")
        c=json.loads(claim());assert c['id']==unrelated
        service(f"select public.bot_ack_closet_transfer('{c['id']}','{c['attempt']}',true,'Mock verified item balance change');")
        assert claim()==''
        assert sql(f"select state from khub_bot.closet_transfers where id='{queued_meat}';")=='pending'
        assert sql(f"select state from khub_bot.closet_transfers where id='{queued_item}';")=='pending'
        assert sql(f"select state from khub_bot.closet_transfers where id='{uncertain}';")=='unknown'
        assert sql(f"select state from khub_bot.closet_transfers where id='{uncertain_item}';")=='moving'
        # An unrelated gift wrapper remains openable, but uncertain wrappers do not.
        sql("insert into khub_bot.incoming_gifts(mail_id,wrapper_id,envelope) values('99881',1167,jsonb_build_object('azunixtime','1792800000'));")
        gift_snapshot={'meat':'1000','items':{'1167':'1'},'reserve':0,'observed_normal':[]}
        gift=json.loads(service('select public.bot_claim_gift_open('+lit(json.dumps(gift_snapshot))+');'))
        assert gift['wrapper_id']==1167
        service(f"select public.bot_resolve_gift_not_opened('{gift['id']}','Mock confirmed original unopened gift and unchanged inventory');")
        wrapper=move('uncertain-wrapper',item=1167,qty=1,state='unknown')
        assert service('select public.bot_claim_gift_open('+lit(json.dumps(gift_snapshot))+');')==''
        # Only explicit reconciliation releases the same asset for closet work.
        service(f"select public.bot_reconcile_closet_transfer('{uncertain}',false,'Mock verified unchanged Meat inventory and closet');")
        c=json.loads(claim());assert c['id']==uncertain
        service(f"select public.bot_ack_closet_transfer('{c['id']}','{c['attempt']}',true,'Mock verified Meat balance change');")
        # A fresh possibly-sent payout still requires mailbox isolation.
        sql("insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,meat,message,display_message,state,attempt) values('uncertain-payout',888,'refund',100,'Refund','Refund','unknown',gen_random_uuid());")
        service('select public.bot_claim_delivery(5);',error='Uncertain delivery')
        saved=sql('select jsonb_agg(to_jsonb(c) order by id) from khub_bot.closet_transfers c;')
        pg('-m','fast','-w','stop');started=False
        pg('-l',str(Path(folder)/'postgres.log'),'-o',f"-F -h '' -k {folder}",'-w','start');started=True
        assert saved==sql('select jsonb_agg(to_jsonb(c) order by id) from khub_bot.closet_transfers c;')
        service('select public.bot_isolate_closet_transfers();')
        assert sql('select count(*) from khub_bot.closet_transfer_reviews;')=='3'
        # Real ordinary Escrow intake remains usable while closet review is open.
        seller,_=account(88801,48888801,'Closet Test Seller')
        buyer,_=account(88802,48888802,'Closet Test Buyer')
        item=int(sql('select id from khub_bot.catalog where is_current and tradeable order by id limit 1;'))
        name=sql(f'select name from khub_bot.catalog where id={item};')
        auction=sql(f"set role authenticated;select public.create_auction({lit(name)},1,1000,24,null,null,{item},true);",seller)
        mail_cache={}
        def intake(mid,kind,player,meat=0,items=None):
            stamp=json.loads(sql("select jsonb_build_object('received_at',date_trunc('second',t),'epoch',floor(extract(epoch from t))::bigint) from (select clock_timestamp() t) c;"))
            mail={'id':str(mid),'sender_id':player,'sender_name':'Fixture sender','received_at':stamp['received_at'],
                'command':{'type':kind,'auction_id':auction},'meat':meat,'items':items or [],
                'raw':{'id':str(mid),'fromid':str(player),'fromname':'Fixture sender','type':'normal','message':kind.upper()+' '+auction,'azunixtime':str(stamp['epoch'])}}
            mail=mail_cache.setdefault(mid,mail)
            scan=json.loads(service('select public.bot_begin_inbox_scan();'))
            service(f"select public.bot_stage_inbox_scan('{scan['id']}',"+lit(json.dumps([mail]))+');')
            result=service('select public.bot_ingest_mail('+lit(json.dumps(mail))+');')
            service(f"select public.bot_finish_inbox_scan('{scan['id']}');")
            return result
        intake(88901,'list',48888801,items=[{'id':item,'quantity':1}])
        assert sql(f"select status from public.auctions where id='{auction}';")=='active'
        intake(88902,'bid',48888802,meat=1000)
        intake(88902,'bid',48888802,meat=1000)
        assert sql(f"select count(*) from public.bids where auction_id='{auction}';")=='1'
        assert sql(f"select current_bid from public.auctions where id='{auction}';")=='1000'
        service('select public.bot_tick();')
        print('PASS: nonblocking Meat/item closet isolation, no automatic retries, same-asset holds, unrelated payouts and closet moves, safe gift wrapper selection, once-only concurrent admin alerts, permissions, explicit reconciliation, existing mailbox safeguards and restart persistence')
    finally:
        if started:pg('-m','fast','-w','stop')
