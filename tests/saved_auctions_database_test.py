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
        
        financial_probe="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','khub_bot') and p.prokind='f' and p.proname in ('bot_ingest_mail','bot_tick','bot_claim_delivery','bot_ack_delivery','finish_listing','finish_buy_order','bot_liabilities');"""
        for migration in migrations:
            before_projection=sql(financial_probe)
            sql(migration.read_text())
            if 'saved_' in migration.name or 'bookmark' in migration.name:
                assert before_projection==sql(financial_probe), 'Bookmark migration changed financial definitions'

        definitions="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname in ('public','khub_bot') and p.prokind='f' and p.proname in
            ('bot_ingest_mail','bot_tick','bot_claim_delivery','bot_ack_delivery','finish_listing','finish_buy_order','bot_liabilities');"""
        financial_before=sql(definitions)
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
        owner=account(98001,48889801,'Traffic Seller')
        other=account(98002,48889802,'Traffic Buyer')
        restricted=account(98003,48889803,'Restricted Viewer')
        sql("insert into khub_bot.account_bans(kol_player_id,username,reason) values(48889803,'Restricted Viewer','Local restriction fixture');")
        aid=sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,end_time,status) values('{owner}','Traffic Seller','Saved fixture',1,100,24,now()+interval '1 hour','active') returning id;")
        def save(uid, minutes=15, saved=True):
            sql(f"set role authenticated; select public.set_saved_auction('{aid}',{str(saved).lower()},{minutes},'America/New_York');reset role;",uid)
        def read(uid):
            return json.loads(sql("set role authenticated;select public.read_saved_auctions();reset role;",uid))['rows']
        save(other)
        assert len(read(other))==1 and read(owner)==[]
        buy_id=sql("set role authenticated;select public.create_buy_auction(2,1,100,24,'immediate');reset role",owner)
        sql(f"update public.auctions set status='active' where id='{buy_id}'")
        for listing_id in [aid,buy_id]:
            for viewer in [owner,other]:
                sql(f"select public.set_saved_auction('{listing_id}',true,0,'UTC')",viewer)
            assert sql(f"set role anon;select bookmark_count from public.read_auction_bookmark_counts(array['{listing_id}'::uuid]);reset role")=='1'
            assert next(row for row in read(owner) if row['id']==listing_id)['is_host']
            sql(f"select public.set_saved_auction('{listing_id}',false,0,'UTC')",other)
            assert sql(f"set role anon;select bookmark_count from public.read_auction_bookmark_counts(array['{listing_id}'::uuid]);reset role")=='0'
            assert any(row['id']==listing_id for row in read(owner))
            sql(f"select public.set_saved_auction('{listing_id}',false,0,'UTC')",owner)
        save(other)

        preference_before=sql(f"select preference_set_at from khub_bot.saved_auctions where user_id='{other}' and auction_id='{aid}';")
        sql(f"set role authenticated;select public.set_saved_auction('{aid}',true,15,'Asia/Kolkata');reset role;",other)
        assert preference_before==sql(f"select preference_set_at from khub_bot.saved_auctions where user_id='{other}' and auction_id='{aid}';")
        sql(f"set role authenticated;select public.set_saved_auction('{aid}',true,15,'Invalid/Zone');reset role;",other,error='Invalid time zone')

        sql(f"set role authenticated;select * from khub_bot.saved_auctions;",other,error='permission denied')
        sql("set role anon;select public.read_saved_auctions();reset role;",error='permission denied')
        sql("set role authenticated;select public.bot_claim_saved_reminder();reset role;",other,error='permission denied')
        assert sql('select public.bot_claim_saved_reminder();')=='', 'Not due yet'
        # Selecting a preference after its threshold must not cause immediate mail.
        sql(f"update public.auctions set end_time=now()+interval '14 minutes' where id='{aid}';")
        assert sql('select public.bot_claim_saved_reminder();')==''
        # Simulate a preference set before the threshold, with a slightly late poll.
        sql(f"update khub_bot.saved_auctions set preference_set_at=now()-interval '1 hour' where auction_id='{aid}';")
        claim=json.loads(sql('set role service_role;select public.bot_claim_saved_reminder();reset role;'))
        assert claim['auction_id']==aid and claim['recipient_id']==48889802
        assert claim['time_zone']=='Asia/Kolkata'
        assert claim['quantity']=='1' and claim['is_bundle'] is False
        assert sql('select public.bot_claim_saved_reminder();')==''
        assert sql(f"select public.bot_start_saved_reminder('{claim['id']}');")
        assert sql(f"select public.bot_start_saved_reminder('{claim['id']}');")==''
        save(other,0,False);save(other,30)
        sql(f"update public.auctions set end_time=now()+interval '29 minutes' where id='{aid}';")
        sql(f"update khub_bot.saved_auctions set preference_set_at=now()-interval '1 hour' where auction_id='{aid}';")
        assert sql('select public.bot_claim_saved_reminder();')=='', 'Unsave/re-save must not reset the durable attempt'
        sql(f"select public.bot_ack_saved_reminder('{claim['id']}');")
        assert read(other)[0]['reminder_outcome']=='sent'
        # A second user has an independent reminder; extensions use the live deadline.
        save(owner,15)
        sql(f"update khub_bot.saved_auctions set preference_set_at=now()-interval '1 hour' where user_id='{owner}';")
        sql(f"update public.auctions set end_time=now()+interval '20 minutes' where id='{aid}';")
        assert sql('select public.bot_claim_saved_reminder();')==''
        sql(f"update public.auctions set end_time=now()+interval '9 minutes' where id='{aid}';")
        assert sql('select public.bot_claim_saved_reminder();')=='', 'Beyond five-minute grace'
        sql(f"update public.auctions set end_time=now()+interval '11 minutes',status='cancelled' where id='{aid}';")
        assert sql('select public.bot_claim_saved_reminder();')==''
        sql(f"update public.auctions set status='completed',seller_confirmed_at=now(),buyer_confirmed_at=now(),completed_at=now() where id='{aid}';")
        assert sql('select public.bot_claim_saved_reminder();')==''
        sql(f"update public.auctions set status='active' where id='{aid}';")
        second=json.loads(sql('select public.bot_claim_saved_reminder();'))
        assert second['recipient_id']==48889801
        sql(f"update public.auctions set end_time=now()+interval '25 minutes' where id='{aid}';")
        assert sql(f"select public.bot_start_saved_reminder('{second['id']}');")=='', 'Extension between claim and send must postpone delivery'
        assert sql('select public.bot_claim_saved_reminder();')=='', 'An abandoned claim is consumed conservatively'
        assert sql("set role service_role;select public.bot_worker_status()->>'savedRemindersVersion';reset role;")=='1'

        # Profile hides final outcomes at 72 hours without deleting bookmarks or
        # their permanent send-attempt records. Active/held/unsettled rows remain.
        for status in ['completed','cancelled','voided','expired','ended_no_bids']:
            for hours, expected in [(71,True),(73,False)]:
                case_id=sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,end_time,status,completed_at,seller_confirmed_at,buyer_confirmed_at,cancelled_at,expired_at,finalized_at) values('{owner}','Traffic Seller','History fixture',1,100,24,now()+interval '1 day','{status}',now()-interval '{hours} hours',now(),now(),now()-interval '{hours} hours',now()-interval '{hours} hours',now()-interval '{hours} hours') returning id;")
                sql(f"select public.set_saved_auction('{case_id}',true,0);",other)
                assert any(row['id']==case_id for row in read(other))==expected,(status,hours)
                detail=json.loads(sql(f"select public.read_saved_auctions('{case_id}');",other))['rows']
                assert len(detail)==1
        for status in ['active','on_hold','awaiting_trade','settling']:
            sql(f"update public.auctions set status='{status}',created_at=now()-interval '20 days',end_time=now()-interval '10 days' where id='{aid}';")
            assert any(row['id']==aid for row in read(other)),status
        sql(f"update public.auctions set status='completed',completed_at=now()-interval '73 hours' where id='{aid}';")
        assert not any(row['id']==aid for row in read(other))
        archived=json.loads(sql(f"select public.read_saved_auctions('{aid}');",other))['rows'][0]
        assert archived['reminder_attempted'] and archived['reminder_outcome']=='sent'
        # Hundreds of hidden records must not prevent a new current bookmark.
        sql(f"with history as (insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,end_time,status,cancelled_at) select '{owner}','Traffic Seller','Old archive '||n,1,100,24,now()+interval '1 day','cancelled',now()-interval '5 days' from generate_series(1,200) n returning id) insert into khub_bot.saved_auctions(user_id,auction_id) select '{owner}',id from history;")
        new_id=sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,end_time,status) values('{owner}','Traffic Seller','Current bookmark',1,100,24,now()+interval '1 day','active') returning id;")
        sql(f"set role authenticated;select public.set_saved_auction('{new_id}',true,0);reset role;",owner)
        assert any(row['id']==new_id for row in read(owner))

        # Defaults are user-scoped; existing choices change only on Apply to all.
        sql("set role anon;select public.set_saved_reminder_default(15);reset role;",error='permission denied')
        sql("select public.set_saved_reminder_default(7);",other,error='Invalid reminder preference')
        sql("select public.set_saved_reminder_default(60,false,'America/New_York');",other)
        assert json.loads(sql('select public.read_saved_auctions();',other))['default_reminder_minutes']==60
        assert json.loads(sql('select public.read_saved_auctions();',owner))['default_reminder_minutes']==0
        sql(f"select public.set_saved_auction('{new_id}',true,null,'America/New_York');",other)
        saved_row=next(row for row in read(other) if row['id']==new_id)
        assert saved_row['reminder_minutes']==60
        assert saved_row['quantity']=='1' and saved_row['auction_kind']=='sell' and saved_row['escrow_mode'] is False
        assert saved_row['bundle_items']==[] and saved_row['current_bid']=='0'
        assert not set(saved_row) & {'seller_id','seller_username','highest_bidder_id','winner_id','balance_meat','funding_required','my_reservation'}

        sql(f"select public.set_saved_auction('{new_id}',true,15,'America/New_York');",other)
        sql("select public.set_saved_reminder_default(30,false,'America/New_York');",other)
        assert next(row for row in read(other) if row['id']==new_id)['reminder_minutes']==15
        sql("select public.set_saved_reminder_default(30,true,'America/New_York');",other)
        assert next(row for row in read(other) if row['id']==new_id)['reminder_minutes']==30
        assert next(row for row in read(owner) if row['id']==new_id)['reminder_minutes']==0
        assert sql(f"select outcome from khub_bot.saved_auctions where user_id='{other}' and auction_id='{aid}';")=='sent'
        sql("set role authenticated;select * from khub_bot.saved_auction_preferences;reset role;",other,error='permission denied')
        sql(f"update public.auctions set end_time=now()+interval '29 minutes' where id='{new_id}';")
        sql(f"update khub_bot.saved_auctions set preference_set_at=now()-interval '1 hour' where user_id='{other}' and auction_id='{new_id}';")
        bulk_claim=json.loads(sql('select public.bot_claim_saved_reminder();'))
        assert bulk_claim['auction_id']==new_id
        assert sql(f"select public.bot_start_saved_reminder('{bulk_claim['id']}');")
        sql("select public.set_saved_reminder_default(15,true,'America/New_York');",other)
        retained=json.loads(sql(f"select jsonb_build_object('attempt',attempt,'started',send_started,'outcome',outcome) from khub_bot.saved_auctions where user_id='{other}' and auction_id='{new_id}';"))
        assert retained=={'attempt':bulk_claim['id'],'started':True,'outcome':'unknown'}
        assert sql('select public.bot_claim_saved_reminder();')==''
        assert sql(financial_probe)==before_projection
        for viewer in [owner,other,restricted]:
            full=json.loads(sql('select public.read_saved_auctions();',viewer))['rows']
            ids=json.loads(sql('set role authenticated;select public.read_saved_auction_ids();reset role;',viewer))
            assert ids==[row['id'] for row in full], (viewer,ids,full)
        sql('set role anon;select public.read_saved_auction_ids();reset role;',error='permission denied')
        sql('select public.read_saved_auction_ids();',error='Sign in')
        for rpc in ['read_saved_auctions','read_saved_auction_ids']:
            times=[]
            for _ in range(5):
                plan=json.loads(sql(f'explain (analyze,buffers,format json) select public.{rpc}()',other))
                times.append(plan[0]['Execution Time'])
            print(rpc,'five local fixture execution ms:',times)
        print('PASS: saved-auction ownership, reminders, 72-hour final-outcome expiry, ongoing exclusions, detail bookmarks, archive-independent limit and unchanged financial functions.')
    finally:
        if started:pg('-m','immediate','-w','stop')
