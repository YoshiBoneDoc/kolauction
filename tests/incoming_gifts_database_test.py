"""Exercise incoming gift deposits, donations, balance proofs and restart safety.
Creates a disposable local PostgreSQL database; no live Supabase or KoL calls.
Run: python3 tests/incoming_gifts_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-incoming-gifts-',dir='/tmp') as folder:
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
        # Apply existing behavior before testing the privacy upgrade.
        for migration in migrations:
            if migration.name<'202610230097_': sql(migration.read_text())
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

        buyer,_=account(91001,48889101,'Buy Order Buyer')
        seller,_=account(91002,48889102,'Fill Seller One')
        seller2,_=account(91003,48889103,'Fill Seller Two')
        admin,_=account(91004,3552305,'Buy Order Admin')
        from concurrent.futures import ThreadPoolExecutor
        item=int(sql('select id from khub_bot.catalog where is_current and tradeable order by id limit 1;'))
        def payload(mid,kind='bid_help',meat=0,items=None,uid=seller):
            stamp=json.loads(sql("select jsonb_build_object('received_at',date_trunc('second',t),'epoch',floor(extract(epoch from t))::bigint) from (select clock_timestamp() t) clock;"))
            player=sql(f"select kol_player_id from public.profiles where id='{uid}';")
            return {'id':str(mid),'sender_id':int(player),'sender_name':'Fixture sender','received_at':stamp['received_at'],
                'command':{'type':kind,'auction_number':'1048'},'meat':meat,'items':items or [],
                'raw':{'id':str(mid),'fromid':player,'fromname':'Fixture sender','type':'normal','message':'BID 1048 51000','azunixtime':str(stamp['epoch'])}}
        def ingest(mail,error=None):return sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(mail))+');',error=error)
        def deliveries(mid):return json.loads(sql(f"select coalesce(jsonb_agg(to_jsonb(d)),'[]') from khub_bot.deliveries d where receipt_id='{mid}';"))
        def cleanup(mid):return json.loads(sql(f"set role service_role;select public.bot_mail_cleanup(array['{mid}']);"))
        def stage(mail):
            scan=json.loads(sql('select public.bot_begin_inbox_scan();'))
            sql(f"select public.bot_stage_inbox_scan('{scan['id']}',"+lit(json.dumps([mail]))+');')
        sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp();")
        sql(next(p for p in migrations if p.name.startswith('202610230097_')).read_text())
        def rpc(name,**args):
            return sql('set role service_role;select public.'+name+'('+','.join(lit(json.dumps(value))+'::jsonb' if isinstance(value,(dict,list)) else lit(str(value)) for value in args.values())+');')
        def gift_payload(mid,cmd='bid',meat=0,items=None,uid=seller,target='1048'):
            p=payload(mid,cmd,meat,items,uid)
            p['command']={'type':cmd,'auction_number':target} if not '-' in target else {'type':cmd,'auction_id':target}
            body='DONATE' if cmd=='donation' else cmd.upper()+' '+target
            p['raw']['message']=body
            original={**p['raw'],'type':'giftshop','message':body+'<table class="item" rel="id=1167&n=1"><tr><td><img></td></tr></table>'}
            p['raw']['gift_original']={**original,'message':original['message']+'<p>Inside Note:<p>Enjoy!'}
            return p,{'id':p['id'],'wrapper_id':1167,'opened':False,'raw':original}
        def acquire(p,e,before=None,error=None):
            before=before or {'meat':'1000000','items':{'1167':'10'}}
            rpc('bot_register_gift_mail',p_envelopes=[e])
            a=json.loads(rpc('bot_claim_gift_open',p_snapshot=before))
            after={'meat':str(int(before['meat'])+p['meat']),'items':dict(before['items'])}
            after['items']['1167']=str(int(after['items']['1167'])-1)
            for x in p['items']:after['items'][str(x['id'])]=str(int(after['items'].get(str(x['id']),0))+x['quantity'])
            rpc('bot_finish_gift_open',p_attempt=a['id'],p_mail=p,p_snapshot=after)
            return a,after
        # No current auction is rewritten; only verified package assets enter intake.
        sql('set role service_role;select public.bot_claim_delivery(3);',error='Upgrade the worker')
        p,e=gift_payload(206073000,'bid_help',51000,[{'id':item,'quantity':2}])
        ingest(p,error='not been verified')
        a,after=acquire(p,e)
        held=json.loads(sql('select public.bot_liabilities();'))
        assert int(held['meat'])==51000 and int(held['items'][str(item)])==2
        assert ingest(p)=='bid_help';assert ingest(p)=='duplicate'
        assert sum(d['meat'] for d in deliveries(p['id']))==51000
        assert sum(d['quantity'] for d in deliveries(p['id']))==2
        assert all(d['recipient_id']==p['sender_id'] for d in deliveries(p['id']))
        rpc('bot_finish_gift_open',p_attempt=a['id'],p_mail=p,p_snapshot=after)
        assert int(json.loads(sql('select public.bot_liabilities();'))['meat'])==51000
        assert cleanup(p['id'])==[]
        sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where receipt_id='{p['id']}';")
        assert cleanup(p['id'])==[p['id']]
        # No auction command means donated contents, without closeting the wrapper.
        d,de=gift_payload(206073001,'donation',750,[{'id':item,'quantity':3}])
        acquire(d,de);assert rpc('bot_ingest_donation',p_mail=d)=='accepted'
        assert rpc('bot_ingest_donation',p_mail=d)=='duplicate'
        assert int(sql(f"select sum(meat) from khub_bot.closet_transfers where receipt_id='{d['id']}';"))==750
        assert int(sql(f"select sum(quantity) from khub_bot.closet_transfers where receipt_id='{d['id']}' and item_id={item};"))==3
        assert sql(f"select count(*) from khub_bot.closet_transfers where receipt_id='{d['id']}' and item_id=1167;")=='0'
        # Opening is serialized and durable; unresolved attempts forbid dispatch.
        p,e=gift_payload(206073002,'bid',200)
        rpc('bot_register_gift_mail',p_envelopes=[e])
        before={'meat':'1000000','items':{'1167':'5'}}
        def concurrent_claim(_):
            try:return json.loads(rpc('bot_claim_gift_open',p_snapshot=before))
            except AssertionError as error:
                assert 'unresolved' in str(error),str(error)
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:claims=list(pool.map(concurrent_claim,range(2)))
        assert sum(claim is not None for claim in claims)==1
        a=next(claim for claim in claims if claim is not None)
        sql("select public.bot_claim_gift_open('{\"meat\":\"1000000\",\"items\":{\"1167\":5}}');",error='unresolved')
        sql('select public.bot_claim_delivery(4);',error='Unresolved gift open')
        pg('-l',str(Path(folder)/'postgres.log'),'-m','fast','-w','restart')
        assert json.loads(rpc('bot_gift_intake_state'))['attempt']['id']==a['id']
        bad={**p,'sender_id':123};sql('select public.bot_finish_gift_open('+lit(a['id'])+','+lit(json.dumps(bad))+','+lit(json.dumps(before))+');',error='proof')
        sql('select public.bot_finish_gift_open('+lit(a['id'])+','+lit(json.dumps(p))+','+lit(json.dumps(before))+');',error='Meat not secured')
        after={'meat':'1000200','items':{'1167':'4'}}
        rpc('bot_finish_gift_open',p_attempt=a['id'],p_mail=p,p_snapshot=after)
        stage(p);ingest(p)
        # Opened package deposit activates a sell listing; correct gift bid is accepted.
        name=sql(f'select name from khub_bot.catalog where id={item};')
        listing=sql(f"set role authenticated;select public.create_auction({lit(name)},1,100,24,null,null,{item},true);",buyer)
        p,e=gift_payload(206073003,'list',items=[{'id':item,'quantity':1}],uid=buyer,target=listing)
        acquire(p,e);assert ingest(p)=='accepted'
        assert sql(f"select status from public.auctions where id='{listing}';")=='active'
        p,e=gift_payload(206073004,'bid',51000,target=listing)
        acquire(p,e);stage(p);assert ingest(p)=='accepted'
        assert int(sql(f"select current_bid from public.auctions where id='{listing}';"))==51000
        # Wrong gift contents are fully returned, no winner change.
        p,e=gift_payload(206073005,'bid',52000,[{'id':item,'quantity':4}],target=listing)
        acquire(p,e);stage(p);ingest(p)
        assert sum(x['quantity'] for x in deliveries(p['id']))==4 and sum(x['meat'] for x in deliveries(p['id']))==52000
        assert int(sql(f"select current_bid from public.auctions where id='{listing}';"))==51000
        # Buy funding and reservation fills use exactly the same verified adapter.
        buy=sql(f"set role authenticated;select public.create_buy_auction({item},10,200,24,'immediate');",buyer)
        p,e=gift_payload(206073006,'fund',2100,uid=buyer,target=buy)
        acquire(p,e);assert ingest(p)=='accepted'
        res=json.loads(sql(f"set role authenticated;select public.reserve_buy_quantity('{buy}',3);",seller))
        p,e=gift_payload(206073007,'fill',items=[{'id':item,'quantity':3}],target=buy)
        p['command']['reservation_id']=res['id']
        acquire(p,e);stage(p);assert ingest(p)=='accepted'
        assert int(sql(f"select purchased_quantity from khub_bot.buy_orders where auction_id='{buy}';"))==3
        assert int(sql(f"select payment_meat from khub_bot.buy_fulfillments where receipt_id='{p['id']}';"))==600
        # Historical gifts stay donations, even if the original outside note was BID.
        legacy,le=gift_payload(206073020,'donation',425,[{'id':item,'quantity':2}])
        le['raw']['message']=le['raw']['message'].replace('DONATE','BID 1048')
        legacy['raw']['gift_original']['message']=legacy['raw']['gift_original']['message'].replace('DONATE','BID 1048')
        old={'id':legacy['id'],'sender_id':legacy['sender_id'],'sender_name':legacy['sender_name'],'received_at':legacy['received_at'],
            'command':{'type':'donation'},'meat':0,'items':[],'raw':le['raw']}
        sql("insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result) values("+lit(old['id'])+","+str(old['sender_id'])+","+lit(old['received_at'])+","+lit(json.dumps(old))+",'donation');")
        before_receipt=sql("select payload from khub_bot.receipts where mail_id="+lit(old['id'])+";")
        acquire(legacy,le)
        assert before_receipt==sql("select payload from khub_bot.receipts where mail_id="+lit(old['id'])+";")
        assert int(sql("select sum(meat) from khub_bot.closet_transfers where receipt_id="+lit(old['id'])+";"))==425
        assert not deliveries(old['id'])
        # Legacy mail whose wrapper is already in the closet does not block intake.
        absent,ae=gift_payload(206073021,'donation')
        old={**old,'id':absent['id'],'raw':ae['raw']}
        sql("insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result) values("+lit(old['id'])+","+str(old['sender_id'])+","+lit(old['received_at'])+","+lit(json.dumps(old))+",'donation');")
        rpc('bot_register_gift_mail',p_envelopes=[ae])
        assert rpc('bot_claim_gift_open',p_snapshot={'meat':'1000000','items':{}})==''
        # Confirmed no-open release is explicit and audited, never a silent retry.
        p,e=gift_payload(206073008)
        rpc('bot_register_gift_mail',p_envelopes=[e]);a=json.loads(rpc('bot_claim_gift_open',p_snapshot=before))
        sql('select public.bot_resolve_gift_not_opened('+lit(a['id'])+",'too short');",error='evidence')
        rpc('bot_resolve_gift_not_opened',p_attempt=a['id'],p_evidence='Fixture: original KMail verified unopened and wrapper inventory unchanged.')
        assert json.loads(rpc('bot_gift_intake_state'))['attempt'] is None
        assert sql(f"select state from khub_bot.gift_open_attempts where id='{a['id']}';")=='not_opened'
        for role in ['anon','authenticated']:
            sql('set role '+role+';select public.bot_gift_intake_state();',error='permission denied')
            sql('set role '+role+';select * from khub_bot.incoming_gifts;',error='permission denied')
        assert json.loads(sql('select public.bot_inspect();'))['incomingGiftsVersion']==1
        print('PASS: gift LIST/BID/FUND/reserved FILL; wrong contents refund exactly; donations closet contents only; original identity/time; liabilities before intake; idempotency; restart/uncertain-open guard; version/role guards; audited no-open recovery')
    finally:
        if started: pg('-m','immediate','stop')
