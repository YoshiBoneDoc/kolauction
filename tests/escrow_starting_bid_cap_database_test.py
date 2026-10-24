"""Exercise removing the temporary Escrow starting-bid restriction against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/escrow_starting_bid_cap_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-escrow-cap-',dir='/tmp') as folder:
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
            if migration.name<'202610240105_':sql(migration.read_text())
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

        seller,_=account(88701,48888701,'Escrow Cap Seller')
        item=int(sql('select id from khub_bot.catalog where is_current and tradeable order by id limit 1;'))
        name=sql(f'select name from khub_bot.catalog where id={item};')
        def create(price,escrow=True,custom=False,error=None):
            tail=",clock_timestamp()+interval '2 hours'" if custom else ''
            return sql(f"set role authenticated;select public.create_auction({lit(name)},1,{price},24,null,null,{item},{str(escrow).lower()}{tail});",seller,error)
        old=create(1000000)
        create(1000001,error='limited to a minimum bid')
        create(1000001,custom=True,error='limited to a minimum bid')
        def snapshot():return sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        before=snapshot()
        sql(next(p for p in migrations if p.name=='202610240105_remove_escrow_starting_bid_cap.sql').read_text())
        assert before==snapshot()
        for custom in [False,True]:
            for escrow in [True,False]:
                for price in [1000001,10000000,10000000000,9007199254740991]:
                    ident=create(price,escrow,custom)
                    row=json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{ident}';"))
                    assert row['min_bid_meat']==price and row['escrow_mode']==escrow
                    assert row['status']==('pending_escrow' if escrow else 'active')
                    assert (row['custom_end_at'] is not None)==custom
                create(0,escrow,custom,error='check constraint')
                create(9007199254740992,escrow,custom,error='check constraint')
        # Default Escrow signature also accepts larger bids without explicit mode.
        default=sql(f"set role authenticated;select public.create_auction({lit(name)},1,2000000,24,null,null,{item});",seller)
        assert sql(f"select escrow_mode from public.auctions where id='{default}';")=='t'
        sql(f"set role anon;select public.create_auction({lit(name)},1,2000000,24,null,null,{item});",error='permission denied')
        sql(f"set role authenticated;select public.create_auction('Not a catalog item',1,2000000,24,null,null,{item});",seller,error='current catalog item')
        print('PASS: removed 1M cap in default, explicit and custom-end Escrow creation; Direct unchanged; exact-integer price bounds, catalog and permissions preserved; existing auctions/bids/deliveries untouched')
    finally:
        if started:pg('-m','fast','-w','stop')
