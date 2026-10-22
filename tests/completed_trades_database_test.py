"""Exercise recent completed-trade ordering and privacy against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/completed_trades_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-completed-',dir='/tmp') as folder:
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

        seller,_=account(89401,48889401,'Completed Seller')
        buyer,_=account(89402,48889402,'Completed Buyer')
        ordinary,_=account(89403,48889403,'Ordinary Viewer')
        completed=[]
        for i in range(31):
            ident=str(uuid4());completed.append(ident)
            # Listing order is deliberately the reverse of completion order.
            sql(f"""insert into public.auctions(id,seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,
                item_id,seller_kol_id,escrow_mode,created_at,end_time,current_bid,highest_bidder_id,highest_bidder_username,
                winner_id,winner_username,final_price,finalized_at,status,seller_confirmed_at,buyer_confirmed_at,settled_at,completed_at)
                values('{ident}','{seller}','Completed Seller','CompletedFixture {i}',1,100,24,
                2,48889401,{'true' if i%2 else 'false'},'2026-10-01'::timestamptz-interval '{i} hours','2026-10-02',500,
                '{buyer}','Completed Buyer','{buyer}','Completed Buyer',500,'2026-10-02','completed',
                '2026-10-03','2026-10-03','2026-10-03','2026-10-03'::timestamptz+interval '{i} hours');""")
        for status in ['active','awaiting_trade','settling','cancelled','voided','ended_no_bids','on_hold','pending_escrow']:
            sql(f"""insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,
                item_id,seller_kol_id,escrow_mode,end_time,status) values('{seller}','Completed Seller','Excluded {status}',1,100,24,2,48889401,true,
                clock_timestamp()+interval '1 day','{status}');""")
        def read(page=1,role='anon',uid=None,trade=None):
            extra=','+lit(trade) if trade else ''
            return json.loads(sql(f"set role {role};select public.read_auction_page('browse',null,'','completed','completed',{page}{extra});",uid))
        before=sql("select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;")
        for role,uid in [('anon',None),('authenticated',ordinary),('authenticated',seller)]:
            first=read(role=role,uid=uid);second=read(2,role,uid)
            assert first['total']==31
            assert [r['id'] for r in first['rows']]==list(reversed(completed))[:24]
            assert [r['id'] for r in second['rows']]==list(reversed(completed))[24:]
            assert all(r['status']=='completed' and r['completed_at'] for r in first['rows'])
            if uid is None:
                assert all(r['winner_id'] is None and r['highest_bidder_id'] is None for r in first['rows'])
                assert all(r['winner_username']!='Completed Buyer' for r in first['rows'])
            if uid != seller:
                assert all(r['highest_bidder_id'] is None and r['settlement_contacts'] is None for r in first['rows'])
            assert first['privacy_version']==1
        for trade in ['all','escrow','direct']:
            expected=[ident for i,ident in reversed(list(enumerate(completed))) if trade=='all' or bool(i%2)==(trade=='escrow')]
            result=read(trade=trade)
            assert result['total']==len(expected)
            assert [r['id'] for r in result['rows']]==expected[:24]
        print('PASS: only completed Direct/Escrow trades; completion-time ordering before 24-row pagination; both reader overloads; guest identity masking and private participant contact checks')
        migration=next(p for p in migrations if p.name.startswith('202610220077_'))
        sql(migration.read_text())
        assert sql("select jsonb_agg(to_jsonb(a) order by id) from public.auctions a;")==before
        assert [r['id'] for r in read()['rows']]==list(reversed(completed))[:24]
        print('PASS: migration can be reapplied and never changes auction or settlement records')
    finally:
        if started: pg('-m','fast','-w','stop')
