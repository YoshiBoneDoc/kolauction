"""Exercise multiple active polls, per-account queue and results privacy against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/poll_queue_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-poll-queue-',dir='/tmp') as folder:
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
            # Preserve the pre-queue upgrade fixture; current mixed queues are
            # covered separately by free_text_polls_database_test.py.
            if migration.name<'202610220083_': sql(migration.read_text())
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
        import time
        first,_=account(89911,48889911,'Queue First')
        second,_=account(89912,48889912,'Queue Second')
        third,_=account(89913,48889913,'Queue Third')
        admin,_=account(89914,3552305,'Queue Admin')
        def call(query,uid=admin,error=None):return sql('set role authenticated;'+query,uid,error)
        def feed(uid):return json.loads(call('select public.read_home_poll_feed();',uid))
        def draft(question):return call('select public.save_poll_draft('+lit(question)+');')
        def publish(ident):call(f"select public.publish_poll('{ident}');")
        def vote(uid,ident,answer='true',error=None):return call(f"select public.vote_home_poll('{ident}',{answer});",uid,error)
        def close(ident):call(f"select public.close_home_poll('{ident}');")
        def snapshot():return sql("select jsonb_build_object('polls',(select jsonb_agg(to_jsonb(p) order by id) from khub_bot.site_polls p),'votes',(select jsonb_agg(to_jsonb(v) order by poll_id,voter_id) from khub_bot.site_poll_votes v),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        old=feed(first)['poll']['id'];vote(first,old);close(old)
        first_poll=draft('Should this be the first queued poll?');publish(first_poll)
        before=snapshot();migration=next(p for p in migrations if p.name.startswith('202610220083_'));sql(migration.read_text());assert snapshot()==before
        before=snapshot();sql(next(p for p in migrations if p.name.startswith('202610220084_')).read_text());assert snapshot()==before
        last=draft('Should this be the third queued poll?')
        middle=draft('Should this be the second queued poll?')
        publish(middle);publish(last)
        assert sql('select count(*) from khub_bot.site_polls where active;')=='3'
        for uid in [first,second]:
            feed_data=feed(uid);assert feed_data['poll']['id']==first_poll and feed_data['answered_polls']==[]
            assert 'results' not in feed_data['poll'] and feed_data['published_results']==[]
        admin_feed=feed(admin)
        assert admin_feed['poll'] is None and admin_feed['can_manage']
        assert [p['id'] for p in admin_feed['answered_polls']]==[first_poll,middle,last]
        assert all(not p['has_voted'] and p['can_manage'] and p['results']['total']==0 for p in admin_feed['answered_polls'])
        assert json.loads(call("select coalesce(public.read_home_poll(),'null'::jsonb);")) is None
        assert sql(f"select count(*) from khub_bot.site_poll_votes where voter_id='{admin}';")=='0'
        print('PASS: admin sees all live results without voting; migrations preserve all existing votes and frozen totals')
        vote(first,last,error='preceding poll')
        call(f"select public.publish_poll('{last}',true);",error='independently')
        assert sql('select count(*) from khub_bot.site_polls where active;')=='3'
        print('PASS: upgrade preserves existing votes/frozen snapshots; multiple live polls queue by publication rather than draft order; old replacement calls cannot conclude them')
        vote(first,first_poll)
        vote(first,first_poll,'false')
        feed_data=feed(first);assert feed_data['poll']['id']==middle and [p['id'] for p in feed_data['answered_polls']]==[first_poll]
        assert feed_data['answered_polls'][0]['results']=={'yes':1,'no':0,'total':1}
        vote(first,middle,'false');assert feed(first)['poll']['id']==last
        assert [p['id'] for p in feed(first)['answered_polls']]==[first_poll,middle]
        vote(first,last);assert feed(first)['poll'] is None and len(feed(first)['answered_polls'])==3
        with ThreadPoolExecutor(max_workers=2) as pool:
            jobs=[pool.submit(vote,second,first_poll,answer) for answer in ['true','false']]
            for job in jobs:job.result()
        assert sql(f"select count(*) from khub_bot.site_poll_votes where poll_id='{first_poll}' and voter_id='{second}';")=='1'
        assert feed(first)['answered_polls'][0]['results']['total']==2
        assert feed(second)['poll']['id']==middle and len(feed(second)['answered_polls'])==1
        assert feed(third)['answered_polls']==[] and feed(third)['poll']['id']==first_poll
        assert 'Queue First' not in json.dumps(feed(first))
        print('PASS: per-user progression, immutable votes and opposite concurrent retries, live answered totals, no results for unvoted polls or voter identity leaks')
        close(first_poll);call(f"select public.publish_poll_results('{first_poll}',true);")
        assert [p['id'] for p in feed(first)['published_results']]==[first_poll]
        assert feed(third)['published_results']==[]
        assert [p['id'] for p in feed(admin)['published_results']]==[first_poll]
        assert [p['id'] for p in feed(admin)['answered_polls']]==[middle,last]
        assert feed(admin)['answered_polls'][0]['results']=={'yes':0,'no':1,'total':1}
        assert feed(third)['poll']['id']==middle
        close(last);call(f"select public.publish_poll_results('{last}',true);")
        assert last in [p['id'] for p in feed(first)['published_results']]
        assert last not in [p['id'] for p in feed(second)['published_results']]
        assert sql('select count(*) from khub_bot.site_polls where active;')=='1'
        assert feed(second)['poll']['id']==middle
        close(middle)
        assert feed(first)['answered_polls']==[] and feed(first)['poll'] is None
        assert middle not in [p['id'] for p in feed(first)['published_results']]
        records=json.loads(call('select public.read_admin_polls();'))
        assert next(p for p in records if p['id']==middle)['results']=={'yes':0,'no':1,'total':1}
        print('PASS: individual conclusion leaves other polls active; archived results require publication and a vote for ordinary users; admins can see results without voting')
        concurrent=draft('Should the final vote be frozen correctly?');publish(concurrent)
        following=draft('Should this following poll stay open?');publish(following)
        with ThreadPoolExecutor(max_workers=1) as pool:
            voting=pool.submit(call,f"begin;select public.vote_home_poll('{concurrent}',true);select pg_sleep(0.5);commit;",first)
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                if sql("select exists(select 1 from pg_locks where relation='khub_bot.site_polls'::regclass and mode='RowShareLock' and granted and pid<>pg_backend_pid());")=='t':break
                time.sleep(0.01)
            else:raise AssertionError('Concurrent voter did not obtain its shared lock')
            close(concurrent);voting.result()
        records=json.loads(call('select public.read_admin_polls();'))
        assert next(p for p in records if p['id']==concurrent)['final_results']=={'yes':1,'no':0,'total':1}
        assert next(p for p in records if p['id']==following)['active']
        assert feed(first)['poll']['id']==following
        print('PASS: conclusion waits for the in-flight vote and freezes its committed total without affecting the next poll')
        more=[draft('Should we publish parallel poll number one?'),draft('Should we publish parallel poll number two?')]
        with ThreadPoolExecutor(max_workers=2) as pool:
            for job in [pool.submit(publish,ident) for ident in more]:job.result()
        assert sql('select count(*) from khub_bot.site_polls where active;')=='3'
        for uid in [first,third]:
            call('select public.read_admin_polls();',uid,error='Administrator access required')
            call(f"select public.publish_poll('{more[0]}');",uid,error='Administrator access required')
            call(f"select public.read_poll_voters('{first_poll}');",uid,error='Administrator access required')
        for query in ['select public.read_home_poll_feed();','select public.read_home_poll();',f"select public.vote_home_poll('{following}',true);"]:
            sql('set role anon;'+query,error='permission denied')
        sql("insert into khub_bot.account_bans(kol_player_id,username,reason) values(48889912,'Queue Second','Fixture restriction');")
        call('select public.read_home_poll_feed();',second,error='restricted')
        vote(second,following,error='restricted')
        for table in ['site_polls','site_poll_votes']:
            sql(f'set role authenticated;select * from khub_bot.{table};',first,error='permission denied')
        print('PASS: concurrent publishing, administrator-only management/voter names, restricted and guest blocking, private tables')
    finally:
        if started:pg('-m','fast','-w','stop')
