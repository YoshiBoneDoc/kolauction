"""Exercise manual pre-launch cleanup against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/prelaunch_cleanup_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-cleanup-',dir='/tmp') as folder:
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
        catalog=json.loads((ROOT/'src/data/items.json').read_text())
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
        admin,_=account(81001,3552305,'teres Minor')
        manual,manual_mail=account(81002,4888002,'Manual Tester')
        helper,_=account(81003,4888003,'Helper Admin')
        sql(f"insert into khub_bot.administrators(user_id,note) values('{helper}','Private administrator fixture');")
        sql((ROOT/'supabase/testing/seed_test_accounts.sql').read_text())
        test_user=sql("select user_id from khub_bot.test_accounts where username='banned';")
        sql(f"select public.set_account_restriction('{test_user}','Test ban before launch');",admin)
        sql(f"select public.submit_support_ticket('{uuid4()}','Please clear this private test support ticket.');",admin)
        admin_lot=sql("select public.create_auction('seal tooth',1,100,24,null,null,2,false);",admin)
        manual_lot=sql("select public.create_auction('seal tooth',1,100,24,null,null,2,false);",manual)
        cleanup=(ROOT/'supabase/testing/prelaunch_cleanup.sql').read_text()
        assert cleanup.count("values ('all_prelaunch',false)")==1
        def run_cleanup(scope='all_prelaunch',apply=False,error=None):
            return sql(cleanup.replace("values ('all_prelaunch',false)",f"values ('{scope}',{'true' if apply else 'false'})"),error=error)
        def fingerprint():
            return {t:sql(f"select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') from {t} x;")
                for t in ['auth.users','auth.sessions','public.profiles','public.auctions','public.bids','khub_bot.deliveries',
                    'khub_bot.account_jobs','khub_bot.receipts','khub_bot.bug_reports','khub_bot.account_bans']}
        original=fingerprint();preview=run_cleanup();assert fingerprint()==original
        assert preview.split('|',2)[:2]==['PREVIEW ONLY','0'],preview
        assert sql("select to_regclass('khub_bot.prelaunch_auction_archive') is null;")=='t'
        # Uncertain zero-asset messages must block, not just uncertain Meat.
        uncertain=sql(f"select id from khub_bot.deliveries where receipt_id='81001' limit 1;")
        sql(f"update khub_bot.deliveries set state='unknown',attempt=gen_random_uuid() where id='{uncertain}';")
        blocked=fingerprint();run_cleanup(apply=True,error='Cleanup blocked');assert fingerprint()==blocked
        sql(f"update khub_bot.deliveries set state='pending',attempt=null where id='{uncertain}';")
        # Deliberately synthetic isolated obligations: no actual transfer exists.
        sql(f"select khub_bot.queue('cleanup-fixture-payment','{admin_lot}',null,3552305,'refund',7,'[]','Fixture payment');")
        pending=sql("select id from khub_bot.deliveries where dedupe_key like 'cleanup-fixture-payment:%';")
        blocked=fingerprint();run_cleanup(apply=True,error='Cleanup blocked');assert fingerprint()==blocked
        # Seed-only cleanup leaves unrelated manual accounts/admin auctions alone.
        run_cleanup(scope='seeded_only',apply=True)
        assert sql('select count(*) from khub_bot.test_accounts;')=='0'
        assert sql('select count(*) from khub_bot.test_auction_fixtures;')=='0'
        assert sql('select count(*) from khub_bot.account_bans where kol_player_id between 9000000001 and 9000000006;')=='0'
        assert sql(f"select count(*) from auth.users where id in ('{admin}','{manual}','{helper}');")=='3'
        assert sql(f"select count(*) from public.auctions where id in ('{admin_lot}','{manual_lot}');")=='2'
        assert sql('select count(*) from khub_bot.bug_reports;')=='0'
        assert sql(f"select state from khub_bot.deliveries where id='{pending}';")=='pending'
        # Mark only this test fixture as terminal; this is NOT a production fix
        # for uncertain/pending deliveries. It has never contacted a KoL server.
        sql(f"update khub_bot.deliveries set state='sent',sent_at=now(),display_message='Fixture confirmed attachment',evidence='Isolated test, no real transfer' where id='{pending}';")
        sql(f"select khub_bot.queue_closet('cleanup-fixture-fee','sale_fee',null,'{admin_lot}',1,'[]');")
        closet=sql("select id from khub_bot.closet_transfers where dedupe_key like 'cleanup-fixture-fee:%';")
        blocked=fingerprint();run_cleanup(apply=True,error='Cleanup blocked');assert fingerprint()==blocked
        sql(f"update khub_bot.closet_transfers set state='moved',moved_at=now(),evidence='Isolated fixture; no real move' where id='{closet}';")
        # An unfinished registration with no Auth user must not reappear later.
        pending_mail={'id':'81004','sender_id':4888004,'sender_name':'Pending Tester','received_at':'2026-10-21T12:00:00Z',
            'command':{'type':'register'},'meat':0,'items':[],
            'raw':{'id':'81004','fromid':'4888004','fromname':'Pending Tester','type':'normal','message':'REGISTER'}}
        sql('select public.bot_prepare_account_mail('+lit(json.dumps(pending_mail))+",'Kh9!PendingPassword');")
        admin_auth=sql(f"select to_jsonb(u) from auth.users u where id='{admin}';")
        receipts=sql('select jsonb_agg(to_jsonb(r) order by mail_id) from khub_bot.receipts r;')
        sent=sql(f"select to_jsonb(d)-'auction_id' from khub_bot.deliveries d where id='{pending}';")
        sequence=sql('select last_value from public.auctions_auction_number_seq;')
        run_cleanup(apply=True)
        assert sql('select count(*) from public.auctions;')=='0'
        assert sql('select count(*) from public.bids;')=='0'
        assert sql('select count(*) from khub_bot.bug_reports;')=='0'
        assert sql('select count(*) from auth.users;')=='1'
        assert sql("select state||':'||(temporary_password is null)::text from khub_bot.account_jobs where mail_id='81004';")=='done:true'
        assert sql(f"select auction_id is null and state='moved' from khub_bot.closet_transfers where id='{closet}';")=='t'
        assert sql(f"select to_jsonb(u) from auth.users u where id='{admin}';")==admin_auth
        assert sql(f"select count(*) from auth.sessions where user_id in ('{manual}','{helper}');")=='0'
        assert sql(f"select count(*) from auth.sessions where user_id='{admin}';")=='1'
        assert sql(f"select count(*) from khub_bot.administrators where user_id='{helper}';")=='0'
        assert sql('select jsonb_agg(to_jsonb(r) order by mail_id) from khub_bot.receipts r;')==receipts
        assert sql(f"select to_jsonb(d)-'auction_id' from khub_bot.deliveries d where id='{pending}';")==sent
        assert sql(f"select auction_id is null from khub_bot.deliveries where id='{pending}';")=='t'
        assert sql(f"select auction_data->>'item' from khub_bot.prelaunch_auction_archive where auction_id='{admin_lot}';")=='seal tooth'
        assert sql('select last_value from public.auctions_auction_number_seq;')==sequence
        assert sql("select count(*) from khub_bot.catalog where is_current;")==str(len(catalog))
        assert sql("select count(*) from khub_bot.deliveries where state='pending' and receipt_id='81002';")=='0'
        replay=json.loads(sql('select public.bot_prepare_account_mail('+lit(json.dumps(manual_mail))+",'Kh9!DifferentPassword');"))
        assert replay=={'state':'done'}
        assert sql('select count(*) from auth.users;')=='1'
        for role in ['anon','authenticated']:
            sql(f'set role {role};select * from khub_bot.prelaunch_auction_archive;',error='permission denied')
        run_cleanup(apply=True) # Repeat safely; no identities or sequences reset.
        assert sql('select count(*) from auth.users;')=='1'
        print('PASS: preview is read-only; seeded/full scopes; only teres Minor/hash/session preservation (other admins removed); inbox/reports/test-ban deletion; real asset and uncertain-notice blockers roll back; sent financial evidence and receipts retained; old account-mail replay stays consumed; catalog/sequences preserved; archive private; repeat cleanup safe.')
    finally:
        if started: pg('-m','fast','-w','stop')
