"""Exercise incoming gift deposits, donations, balance proofs and restart safety.
Creates a disposable local PostgreSQL database; no live Supabase or KoL calls.
Run: python3 tests/gift_isolation_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-gift-isolation-',dir='/tmp') as folder:
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
        sql(next(p for p in migrations if p.name.startswith('202610230098_')).read_text())
        failed,e1=gift_payload(206074000,'bid_help',700,[{'id':item,'quantity':3}])
        good,e2=gift_payload(206074001,'bid_help',100,[{'id':item,'quantity':2}])
        rpc('bot_register_gift_mail',p_envelopes=[e1,e2])
        before={'meat':'10000','items':{'1167':'2'},'reserve':50}
        a=json.loads(rpc('bot_claim_gift_open',p_snapshot=before))
        sql('select public.bot_isolate_gift_open('+lit(a['id'])+",'Fixture opening cannot be identified safely.',array['206074000']);")
        unknown={'meat':'10700','items':{'1167':'1',str(item):'3'}}
        held=json.loads(rpc('bot_refresh_gift_protection',p_snapshot=unknown))
        assert held['meat']=='700' and held['items'][str(item)]=='3'
        # Another same-wrapper package is claimed, secured, ingested, and paid.
        b=json.loads(rpc('bot_claim_gift_open',p_snapshot=unknown));assert b['id']!=a['id']
        secured={'meat':'10800','items':{'1167':'0',str(item):'5'}}
        rpc('bot_finish_gift_open',p_attempt=b['id'],p_mail=good,p_snapshot=secured)
        assert ingest(good)=='bid_help';assert ingest(good)=='duplicate'
        held=json.loads(rpc('bot_refresh_gift_protection',p_snapshot=secured))
        assert held['meat']=='700' and held['items'][str(item)]=='3'
        ds=deliveries(good['id']);assert sum(d['meat'] for d in ds)==100 and sum(d['quantity'] for d in ds)==2
        claimed=json.loads(sql('select public.bot_claim_delivery(5);'));assert claimed['receipt_id']==good['id']
        # Unknown assets also remain after the unrelated refund has been sent.
        sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp() where receipt_id='{good['id']}';")
        after={'meat':'10700','items':{'1167':'0',str(item):'3'}}
        assert json.loads(rpc('bot_refresh_gift_protection',p_snapshot=after))['meat']=='700'
        assert not deliveries(failed['id']) and not cleanup(failed['id'])
        # Later unknown contents are protected even after legitimate outgoing work.
        later={'meat':'10760','items':{'1167':'0',str(item):'7'}}
        held=json.loads(rpc('bot_refresh_gift_protection',p_snapshot=later))
        assert held['meat']=='760' and held['items'][str(item)]=='7'
        # New ordinary KMail is funded independently, never double-counted as a hold.
        normal=payload(206074002,'bid_help',200)
        assert ingest(normal)=='bid_help'
        later['meat']='10960'
        assert json.loads(rpc('bot_refresh_gift_protection',p_snapshot=later))['meat']=='760'
        # kHub's verified old operating cash can pay wrapping, once per attempt.
        d=deliveries(normal['id'])[0]
        claimed=json.loads(sql(f"update khub_bot.deliveries set state='sending',attempt=gen_random_uuid() where id='{d['id']}' returning to_jsonb(deliveries);"))
        rpc('bot_authorize_safe_gift_wrapping',p_id=d['id'],p_attempt=claimed['attempt'])
        rpc('bot_authorize_safe_gift_wrapping',p_id=d['id'],p_attempt=claimed['attempt'])
        assert int(sql('select safe_operating_meat from khub_bot.gift_asset_protection;'))==9900
        later['meat']='10910'
        assert json.loads(rpc('bot_refresh_gift_protection',p_snapshot=later))['meat']=='760'
        later['meat']='10960'  # A confirmed no-send leaves the 50 Meat on hand.
        rpc('bot_release_safe_gift_wrapping',p_id=d['id'],p_attempt=claimed['attempt'])
        rpc('bot_release_safe_gift_wrapping',p_id=d['id'],p_attempt=claimed['attempt'])
        assert int(sql('select safe_operating_meat from khub_bot.gift_asset_protection;'))==9950
        # Simulate a real restart: isolation, asset holds and wrapping dedupe persist.
        pg('-l',str(Path(folder)/'postgres.log'),'-m','fast','-w','restart')
        report=json.loads(sql('select public.bot_inspect();'))
        assert report['incomingGiftsVersion']==2 and len(report['giftIsolatedAttention'])==1
        assert json.loads(rpc('bot_gift_intake_state'))['reviews']==[failed['id']]
        for role in ['anon','authenticated']:
            sql('set role '+role+';select public.bot_refresh_gift_protection(\'{}\');',error='permission denied')
        # Reviews are recoverable with explicit, audited reconciliation evidence.
        evidence='Fixture original KMail and all unknown assets independently reconciled; confirmed return recorded.'
        rpc('bot_resolve_gift_review',p_mail_id=failed['id'],p_evidence=evidence)
        rpc('bot_resolve_gift_isolation',p_attempt=a['id'],p_evidence=evidence)
        assert json.loads(rpc('bot_gift_intake_state'))['reviews']==[]
        assert json.loads(rpc('bot_gift_intake_state'))['isolated']==[]
        assert json.loads(rpc('bot_refresh_gift_protection',p_snapshot=later))=={'meat':'0','items':{}}
        # An untracked malformed gift must not double-count the optional reserve.
        rpc('bot_review_gift_mail',p_raw={'id':'206074099','type':'giftshop'},p_evidence='Fixture untracked malformed gift; preserve unknown contents.')
        balance={'meat':'10000','items':{},'reserve':50}
        hold=json.loads(rpc('bot_refresh_gift_protection',p_snapshot=balance))
        book=json.loads(sql('select public.bot_liabilities();'))
        assert int(book['meat'])+50==10000
        assert int(hold['meat'])>0
        print('PASS: uncertain gift isolated; other same-wrapper gift and ordinary mail refunded normally; unidentified Meat/items and late arrivals protected across payouts/restarts; wrapping only uses pre-uncertainty kHub funds, once per attempt; role guards')
    finally:
        if started: pg('-m','immediate','stop')
