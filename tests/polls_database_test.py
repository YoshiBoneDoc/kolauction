"""Exercise homepage poll voting and result privacy against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/polls_database_test.py
"""
import json
from concurrent.futures import ThreadPoolExecutor
import time
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-polls-',dir='/tmp') as folder:
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
        # Historical single-poll upgrades are covered here; poll_queue_database_test.py covers 083.
        migrations=[p for p in migrations if not p.name.startswith(('202610220083_', '202610220084_'))]
        poll_migration=next(path for path in migrations if path.name.startswith('202610220075_'))
        for migration in migrations:
            if migration!=poll_migration and not migration.name.startswith('202610220076_'): sql(migration.read_text())
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

        first,_=account(89901,48889901,'Poll voter one')
        second,_=account(89902,48889902,'Poll voter two')
        administrator,_=account(89903,3552305,'Poll administrator')
        sql(poll_migration.read_text())
        def read(uid): return json.loads(sql("set role authenticated; select coalesce(public.read_home_poll(),'null'::jsonb);",uid))
        poll=read(first)
        assert poll['question']=='Should sellers have the option to end auctions early if they’re happy with the current bid?'
        assert not poll['can_manage'] and not poll['has_voted'] and 'results' not in poll
        ident=poll['id']
        def vote(uid,answer): return sql(f"set role authenticated; select public.vote_home_poll('{ident}',{answer});",uid)
        vote(first,'true');vote(first,'true');vote(first,'false')
        assert read(first) is None
        assert sql(f"select count(*)=1 and bool_and(answer) from khub_bot.site_poll_votes where voter_id='{first}';")=='t'
        remaining=read(second)
        assert 'results' not in remaining and not remaining['can_manage']
        results=read(administrator)['results']
        assert results=={'yes':1,'no':0,'total':1},results
        print('PASS: exact poll wording; one immutable vote per account, idempotent retries, hidden after voting, no public result counts')
        # Opposing submissions for one account cannot produce duplicate votes.
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures=[executor.submit(vote,second,answer) for answer in ['true','false']]
            for future in futures: future.result()
        assert sql(f"select count(*) from khub_bot.site_poll_votes where voter_id='{second}';")=='1'
        assert read(administrator)['results']['total']==2
        print('PASS: concurrent Yes/No requests count exactly once; administrator totals stay accurate')
        for table in ['site_polls','site_poll_votes']:
            sql(f'set role authenticated; select * from khub_bot.{table};',first,error='permission denied')
            sql(f'set role anon; select * from khub_bot.{table};',error='permission denied')
        for query in ['select public.read_home_poll();',f"select public.vote_home_poll('{ident}',true);",f"select public.close_home_poll('{ident}');"]:
            sql('set role anon; '+query,error='permission denied')
        sql(f"set role authenticated; select public.close_home_poll('{ident}');",first,error='Administrator access required')
        sql(f"set role authenticated; select public.vote_home_poll('{ident}',null);",first,error='Choose Yes or No')
        sql("insert into khub_bot.account_bans(kol_player_id,username,reason) values(48889902,'Poll voter two','Poll test restriction');")
        sql('set role authenticated; select public.read_home_poll();',second,error='restricted')
        sql(f"set role authenticated; select public.vote_home_poll('{ident}',true);",second,error='restricted')
        print('PASS: guests, restricted accounts, direct table access and non-admin poll management are blocked by the database')
        sql(f"set role authenticated; select public.close_home_poll('{ident}');",administrator)
        assert read(first) is None
        closed=read(administrator)
        assert closed['active'] is False and closed['results']['total']==2
        sql(f"set role authenticated; select public.vote_home_poll('{ident}',true);",first,error='closed')
        vote_admin=sql(f"select count(*) from khub_bot.site_poll_votes where voter_id='{administrator}';")
        assert vote_admin=='0'
        print('PASS: closing hides the poll from users, rejects later votes and retains admin-only results')
        # Management, archived snapshots and explicitly published summaries.
        def admin_call(query): return sql('set role authenticated; '+query,administrator)
        def feed(uid): return json.loads(sql('set role authenticated; select public.read_home_poll_feed();',uid))
        def archive(): return json.loads(admin_call('select public.read_admin_polls();'))
        assert archive()[0]['final_results']['total']==2
        assert feed(first)['published_results']==[]
        draft=admin_call("select public.save_poll_draft('Should we try another feature?');")
        assert read(first) is None # Creating a draft does not deliver it.
        assert archive()[0]['published_at'] is None
        admin_call(f"select public.save_poll_draft('Should we test this next feature?', '{draft}');")
        assert archive()[0]['question']=='Should we test this next feature?'
        admin_call(f"select public.publish_poll_results('{ident}',true);")
        summary=feed(first)['published_results']
        assert len(summary)==1 and summary[0]['id']==ident and summary[0]['results']['total']==2
        sql(f"delete from khub_bot.site_poll_votes where poll_id='{ident}' and voter_id='{second}';")
        assert feed(first)['published_results'][0]['results']['total']==2 # Archived snapshot survives account/vote cleanup.
        admin_call(f"select public.publish_poll('{draft}');")
        assert read(first)['id']==draft
        sql(f"set role authenticated; select public.vote_home_poll('{draft}',false);",first)
        assert read(first) is None # One vote per poll, not one vote forever.
        third=admin_call("select public.save_poll_draft('Should we try a third idea?');")
        sql(f"set role authenticated; select public.publish_poll('{third}');",administrator,error='Conclude the current poll')
        assert next(p for p in archive() if p['id']==draft)['active']
        admin_call(f"select public.publish_poll('{third}',true);")
        history=archive()
        assert sum(p['active'] for p in history)==1
        assert next(p for p in history if p['id']==draft)['final_results']=={'yes':0,'no':1,'total':1}
        assert feed(first)['poll']['id']==third and feed(first)['published_results'][0]['id']==ident
        admin_call(f"select public.publish_poll_results('{ident}',false);")
        assert feed(first)['published_results']==[]
        assert next(p for p in archive() if p['id']==ident)['results']['total']==2
        print('PASS: private editable drafts, publish-on-demand, atomic conclude-and-publish, per-poll voting, retained frozen history and opt-in results alongside the next poll')
        for query in ["select public.read_admin_polls();", "select public.save_poll_draft('Unauthorized poll question?');", f"select public.publish_poll('{third}',true);",f"select public.publish_poll_results('{ident}',true);"]:
            sql('set role authenticated; '+query,first,error='Administrator access required')
        sql(f"set role authenticated; select public.save_poll_draft('Changed live question?', '{third}');",administrator,error='Only unpublished drafts')
        sql(f"set role authenticated; select public.publish_poll('{ident}');",administrator,error='cannot be reopened')
        sql(f"set role authenticated; select public.publish_poll_results('{third}',true);",administrator,error='Conclude the poll')
        print('PASS: ordinary users cannot create/edit/conclude/publish/manage results, live questions cannot change, concluded polls cannot reopen, and live counts cannot be published')
        # Conclusion waits for an in-flight vote and freezes its committed total.
        with ThreadPoolExecutor(max_workers=1) as executor:
            holding=executor.submit(sql,f"set role authenticated; begin; select public.vote_home_poll('{third}',true); select pg_sleep(1); commit;",first)
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                if sql("select exists(select 1 from pg_locks where relation='khub_bot.site_polls'::regclass and mode='RowShareLock' and granted and pid<>pg_backend_pid());")=='t': break
                time.sleep(0.01)
            else: raise AssertionError('Vote did not acquire its shared lock')
            admin_call(f"select public.close_home_poll('{third}');")
            holding.result()
        assert next(p for p in archive() if p['id']==third)['final_results']=={'yes':1,'no':0,'total':1}
        print('PASS: concurrent conclusion includes the last committed vote in the permanent results snapshot')
        before_live=sql("select jsonb_build_object('polls',(select jsonb_agg(to_jsonb(p) order by id) from khub_bot.site_polls p),'votes',(select jsonb_agg(to_jsonb(v) order by poll_id,voter_id) from khub_bot.site_poll_votes v));")
        live_migration=next(path for path in migrations if path.name.startswith('202610220076_'))
        sql(live_migration.read_text())
        assert sql("select jsonb_build_object('polls',(select jsonb_agg(to_jsonb(p) order by id) from khub_bot.site_polls p),'votes',(select jsonb_agg(to_jsonb(v) order by poll_id,voter_id) from khub_bot.site_poll_votes v));")==before_live
        fourth=admin_call("select public.save_poll_draft('Should we show live results?');")
        admin_call(f"select public.publish_poll('{fourth}');")
        assert 'results' not in read(first) and read(first)['has_voted'] is False
        sql(f"set role authenticated; select public.vote_home_poll('{fourth}',true);",first)
        result=read(first)
        assert result['has_voted'] and result['results']=={'yes':1,'no':0,'total':1}
        sql(f"set role authenticated; select public.vote_home_poll('{fourth}',false);",administrator)
        assert read(first)['results']=={'yes':1,'no':1,'total':2}
        assert 'Poll voter' not in json.dumps(feed(first)) and 'Poll administrator' not in json.dumps(feed(first))
        names=json.loads(admin_call(f"select public.read_poll_voters('{fourth}');"))
        assert names=={'yes':['Poll voter one'],'no':['Poll administrator']},names
        for role,uid in [('anon',None),('authenticated',first)]:
            sql(f"set role {role}; select public.read_poll_voters('{fourth}');",uid,error='permission denied' if role=='anon' else 'Administrator access required')
        sql(f"set role authenticated; select public.read_poll_voters('{fourth}');",second,error='restricted')
        sql('set role anon; select public.read_home_poll_feed();',error='permission denied')
        assert json.loads(admin_call(f"select public.read_poll_voters('{third}');"))['yes']==['Poll voter one']
        admin_call(f"select public.close_home_poll('{fourth}');")
        assert read(first) is None
        admin_call(f"select public.publish_poll_results('{fourth}',true);")
        visible=feed(first)['published_results'][0]
        assert visible['results']=={'yes':1,'no':1,'total':2} and 'Poll voter' not in json.dumps(visible)
        print('PASS: live counts only after voting, refreshed totals, unchanged saved votes/results, admin-only per-answer usernames for live/archived polls and no identity leaks through public summaries')
    finally:
        if started: pg('-m','fast','-w','stop')
