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
            if migration.name=='202611030181_saved_auctions.sql':
                before_projection=sql(financial_probe)
            sql(migration.read_text())
        assert before_projection==sql(financial_probe), 'Financial definitions changed'

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

        assert sql(financial_probe)==before_projection
        print('PASS: ownership/ACL, due times, five-minute grace, late preferences, extensions, cancellation/completion, tombstones and unchanged financial functions.')
    finally:
        if started:pg('-m','immediate','-w','stop')
