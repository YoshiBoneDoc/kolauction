"""Exercise private free-text polls and grouped administrator inbox responses against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/free_text_polls_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-text-polls-',dir='/tmp') as folder:
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
            if migration.name<'202610230101_':sql(migration.read_text())
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
        first,_=account(88701,48888701,'Poll First')
        second,_=account(88702,48888702,'Poll Second')
        third,_=account(88703,48888703,'Poll Third')
        admin,_=account(88704,3552305,'Poll Admin')
        def call(query,uid=admin,error=None):return sql('set role authenticated;'+query,uid,error)
        def feed(uid):return json.loads(call('select public.read_home_poll_feed();',uid))
        # Preserve historical Yes/No answers, final snapshots and all existing mail.
        active=sql('select id from khub_bot.site_polls where active;')
        call(f"select public.vote_home_poll('{active}',true);",first)
        call(f"select public.close_home_poll('{active}');")
        frozen=sql("select jsonb_build_object('polls',(select jsonb_agg(to_jsonb(p) order by id) from khub_bot.site_polls p),'votes',(select jsonb_agg(to_jsonb(v) order by poll_id,voter_id) from khub_bot.site_poll_votes v),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        sql(next(p for p in migrations if p.name.startswith('202610230101_')).read_text())
        after=json.loads(sql("select jsonb_build_object('polls',(select jsonb_agg(to_jsonb(p) order by id) from khub_bot.site_polls p),'votes',(select jsonb_agg(to_jsonb(v) order by poll_id,voter_id) from khub_bot.site_poll_votes v),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));"))
        before=json.loads(frozen)
        for p in after['polls']:p.pop('poll_type');p.pop('allow_multiple_responses')
        for v in after['votes']:v.pop('response_text');v.pop('response_report_id')
        assert after==before
        deliveries=sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')
        def draft(question='What should we improve on the marketplace?',kind='free_text',multiple=False):
            return call('select public.save_poll_draft('+lit(question)+",null,"+lit(kind)+','+str(multiple).lower()+');')
        def publish(p):call(f"select public.publish_poll('{p}');")
        def respond(p,body='A private suggestion',uid=first,key=None,error=None):
            key=key or str(uuid4())
            call(f"select public.respond_to_home_poll('{p}',{lit(body)},'{key}');",uid,error)
            return key
        def inbox(category='other',status='all',page=1):return json.loads(call(f"select public.read_support_threads('{category}','{status}',{page});"))
        def rows(p):return json.loads(sql(f"select coalesce(jsonb_agg(to_jsonb(r) order by report_number),'[]') from khub_bot.bug_reports r where poll_id='{p}';"))
        poll=draft();publish(poll)
        repeated=draft('What other suggestions do you have?',multiple=True);publish(repeated)
        yn=draft('Should we keep improving the marketplace?',kind='yes_no');publish(yn)
        assert feed(first)['poll']['poll_type']=='free_text'
        respond(repeated,uid=first,error='preceding poll')
        call(f"select public.vote_home_poll('{poll}',true);",first,error='written response')
        respond(poll,'   ',error='1 to 1,500')
        respond(poll,'a'*1501,error='1 to 1,500')
        sql(f"set role anon;select public.respond_to_home_poll('{poll}','no permission','{uuid4()}');",error='permission denied')
        call('select public.save_poll_draft(\'Should I be able to do this?\');',first,error='Administrator access')
        # Simultaneous retries yield precisely one durable report and one queue marker.
        request=str(uuid4())
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _:respond(poll,'Keep <scripts> literal & private',key=request),range(4)))
        assert len(rows(poll))==1
        respond(poll,'A changed response should not overwrite it')
        assert len(rows(poll))==1 and 'Keep <scripts> literal' in rows(poll)[0]['body']
        respond(poll,'Someone else',uid=second,key=request,error='request ID')
        respond(poll,'Second player suggestion',uid=second)
        grouped=inbox();assert grouped['total']==1
        thread=grouped['threads'][0]
        assert thread['id']==poll and thread['poll']['id']==poll and not thread['is_trade']
        assert len(thread['messages'])==2 and all(m['category']=='other' and m['message_type']=='poll_response' for m in thread['messages'])
        assert {m['reporter_username'] for m in thread['messages']}=={'Poll First','Poll Second'}
        # Neither ordinary reads nor archived published results can expose text, names or totals.
        for uid in [first,second,third]:
            payload=feed(uid)
            assert 'Keep <scripts>' not in json.dumps(payload) and 'Second player suggestion' not in json.dumps(payload)
            assert all(p.get('poll_type')!='free_text' for p in payload['answered_polls'])
        call("select public.read_support_threads('other','all',1);",first,error='Administrator access')
        sql('set role authenticated;select * from khub_bot.site_poll_votes;',error='permission denied')
        # The optional repeat control is visible only after a first answer.
        assert feed(first)['repeatable_polls']==[]
        repeat_key=respond(repeated,'First repeatable suggestion')
        repeat_feed=feed(first)
        assert repeat_feed['poll']['id']==yn
        assert repeat_feed['repeatable_polls'][0]['id']==repeated
        respond(repeated,'First repeatable suggestion',key=repeat_key)
        respond(repeated,'Another distinct suggestion')
        assert len(rows(repeated))==2
        assert json.loads(call('select public.read_admin_polls();'))[1]['results']['total']>=0
        # Resolving/reclassifying a poll thread applies to every response atomically.
        call(f"select public.update_support_thread('{repeated}',false,'resolved',null);")
        assert next(t for t in inbox(status='resolved')['threads'] if t['id']==repeated)['status']=='resolved'
        respond(repeated,'A new suggestion reopens the same thread')
        opened=inbox(status='open');assert any(t['id']==repeated and len(t['messages'])==3 for t in opened['threads'])
        call(f"select public.update_support_thread('{repeated}',false,null,'bug');")
        assert any(t['id']==repeated and len(t['messages'])==3 for t in inbox('bug')['threads'])
        # Different polls with identical questions still have different threads.
        duplicate=draft();publish(duplicate)
        call(f"select public.vote_home_poll('{yn}',false);",first)
        respond(duplicate,'Different poll, same question')
        assert len({t['id'] for t in inbox()['threads']})==inbox()['total']
        # Closing freezes all text-response counts and disables repeat submission.
        call(f"select public.close_home_poll('{repeated}');")
        assert all(p['id']!=repeated for p in feed(first)['repeatable_polls'])
        respond(repeated,'Too late',error='closed')
        respond(repeated,'First repeatable suggestion',key=repeat_key) # Lost acknowledgment remains recoverable after close.
        call(f"select public.publish_poll_results('{repeated}',true);",error='stay private')
        call(f"select public.save_poll_draft('Cannot change published settings','{poll}','free_text',true);",error='unpublished drafts')
        # Missing KoL identity is recorded honestly; no fabricated player number.
        sql(f"update public.profiles set kol_player_id=null,kol_verified_at=null where id='{third}';")
        respond(poll,'Unlinked account feedback',uid=third)
        assert rows(poll)[-1]['reporter_kol_id'] is None
        # Abuse cap applies only to repeatable submissions; retrying an existing ID remains harmless.
        cap=draft('Give us suggestions without flooding the inbox',multiple=True);publish(cap)
        # First must answer all preceding live questions in order.
        respond(repeated,uid=second,error='closed')
        for uid in [first]:
            for _ in range(10):respond(cap,'A suggestion '+str(uuid4()),uid=uid)
            respond(cap,'Over the limit',uid=uid,error='10 per hour')
        assert len(rows(cap))==10
        assert deliveries==sql('select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d;')
        # Group before pagination: many responses remain one inbox conversation.
        assert len([t for t in inbox()['threads'] if t['id']==cap])==1
        saved=sql('select jsonb_agg(to_jsonb(r) order by id) from khub_bot.bug_reports r;')
        pg('-m','fast','-w','stop');started=False
        pg('-l',str(Path(folder)/'postgres.log'),'-o',f"-F -h '' -k {folder}",'-w','start');started=True
        assert saved==sql('select jsonb_agg(to_jsonb(r) order by id) from khub_bot.bug_reports r;')
        print('PASS: private free-text polls, ordered mixed queues, optional repeat responses, idempotent/concurrent retries, per-poll inbox grouping/status/category changes, privacy, size/abuse limits, unchanged Yes/No history and zero KMail/financial side effects')
    finally:
        if started:pg('-m','fast','-w','stop')
