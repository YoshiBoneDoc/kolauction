"""Buy funding confirmation wording and immutable financial/message records.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/buy_funding_message_database_test.py
"""
import json
from datetime import datetime, timezone
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
        
        read_probe="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','khub_bot') and p.prokind='f' and (p.proname like 'read_%' or p.proname in ('bot_tick','bot_finish_inbox_scan','finalize_auction','finalize_expired_auctions','bot_worker_status')) and p.proname<>'read_public_auction_live_batch';"""
        for migration in migrations:
            if '193_automatic' in migration.name: before_reads=sql(read_probe)
            if '240_buy_funding' not in migration.name: sql(migration.read_text())
            if '193_automatic' in migration.name:
                assert sql(read_probe)==before_reads, 'Relisting changed browsing, polling or finalization entry points'
        # Capture webhook payloads locally, without network or credentials.
        sql("""create schema net;
            create table net.test_requests(body jsonb);
            create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin insert into net.test_requests values(body);return 1;end;$$;
            insert into khub_bot.public_cache_webhook_config values(true,'https://fixture.invalid/api/public-auctions/invalidate',repeat('a',64));""")
        catalog=json.loads((ROOT/'src/data/items.json').read_text())
        catalog += [{'id':1900000+i,'name':f'Untradeable fixture {i}','image':'test.gif','tradeable':False}
            for i in range(max(0,10000-len(catalog)))]
        sql('select public.bot_replace_item_catalog('+lit(json.dumps(catalog))+",now(),repeat('a',64));")
        def account(mid,player,name):
            payload={'id':str(mid),'sender_id':player,'sender_name':name,'received_at':'2026-10-21T12:00:00Z',
                'command':{'type':'register'},'meat':0,'items':[],'raw':{'id':str(mid),'fromid':str(player),'fromname':name,'type':'normal','message':'REGISTER'}}
            job=json.loads(sql('select public.bot_prepare_account_mail('+lit(json.dumps(payload))+",'Kh9!FixturePassword');"))
            sql(f"insert into auth.users(id,email,encrypted_password,raw_app_meta_data) values('{job['user_id']}',{lit(job['login_email'])},'fixture-hash',"+lit(json.dumps({'khub_account_job':str(mid)}))+');')
            sql(f"select public.bot_finish_account_job('{mid}');")
            sql(f"insert into auth.sessions values('{uuid4()}','{job['user_id']}');")
            return job['user_id']
        owner=account(99001,48889901,'Relist Seller')
        other=account(99002,48889902,'Relist Buyer')
        aid=sql("select public.create_buy_auction(2,1,4000000,24,'immediate');",owner)
        number=sql(f"select auction_number from public.auctions where id='{aid}';")
        mail={'id':'99100','sender_id':48889901,'sender_name':'Relist Seller','received_at':'2026-11-07T12:00:00Z',
            'command':{'type':'fund','auction_id':aid},'meat':4170000,'items':[],
            'raw':{'id':'99100','fromid':'48889901','fromname':'Relist Seller','type':'normal','message':'FUND '+aid}}
        assert sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(mail))+');')=='accepted'
        query=f"select khub_bot.friendly_message(d) from khub_bot.deliveries d where auction_id='{aid}' and dedupe_key like 'buy-funded:%';"
        assert 'Fees are determined separately' in sql(query)
        sql(f"update khub_bot.deliveries set display_message='Previously frozen confirmation' where auction_id='{aid}' and dedupe_key like 'buy-funded:%';")
        snapshot="select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'receipts',(select jsonb_agg(to_jsonb(r) order by mail_id) from khub_bot.receipts r),'orders',(select jsonb_agg(to_jsonb(o) order by auction_id) from khub_bot.buy_orders o),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));"
        before=sql(snapshot)
        sql(next(p for p in migrations if '240_buy_funding' in p.name).read_text())
        assert sql(snapshot)==before,'Formatting migration changed saved financial/message data'
        body=sql(query)
        expected=(f'Buy auction #{number}: your Meat deposit has been accepted. Your order is active.\n\n'
            'Purchase funds: 4,000,000 Meat\nCommission reserve (4.25%): 170,000 Meat\n\n'
            'The reserve uses the standard commission rate, but promotional discounts may reduce your actual fees. Any unused reserve is refunded.')
        assert body==expected,(body,expected)
        assert sql(f"select coalesce(d.display_message,khub_bot.friendly_message(d)) from khub_bot.deliveries d where auction_id='{aid}' and dedupe_key like 'buy-funded:%';")=='Previously frozen confirmation'
        print('PASS exact Buy deposit confirmation layout and preserved frozen messages/accounting')
    finally:
        if started: pg('-m','immediate','-w','stop')
