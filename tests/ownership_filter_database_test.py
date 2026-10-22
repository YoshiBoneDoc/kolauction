"""Exercise ownership-filter pagination and privacy against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/ownership_filter_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-ownership-',dir='/tmp') as folder:
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

        viewer,_=account(89901,48889901,'Ownership Viewer')
        other,_=account(89902,48889902,'Ownership Other')
        own=[];others=[]
        for i in range(87):
            mine=i%3==0 or i>=83
            owner=viewer if mine else other
            ident=str(uuid4());(own if mine else others).append((i,ident))
            sql(f"""insert into public.auctions(id,seller_id,seller_username,item,item_id,seller_kol_id,quantity,min_bid_meat,duration_hours,
                escrow_mode,created_at,end_time,status) values('{ident}','{owner}','Fixture seller','OwnershipFixture {i}',2,
                {48889901 if mine else 48889902},1,{100+i},24,{'true' if i%2 else 'false'},
                clock_timestamp()-interval '2 days'+interval '{i} minutes',clock_timestamp()+interval '{i+1} hours','active');""")
        def read(view='others',page=1,trade=None,role='authenticated',uid=viewer,search='OwnershipFixture',ident=None,sort='newest'):
            extra=','+lit(trade) if trade else ''
            return json.loads(sql(f"set role {role};select public.read_auction_page({lit(view)},{lit(ident) if ident else 'null'},{lit(search)},'active',{lit(sort)},{page}{extra});",uid))
        def snapshot():return sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        before=snapshot()
        for trade in [None,'all','escrow','direct','none']:
            expected=[(i,ident) for i,ident in reversed(others) if trade in [None,'all'] or trade!='none' and bool(i%2)==(trade=='escrow')]
            first=read(trade=trade)
            rows=first['rows']+read(page=2,trade=trade)['rows']+read(page=3,trade=trade)['rows']
            assert first['total']==len(expected)
            assert [r['id'] for r in rows]==[ident for _,ident in expected]
            assert all(r['seller_id']!=viewer for r in rows)
            assert first['seller'] is None and first['privacy_version']==1
        assert len(others)>48
        assert read()['total']+read('seller',ident=viewer)['total']==read('browse')['total']
        assert read(search='OwnershipFixture 1')['total']==len([i for i,_ in others if str(i).startswith('1')])
        assert read(ident=other)['total']==len(others) # A supplied ID cannot override auth.uid().
        assert read(uid=other)['total']==len(own)
        guest=read(role='anon',uid=None)
        assert guest['rows']==[] and guest['total']==0
        assert read('browse',role='anon',uid=None)['total']==87
        assert snapshot()==before
        print('PASS: other sellers filtered before 24-row pagination and counts, combined search/trade controls, own/all complement, auth-bound exclusion, guest privacy and unchanged records')
    finally:
        if started: pg('-m','fast','-w','stop')
