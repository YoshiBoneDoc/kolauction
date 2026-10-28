"""Exercise completed bidder privacy and administrator announcement permissions.
Creates a disposable local PostgreSQL database; no live Supabase or KoL calls.
Run: python3 tests/site_updates_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-site-updates-',dir='/tmp') as folder:
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
            sql(migration.read_text())
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

        from concurrent.futures import ThreadPoolExecutor
        buyer,_=account(91001,48889101,'Buy Order Buyer')
        seller,_=account(91002,48889102,'Fill Seller One')
        seller2,_=account(91003,48889103,'Fill Seller Two')
        admin,_=account(91004,3552305,'Buy Order Admin')
        item=int(sql('select id from khub_bot.catalog where is_current and tradeable order by id limit 1;'))
        def call(query,uid=buyer,error=None):return sql('set role authenticated;'+query,uid,error)
        # Private table and administrator write/read guards apply at the database.
        assert sql('set role anon;select public.read_site_banner();')==''
        call('select public.read_admin_site_banner();',seller,error='Administrator access required')
        call("select public.save_site_banner('spoof',true);",seller,error='Administrator access required')
        sql("set role anon;select public.save_site_banner('spoof',true);",error='permission denied')
        call('select * from khub_bot.site_banner;',seller,error='permission denied')
        def save(message,active=True):return json.loads(call('select public.save_site_banner('+lit(message)+','+str(active).lower()+');',admin))
        call("select public.save_site_banner('  ',true);",admin,error='Enter a message')
        call('select public.save_site_banner('+lit('x'*2001)+',true);',admin,error='Enter a message')
        first=save('A public update <script>alert(1)</script>')
        visible=json.loads(sql('set role anon;select public.read_site_banner();'))
        assert set(visible)=={'message','revision'} and visible['revision']==first['revision']
        assert save(first['message'])['revision']==first['revision']
        changed=save('Second update');assert changed['revision']!=first['revision']
        save('Second update',False);assert sql('set role anon;select public.read_site_banner();')==''
        assert save('Second update')['revision']!=changed['revision']
        save('',False)
        assert json.loads(call('select public.read_admin_site_banner();',admin))['message']==''

        # Fixture trades test every reader overload and real completion boundaries.
        def fixture(escrow):
            ident=sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,end_time,item_id,seller_kol_id,item_escrowed_at,escrow_mode,status) values('{buyer}','Buy Order Buyer','Fixture',1,100,24,now()+interval '1 day',{item},48889101,now(),{str(escrow).lower()},'active') returning id;")
            for uid,name,amount in [(seller,'Fill Seller One',100),(seller2,'Fill Seller Two',200)]:
                sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{ident}','{uid}','{name}',{amount});")
            return ident
        def read(ident,uid,extra=''):
            role='authenticated' if uid else 'anon'
            return json.loads(sql(f"set role {role};select public.read_auction_page('detail','{ident}','','all','ending',1{extra});",uid))
        for escrow in [False,True]:
            ident=fixture(escrow)
            for extra in ['',",'all'",",'all','all'"]:
                rows=read(ident,buyer,extra)['bids']
                assert {b['bidder_username'] for b in rows}=={'Bidder 1','Bidder 2'},rows
            sql(f"update public.auctions set winner_id='{seller2}',winner_username='Fill Seller Two',finalized_at=now(),final_price=200,status='settling' where id='{ident}';")
            rows=read(ident,buyer)['bids']
            assert {b['bidder_username'] for b in rows}=={'Bidder 1','Fill Seller Two'},rows
            sql(f"update public.auctions set status='completed',completed_at=now(),settled_at=now(),seller_confirmed_at=now(),buyer_confirmed_at=now() where id='{ident}';")
            for extra in ['',",'all'",",'all','all'"]:
                page_data=read(ident,buyer,extra)
                assert {b['bidder_username'] for b in page_data['bids']}=={'Fill Seller One','Fill Seller Two'},page_data
                assert all(b['bidder_id'] is None for b in page_data['bids'])
                assert all(b['bidder_username'].startswith('Bidder ') for b in read(ident,None,extra)['bids'])
            assert read(ident,seller)['bids'][0]['bidder_username']=='Fill Seller One'
            admin_rows=read(ident,admin)['bids']
            assert all(b['bidder_id'] and 'admin_delivery_references' in b for b in admin_rows)
            sql(f"update auth.users set banned_until=now()+interval '1 day' where id='{buyer}';")
            assert all(b['bidder_username'].startswith('Bidder ') for b in read(ident,buyer)['bids'])
            sql(f"update khub_bot.account_bans set active=false where kol_player_id=48889101;update auth.users set banned_until=null where id='{buyer}';")
            sql(f"update public.auctions set status='cancelled' where id='{ident}';")
            assert read(ident,buyer)['bids'][0]['bidder_username']=='Bidder 1'
        print('PASS: completed bid names across all reader overloads; pending winner-only, guest/banned privacy, private IDs and admin references; admin banner guards, publish/hide/revision dismissal semantics')
    finally:
        if started:pg('-m','fast','-w','stop')
