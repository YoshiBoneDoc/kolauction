"""Operator gift-return financial safety against ALL local SQL migrations.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/operator_gift_returns_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-bot-only-expiration-',dir='/tmp') as folder:
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

        seller,_=account(97001,48889601,'Gift Sender')
        sql("update khub_bot.deliveries set state='sent',sent_at=clock_timestamp();")
        def rpc(name,*values):return sql('set role service_role;select public.'+name+'('+','.join(lit(json.dumps(value))+'::jsonb' if isinstance(value,(dict,list)) else lit(str(value)) for value in values)+');')
        payloads={}
        def opened(mid,meat=0,items=None,command=None):
            mid=str(mid);items=items or [];epoch=sql('select floor(extract(epoch from clock_timestamp()))::bigint;')
            envelope={'id':mid,'type':'giftshop','fromid':'48889601','fromname':'Gift Sender','azunixtime':epoch,'message':'DONATE<table class="item" rel="id=1167&n=1"><tr><td><img></td></tr></table>'}
            if command:envelope['message']=envelope['message'].replace('DONATE','BID 999999')
            original={**envelope,'message':envelope['message']+'<p>Inside Note:<p>Fixture gift'}
            payload={'id':mid,'sender_id':48889601,'sender_name':'Gift Sender','received_at':sql(f'select to_timestamp({epoch});'),
                'command':command or {'type':'donation'},'meat':meat,'items':items,'raw':{**envelope,'type':'normal','message':'BID 999999' if command else 'DONATE','gift_original':original}}
            rpc('bot_register_gift_mail',[{'id':mid,'wrapper_id':1167,'opened':False,'raw':envelope}])
            owed=json.loads(rpc('bot_liabilities'))
            before={'meat':str(int(owed['meat'])+1000000),'items':dict(owed['items'])};before['items']['1167']=str(int(before['items'].get('1167',0))+10)
            attempt=json.loads(rpc('bot_claim_gift_open',before));assert attempt
            after={'meat':str(int(before['meat'])+meat),'items':dict(before['items'])};after['items']['1167']=str(int(after['items']['1167'])-1)
            for entry in items:after['items'][str(entry['id'])]=str(int(after['items'].get(str(entry['id']),0))+entry['quantity'])
            rpc('bot_finish_gift_open',attempt['id'],payload,after)
            payloads[mid]=payload
            return attempt['id']
        known=opened(97100,2000000005,[{'id':2,'quantity':5000000000},{'id':364,'quantity':7}])
        opened(97101) # verified empty
        opened(97102,50,[{'id':2,'quantity':1}]) # processed before manual confirmation
        opened(97103,60) # historical donation guard
        opened(97104,70) # forced rollback
        opened(97105,80) # preview / worker race
        opened(97107,90,command={'type':'bid','auction_number':'999999'})
        unopened={'id':'97106','type':'giftshop','fromid':'48889601','fromname':'Gift Sender','azunixtime':sql('select floor(extract(epoch from clock_timestamp()))::bigint;'),'message':'Fixture unopened'}
        rpc('bot_register_gift_mail',[{'id':'97106','wrapper_id':1167,'opened':False,'raw':unopened}])
        sql("update khub_bot.incoming_gifts set legacy_donation=true where mail_id='97103';")
        assert rpc('bot_ingest_donation',payloads['97102']) =='accepted'
        for mid,reason in [('999999','No registered'),('97106','not been verified'),('97101','no Meat or items'),('97102','processing'),('97103','Historical donations')]:
            preview=json.loads(rpc('bot_preview_gift_return',mid));assert preview['eligible'] is False and reason in preview['blocked_reason'],preview
            sql(f"set role service_role;select public.bot_return_gift('{mid}','untrusted','Fixture: return verified contents to their sender.');",error=reason)
        sql("set role anon;select public.bot_preview_gift_return('97100');",error='permission denied')
        sql("set role authenticated;select public.bot_return_gift('97100','x','Fixture verified reason long enough.');",error='permission denied')
        print('PASS: unknown/unopened/empty/processed/historical gifts refused; public roles cannot preview or queue returns')
        scan=json.loads(rpc('bot_begin_inbox_scan'))['id']
        rpc('bot_stage_inbox_scan',scan,[payloads['97107']])
        staged=json.loads(rpc('bot_preview_gift_return','97107'));assert staged['eligible']
        rpc('bot_return_gift','97107',staged['fingerprint'],'Fixture: return unprocessed staged bid contents.')
        assert sql("select processed from khub_bot.inbox_bid_mail where mail_id='97107';")=='t'
        assert rpc('bot_ingest_mail',payloads['97107'])=='duplicate'
        assert sql("select proconfig @> array['lock_timeout=5s'] from pg_proc where oid='public.bot_return_gift(text,text,text)'::regprocedure;")=='t'
        preview=json.loads(rpc('bot_preview_gift_return','97100'));assert preview['eligible'] and not preview['already_queued']
        before=rpc('bot_liabilities')
        sql("select public.bot_return_gift('97100','stale','Fixture: return verified gift contents.');",error='preview changed')
        sql("select public.bot_return_gift('97100',"+lit(preview['fingerprint'])+",'short');",error='at least 20')
        assert sql("select count(*) from khub_bot.receipts where mail_id='97100';")=='0'
        # Prove a failure after queueing rolls back BOTH the receipt and all sends.
        rollback=json.loads(rpc('bot_preview_gift_return','97104'))
        sql("create function khub_bot.fixture_fail_return() returns trigger language plpgsql as $$begin if new.mail_id='97104' then raise exception 'fixture rollback';end if;return new;end;$$;create trigger fixture_fail_return before insert on khub_bot.gift_returns for each row execute function khub_bot.fixture_fail_return();")
        sql("select public.bot_return_gift('97104',"+lit(rollback['fingerprint'])+",'Fixture verified return with induced failure.');",error='fixture rollback')
        assert sql("select count(*) from khub_bot.receipts where mail_id='97104';")=='0'
        assert sql("select count(*) from khub_bot.deliveries where receipt_id='97104';")=='0'
        sql('drop trigger fixture_fail_return on khub_bot.gift_returns;drop function khub_bot.fixture_fail_return();')
        assert before==rpc('bot_liabilities')
        print('PASS: stale preview and short evidence rejected; receipt/queue/audit failures roll back atomically')
        # Matching opening remains isolated: the return must not dismiss its uncertainty.
        sql(f"update khub_bot.gift_open_attempts set state='isolated' where id='{known}';")
        sql("insert into khub_bot.gift_mail_reviews(mail_id,raw,evidence) values('97100','{}','Fixture contents verified; sender requested a return.');")
        from concurrent.futures import ThreadPoolExecutor
        query="set role service_role;select public.bot_return_gift('97100',"+lit(preview['fingerprint'])+",'Fixture: sender requested verified contents returned.');"
        def concurrent_return():
            result=subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',query],capture_output=True,text=True)
            assert result.returncode==0,result.stderr
            return json.loads(result.stdout)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:concurrent_return(),range(2)))
        assert results[0]['deliveries']==results[1]['deliveries']
        result=results[0];assert result['already_queued'] and len(result['deliveries'])==9
        assert sql("select sum(meat) from khub_bot.deliveries where receipt_id='97100';")=='2000000005'
        assert sql("select sum(quantity) from khub_bot.deliveries where receipt_id='97100' and item_id=2;")=='5000000000'
        assert sql("select sum(quantity) from khub_bot.deliveries where receipt_id='97100' and item_id=364;")=='7'
        assert sql("select count(*) from khub_bot.deliveries where receipt_id='97100' and (recipient_id<>48889601 or item_id=1167);")=='0'
        assert before==rpc('bot_liabilities') # liability moved from unposted gift to refunds, exactly once
        assert sql(f"select state from khub_bot.gift_open_attempts where id='{known}';")=='isolated'
        assert sql("select resolved_at is not null from khub_bot.gift_mail_reviews where mail_id='97100';")=='t'
        assert rpc('bot_ingest_donation',payloads['97100'])=='duplicate'
        print('PASS: concurrent requests queue exact chunked Meat/items once to the original sender; wrapper excluded; liabilities unchanged; separate opening stays isolated')
        # Preview can lose the race to normal worker intake; confirmation must refuse.
        racing=json.loads(rpc('bot_preview_gift_return','97105'));assert racing['eligible']
        assert rpc('bot_ingest_donation',payloads['97105']) =='accepted'
        sql("select public.bot_return_gift('97105',"+lit(racing['fingerprint'])+",'Fixture: attempt after worker already processed.');",error='processing')
        assert sql("select count(*) from khub_bot.gift_returns where mail_id='97105';")=='0'
        # Sending remains the existing durable transport contract, with frozen bodies.
        messages=json.loads(sql("select jsonb_agg(khub_bot.friendly_message(d)) from khub_bot.deliveries d where receipt_id='97100';"))
        assert all('Original KMail: 97100' in m and 'Attached in this message' in m for m in messages)
        held=result['deliveries'][0]['id']
        attempt=sql(f"update khub_bot.deliveries set state='sending',attempt=gen_random_uuid() where id='{held}' returning attempt;")
        sql(f"select public.bot_ack_delivery('{held}','{attempt}',false,'Fixture: uncertain response, no actual KoL send.');")
        repeat=json.loads(rpc('bot_return_gift','97100',preview['fingerprint'],'Fixture repeated command after uncertain response.'))
        assert any(d['id']==held and d['state']=='unknown' for d in repeat['deliveries'])
        assert sql("select count(*) from khub_bot.deliveries where receipt_id='97100';")=='9'
        for row in result['deliveries']:
            if row['id']==held:continue
            attempt=sql(f"update khub_bot.deliveries set state='sending',attempt=gen_random_uuid() where id='{row['id']}' returning attempt;")
            sql(f"select public.bot_ack_delivery('{row['id']}','{attempt}',true,'Fixture: verified simulated delivery, no real send.');")
        assert json.loads(rpc('bot_preview_gift_return','97100'))['status']=='queued_or_review'
        sql(f"select public.bot_reconcile_delivery('{held}',true,'Fixture: verified recipient and exact assets in simulated Sent Mail.');")
        assert json.loads(rpc('bot_preview_gift_return','97100'))['status']=='returned'
        assert sql("select payload=(select payload from khub_bot.incoming_gifts where mail_id='97100') from khub_bot.receipts where mail_id='97100';")=='t'
        print('PASS: worker/intake race cannot double-refund; repeats never reset uncertain sends; only actual acknowledgments/reconciliation report returned')
    finally:
        if started:pg('-m','immediate','stop')
