"""Exercise permanent inbox and poll deletion against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/inbox_deletion_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-inbox-deletion-',dir='/tmp') as folder:
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
            path=Path(folder)/f'query-{uuid4()}.sql'
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
            if migration.name<'202610240107_':sql(migration.read_text())
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
        admin,_=account(89701,3552305,'Delete Admin')
        member,_=account(89702,48889702,'Delete Member')
        other,_=account(89703,48889703,'Delete Other')
        def call(query,uid=admin,error=None):return sql('set role authenticated;'+query,uid,error)
        def report(body='A private inbox message',category='other',poll=None):
            ident=str(uuid4())
            sql(f"insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category,poll_id) values('{ident}','{member}','Delete Member',48889702,{lit(body)},{lit(category)},{lit(poll) if poll else 'null'});")
            return ident
        def inbox():return json.loads(call("select public.read_support_threads('all','all',1);"))
        def ids(threads):return [m['id'] for t in threads['threads'] for m in t['messages']]
        first=report('Erase this private text','bug');untouched=report('Do not touch this unrelated message')
        appeal=report('Erase this appeal and image','appeal')
        sql(f"insert into khub_bot.appeal_evidence(report_id,reporter_id,mime_type,content) values('{appeal}','{member}','image/png',decode('89504e470d0a1a0a','hex'));")
        before=sql('select jsonb_agg(to_jsonb(r) order by id) from khub_bot.bug_reports r;')
        migration=next(p for p in migrations if p.name.startswith('202610240107_'))
        sql(migration.read_text())
        after=json.loads(sql('select jsonb_agg(to_jsonb(r) order by id) from khub_bot.bug_reports r;'))
        for r in after:r.pop('deleted_at');r.pop('deleted_by')
        assert after==json.loads(before)
        for name,args in [('delete_support_message',f"'{first}'"),('delete_support_thread',f"'{first}',false,array['{first}']::uuid[]"),('delete_home_poll',f"'{uuid4()}'")]:
            call(f'select public.{name}({args});',member,error='Administrator access required')
            sql(f'set role anon;select public.{name}({args});',error='permission denied')
        call(f"select khub_bot.purge_inbox_messages(array['{first}']::uuid[]);",error='permission denied')
        call(f"select public.delete_support_message('{first}');")
        call(f"select public.delete_support_message('{first}');")
        assert first not in ids(inbox()) and untouched in ids(inbox())
        assert sql(f"select body from khub_bot.bug_reports where id='{first}';")=='[Permanently deleted]'
        assert sql(f"select deleted_by from khub_bot.bug_reports where id='{first}';")==admin
        for reader in ["read_support_inbox('all','all',1)","read_bug_report_inbox('all',1)"]:
            assert first not in call('select public.'+reader+';')
        call(f"select public.delete_support_message('{appeal}');")
        assert sql(f"select count(*) from khub_bot.appeal_evidence where report_id='{appeal}';")=='0'
        sql(f"update khub_bot.bug_reports set body='An attempted restore',deleted_at=null,deleted_by=null where id='{first}';")
        assert first not in ids(inbox())
        assert sql(f"select body from khub_bot.bug_reports where id='{first}';")=='[Permanently deleted]'
        print('PASS: migration preserves existing data; admin-only deletion; erased text/images; old/new inbox readers exclude deletions; retries and reopen paths cannot restore content')

        # Preserve the underlying trade outcome, rating, payout and recovery links.
        auction=sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,created_at,end_time,status,winner_id,winner_username,final_price) values('{member}','Delete Member','Trade fixture',1,100,24,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day','awaiting_trade','{other}','Delete Other',100) returning id;")
        rating=report('A trade report explanation','trade');query=report('A query in the same trade','trade')
        sql(f"insert into khub_bot.trade_reports(report_id,auction_id,reporter_id,reporter_role,counts_negative) values('{rating}','{auction}','{member}','seller',true);")
        sql(f"insert into khub_bot.trade_queries values('{query}','{auction}','{member}');")
        sql(f"insert into khub_bot.trade_rating_reviews(report_id,administrator_id,previous_counted,counted,reason) values('{rating}','{admin}',false,true,'Fixture review history');")
        sql(f"insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer) values('delete-fixture-notice',48889702,'notice','Existing notification','Existing notification','');")
        delivery=sql("select id from khub_bot.deliveries where dedupe_key='delete-fixture-notice';")
        sql(f"insert into khub_bot.bug_report_deliveries values('{rating}','{delivery}');")
        saved=sql(f"select jsonb_build_object('auction',(select to_jsonb(a) from public.auctions a where id='{auction}'),'rating',(select to_jsonb(t) from khub_bot.trade_reports t where report_id='{rating}'),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        call(f"select public.delete_support_thread('{auction}',true,array['{rating}']::uuid[]);",error='conversation changed')
        assert rating in ids(inbox())
        call(f"select public.delete_support_thread('{auction}',false,array['{untouched}']::uuid[]);")
        assert untouched in ids(inbox())
        args=f"'{auction}',true,array['{rating}','{query}']::uuid[]"
        with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(lambda _:call(f'select public.delete_support_thread({args});'),range(2)))
        assert rating not in ids(inbox()) and query not in ids(inbox())
        assert saved==sql(f"select jsonb_build_object('auction',(select to_jsonb(a) from public.auctions a where id='{auction}'),'rating',(select to_jsonb(t) from khub_bot.trade_reports t where report_id='{rating}'),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d));")
        assert sql(f"select count(*) from khub_bot.trade_rating_reviews where report_id='{rating}';")=='1'
        new_query=report('A new query after deletion','trade');sql(f"insert into khub_bot.trade_queries values('{new_query}','{auction}','{member}');")
        assert new_query in ids(inbox()) and rating not in ids(inbox())
        print('PASS: atomic grouped deletion, stale confirmation rejection, retry/concurrent delete safety, unchanged trade/ratings/financial records, new messages remain usable')

        # Delete text content in both storage locations without erasing participation.
        sql("update khub_bot.site_polls set active=false,closed_at=clock_timestamp() where active;")
        poll=call("select public.save_poll_draft('What should we improve about this marketplace?',null,'free_text',true,'{}');")
        call(f"select public.publish_poll('{poll}');")
        response=str(uuid4());second=str(uuid4())
        call(f"select public.respond_to_home_poll('{poll}','Erase my first response','{response}');",member)
        call(f"select public.respond_to_home_poll('{poll}','Keep my second response','{second}');",member)
        call(f"select public.delete_support_message('{response}');")
        assert sql(f"select response_text from khub_bot.site_poll_votes where poll_id='{poll}' and voter_id='{member}';")=='[Permanently deleted]'
        assert json.loads(sql(f"select khub_bot.poll_results('{poll}');"))['total']==1
        assert response not in ids(inbox()) and second in ids(inbox())
        feed=json.loads(call('select public.read_home_poll_feed();',member));assert feed['poll'] is None
        # A response that arrived after confirmation must not be silently deleted.
        third=str(uuid4());call(f"select public.respond_to_home_poll('{poll}','New response while confirming','{third}');",member)
        call(f"select public.delete_support_thread('{poll}',false,array['{second}']::uuid[]);",error='conversation changed')
        call(f"select public.close_home_poll('{poll}');")
        call(f"select public.delete_support_thread('{poll}',false,array['{second}','{third}']::uuid[]);")
        assert sql(f"select final_results->>'total' from khub_bot.site_polls where id='{poll}';")=='0'
        assert sql(f"select count(*) from khub_bot.site_polls where id='{poll}';")=='1'
        call(f"select public.delete_home_poll('{poll}');");call(f"select public.delete_home_poll('{poll}');")
        assert sql(f"select count(*) from khub_bot.site_polls where id='{poll}';")=='0'
        assert sql(f"select count(*) from khub_bot.site_poll_votes where poll_id='{poll}';")=='0'
        assert sql(f"select count(*) from khub_bot.bug_reports where poll_id='{poll}';")=='0'
        assert poll not in call('select public.read_admin_polls();')
        print('PASS: text deletion erases duplicate vote text, preserves answered state, groups responses, checks stale confirmations and removes concluded poll snapshots')

        for kind in ['yes_no','multiple_choice','free_text']:
            choices="array['First choice','Second choice']" if kind=='multiple_choice' else "'{}'"
            ident=call(f"select public.save_poll_draft('A permanent deletion test for {kind}?',null,'{kind}',false,{choices});")
            if kind=='yes_no':
                # Draft deletion is also supported.
                draft=call("select public.save_poll_draft('A private draft that should be deletable?');")
                call(f"select public.delete_home_poll('{draft}');")
            call(f"select public.publish_poll('{ident}');")
            if kind=='yes_no':call(f"select public.vote_home_poll('{ident}',true);",member)
            elif kind=='multiple_choice':call(f"select public.vote_home_poll_choice('{ident}',1);",member)
            else:
                call(f"select public.skip_home_poll('{ident}');",other)
                call(f"select public.respond_to_home_poll('{ident}','My private response','{uuid4()}');",member)
            call(f"select public.delete_home_poll('{ident}');")
            assert ident not in call('select public.read_home_poll_feed();',member)
            assert sql(f"select count(*) from khub_bot.site_poll_skips where poll_id='{ident}';")=='0'
        assert untouched in ids(inbox())
        print('PASS: drafts/live/concluded Yes-No, multiple-choice and text polls delete completely, including votes/skips/response text; unrelated conversations survive')

        # Concurrent voters either finish before deletion or receive a closed
        # poll error. Neither ordering may leave an orphaned vote or live poll.
        for kind in ['yes_no','multiple_choice']:
            choices="array['First choice','Second choice']" if kind=='multiple_choice' else "'{}'"
            ident=call(f"select public.save_poll_draft('Can this {kind} poll be removed safely?',null,'{kind}',false,{choices});")
            call(f"select public.publish_poll('{ident}');")
            vote=f"select public.vote_home_poll('{ident}',true);" if kind=='yes_no' else f"select public.vote_home_poll_choice('{ident}',1);"
            def concurrent_vote():
                try:call('begin;'+vote+"select pg_sleep(0.1);commit;",member)
                except AssertionError as failure:assert 'closed' in str(failure).lower(),str(failure)
            with ThreadPoolExecutor(max_workers=2) as pool:
                voter=pool.submit(concurrent_vote)
                deleter=pool.submit(call,f"select public.delete_home_poll('{ident}');")
                voter.result();deleter.result()
            assert sql(f"select count(*) from khub_bot.site_poll_votes where poll_id='{ident}';")=='0'
            assert sql(f"select count(*) from khub_bot.site_polls where id='{ident}';")=='0'

        # Erased rows cannot consume page slots or inflate inbox counts.
        bulk=[report(f'Page fixture message {i}') for i in range(22)]
        for ident in bulk[:20]:call(f"select public.delete_support_message('{ident}');")
        current=inbox()
        assert current['total']==len(current['threads'])
        assert all(ident in ids(current) for ident in bulk[20:])
        assert all(ident not in ids(current) for ident in bulk[:20])
        print('PASS: concurrent vote/deletion locking and deleted-row filtering before pagination/totals')
    finally:
        if started:pg('-m','immediate','-w','stop')
