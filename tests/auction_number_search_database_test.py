"""Hidden Gems ranking, quote completeness, freshness and read privacy.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/public_listing_projection_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-public-projection-',dir='/tmp') as folder:
    data=Path(folder)/'data'
    subprocess.run([str(BIN/'initdb'),'-D',str(data),'-A','trust','--no-locale','--encoding=UTF8'],check=True,capture_output=True)
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
        sql("create schema storage; create table storage.buckets(id text primary key,public boolean); insert into storage.buckets values('creator-photos',false); create table storage.objects(bucket_id text,name text);")
        migrations=sorted([*ROOT.glob('supabase/migrations/*.sql'),*ROOT.glob('supabase/migrations/queue/*.sql')],key=lambda p:p.name)
        assert len({p.name for p in migrations})==len(migrations)
        
        for migration in migrations: sql(migration.read_text())
        user=str(uuid4())
        sql(f"set session_replication_role=replica; insert into auth.users(id,email) values('{user}','search@fixture.invalid'); insert into public.profiles(id,khub_username) values('{user}','SearchFixture'); set session_replication_role=origin;")
        def listing(name):
            return sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,end_time,status,escrow_mode) values('{user}','SearchFixture',{lit(name)},1,100,24,now()+interval '1 hour','active',false) returning id;")
        exact=listing('unrelated name')
        number=sql(f"select auction_number from public.auctions where id='{exact}';")
        named=listing('Item '+number+' edition')
        other=listing('unrelated item')
        def search(term,public=True):
            if public:
                query=f"select public.read_public_auction_page('browse',null,{lit(term)},'active','ending',1,'all','all',null,null);"
            else:
                query=f"select public.read_filtered_auction_page('browse',null,{lit(term)},'active','ending',1,'all','all',null,null);"
            return json.loads(sql(query,user))
        for public in [True,False]:
            result=search(number,public)
            assert {r['id'] for r in result['rows']}=={exact,named},result
            assert search('9'*120,public)['rows']==[]
            assert {r['id'] for r in search(' '+number+' ',public)['rows']}=={exact,named}
        print('PASS: public/private database search combines exact auction number with literal item names; whitespace and oversized numeric inputs')
    finally:
        if started: pg('-m','immediate','-w','stop')
