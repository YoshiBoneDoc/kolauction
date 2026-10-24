"""Exercise multiple-choice polls with private pre-vote and archived results against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/multiple_choice_polls_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-choice-polls-',dir='/tmp') as folder:
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
            if migration.name<'202610230102_':sql(migration.read_text())
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
        first,_=account(88601,48888601,'Choice First')
        second,_=account(88602,48888602,'Choice Second')
        third,_=account(88603,48888603,'Choice Third')
        admin,_=account(88604,3552305,'Choice Admin')
        def call(query,uid=admin,error=None):return sql('set role authenticated;'+query,uid,error)
        def feed(uid):return json.loads(call('select public.read_home_poll_feed();',uid))
        def close(p):call(f"select public.close_home_poll('{p}');")
        def publish(p):call(f"select public.publish_poll('{p}');")
        active=sql('select id from khub_bot.site_polls where active;')
        call(f"select public.vote_home_poll('{active}',true);",first);close(active)
        old_text=call("select public.save_poll_draft('What should we improve next?',null,'free_text',true);")
        publish(old_text)
        call(f"select public.respond_to_home_poll('{old_text}','A private suggestion','{uuid4()}');",first);close(old_text)
        def snapshot():return json.loads(sql("select jsonb_build_object('polls',(select jsonb_agg(to_jsonb(p) order by id) from khub_bot.site_polls p),'votes',(select jsonb_agg(to_jsonb(v) order by poll_id,voter_id) from khub_bot.site_poll_votes v),'reports',(select jsonb_agg(to_jsonb(r) order by id) from khub_bot.bug_reports r),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));"))
        before=snapshot()
        sql(next(p for p in migrations if p.name.startswith('202610230102_')).read_text())
        after=snapshot()
        for p in after['polls']:p.pop('choices')
        for v in after['votes']:v.pop('choice_index')
        assert after==before
        def array(choices):return 'array['+','.join(lit(c) if c is not None else 'null' for c in choices)+']::text[]'
        def draft(choices,question='Which feature would you prefer next?',error=None):
            return call('select public.save_poll_draft('+lit(question)+",null,'multiple_choice',false,"+array(choices)+');',error=error)
        for choices in [[],['Only one'],['Same','same'],[' ', 'Valid'],['a'*121,'Valid'],[str(i) for i in range(9)],[None,'Valid']]:
            draft(choices,error='2 to 8 different choices')
        call("select public.save_poll_draft('Should multiple replies be allowed?',null,'multiple_choice',true,array['A','B']);",error='only available for free-text')
        first_poll=draft([' Better search ','More filters','Something else']);publish(first_poll)
        second_poll=draft(['Red','Green']);publish(second_poll)
        def vote(p,choice,uid=first,error=None):call(f"select public.vote_home_poll_choice('{p}',{choice});",uid,error)
        for uid in [first,second,third]:
            p=feed(uid)['poll'];assert p['id']==first_poll and p['choices']==['Better search','More filters','Something else']
            assert p['poll_type']=='multiple_choice' and 'results' not in p
        vote(second_poll,1,error='preceding poll')
        for choice in ['null',0,-1,4]:vote(first_poll,choice,error='listed options')
        call(f"select public.vote_home_poll('{first_poll}',true);",first,error='listed options')
        call(f"select public.respond_to_home_poll('{first_poll}','Wrong input type','{uuid4()}');",first,error='listed options')
        sql(f"set role anon;select public.vote_home_poll_choice('{first_poll}',1);",error='permission denied')
        call("select public.save_poll_draft('Can I publish my own poll?',null,'multiple_choice',false,array['A','B']);",first,error='Administrator access')
        vote(first_poll,2);vote(first_poll,1)
        assert sql(f"select choice_index from khub_bot.site_poll_votes where poll_id='{first_poll}' and voter_id='{first}';")=='2'
        assert feed(first)['poll']['id']==second_poll
        with ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(lambda choice:vote(first_poll,choice,second),[1,2,3,1]))
        assert sql(f"select count(*) from khub_bot.site_poll_votes where poll_id='{first_poll}';")=='2'
        answered=feed(first)['answered_polls'][0]
        assert answered['id']==first_poll and answered['results']['total']==2
        assert len(answered['results']['choices'])==3 and sum(c['count'] for c in answered['results']['choices'])==2
        assert feed(third)['answered_polls']==[]
        assert 'Choice First' not in json.dumps(feed(first)) and 'Choice Second' not in json.dumps(feed(first))
        admin_feed=feed(admin)
        assert admin_feed['poll'] is None and len(admin_feed['answered_polls'])==2
        voters=json.loads(call(f"select public.read_poll_voters('{first_poll}');"))
        assert 'Choice First' in voters['choices'][1]['voters']
        call(f"select public.read_poll_voters('{first_poll}');",first,error='Administrator access')
        # Options/question cannot change after publication, including during voting.
        call(f"select public.save_poll_draft('Can we rewrite a live question?','{first_poll}','multiple_choice',false,array['X','Y']);",error='unpublished drafts')
        close(first_poll)
        final=json.loads(sql(f"select final_results from khub_bot.site_polls where id='{first_poll}';"))
        assert final==answered['results']
        vote(first_poll,1,third,error='closed')
        call(f"select public.publish_poll_results('{first_poll}',true);")
        assert feed(first)['published_results'][0]['results']==final
        assert feed(third)['published_results']==[]
        # Mixed queue, existing Yes/No voting and private repeat responses remain compatible.
        legacy=call("select public.save_poll_draft('Should we keep the existing voting flow?');");publish(legacy)
        text=call("select public.save_poll_draft('What suggestions do you have now?',null,'free_text',true);");publish(text)
        vote(second_poll,1)
        call(f"select public.vote_home_poll('{legacy}',false);",first)
        key=str(uuid4());call(f"select public.respond_to_home_poll('{text}','Still private','{key}');",first)
        call(f"select public.respond_to_home_poll('{text}','Still private','{key}');",first)
        call(f"select public.respond_to_home_poll('{text}','Another response','{uuid4()}');",first)
        assert sql(f"select count(*) from khub_bot.bug_reports where poll_id='{text}';")=='2'
        assert feed(first)['repeatable_polls'][0]['id']==text
        assert 'Still private' not in json.dumps(feed(first))
        assert snapshot()['deliveries']==before['deliveries']
        # Persisted votes/results are stable across a database/worker restart.
        saved=sql("select jsonb_agg(to_jsonb(v) order by poll_id,voter_id) from khub_bot.site_poll_votes v;")
        pg('-m','fast','-w','stop');started=False
        pg('-l',str(Path(folder)/'postgres.log'),'-o',f"-F -h '' -k {folder}",'-w','start');started=True
        assert saved==sql("select jsonb_agg(to_jsonb(v) order by poll_id,voter_id) from khub_bot.site_poll_votes v;")
        assert feed(first)['published_results'][0]['results']==final
        print('PASS: multiple-choice drafts/validation, immutable single votes with concurrent retries, ordered mixed poll queue, private pre-vote counts and voter names, frozen archives, unchanged Yes/No and repeated text responses, zero delivery effects, restart persistence')
    finally:
        if started:pg('-m','fast','-w','stop')
