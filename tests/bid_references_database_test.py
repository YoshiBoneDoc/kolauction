"""Exercise admin-only bid delivery references against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/bid_references_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-bid-refs-',dir='/tmp') as folder:
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
            if not migration.name.startswith('202610220078_'): sql(migration.read_text())
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

        seller,_=account(89501,48889501,'Reference Seller')
        buyer,_=account(89502,48889502,'Reference Buyer')
        other,_=account(89503,48889503,'Reference Other')
        admin,_=account(89504,3552305,'Reference Admin')
        def create(instant=None,escrow=True):
            return sql(f"select public.create_auction('seal tooth',1,100,24,null,{instant or 'null'},2,{'true' if escrow else 'false'});",seller)
        def mail(mid,player,amount,kind,auction,items=None):
            number=sql(f"select auction_number from public.auctions where id='{auction}';")
            payload={'id':str(mid),'sender_id':player,'sender_name':'Fixture','received_at':'2026-10-22T12:00:00Z',
                'command':{'type':kind,'auction_number':number},'meat':amount,'items':items or [],'raw':{'type':'normal'}}
            return sql('select public.bot_ingest_mail('+lit(json.dumps(payload))+');')
        def read(auction,uid=None,role='authenticated',seven=False):
            return json.loads(sql(f"set role {role};select public.read_auction_page('detail','{auction}','','all','ending',1{",'all'" if seven else ''});",uid))
        auction=create()
        assert mail(89510,48889501,0,'list',auction,[{'id':2,'quantity':1}])=='accepted'
        assert mail(89511,48889502,100,'bid',auction)=='accepted'
        assert mail(89512,48889502,110,'bid',auction)=='accepted' # Own-bid raise still refunds prior full bid.
        assert mail(89513,48889503,120,'bid',auction)=='accepted'
        def snapshot():
            return sql("select jsonb_build_object('bids',(select jsonb_agg(to_jsonb(b) order by id) from public.bids b),'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from khub_bot.deliveries d),'receipts',(select jsonb_agg(to_jsonb(r) order by mail_id) from khub_bot.receipts r),'auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a));")
        ambiguous=create()
        assert mail(89530,48889501,0,'list',ambiguous,[{'id':2,'quantity':1}])=='accepted'
        assert mail(89531,48889502,100,'bid',ambiguous)=='accepted'
        # Deliberately ambiguous historical evidence must never be guessed.
        sql("insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result) select '89532',sender_id,received_at,jsonb_set(payload,'{id}','\"89532\"'),'accepted' from khub_bot.receipts where mail_id='89531';")
        before=snapshot()
        migration=next(p for p in migrations if p.name.startswith('202610220078_'))
        sql(migration.read_text())
        assert snapshot()==before
        assert sql('select count(*) from khub_bot.bid_receipts;')=='3'
        assert read(ambiguous,admin)['bids'][0]['admin_delivery_references']==[]
        for seven in [False,True]:
            bids=read(auction,admin,seven=seven)['bids']
            assert [b['amount'] for b in bids]==[100,110,120]
            assert [[d['label'] for d in b['admin_delivery_references']] for b in bids]==[['Accepted','Bid refund'],['Accepted','Bid refund'],['Accepted']]
            refs=[d['reference'] for b in bids for d in b['admin_delivery_references']]
            assert len(set(refs))==len(refs) and all(r.startswith('D-') for r in refs)
            for uid,role in [(None,'anon'),(seller,'authenticated'),(buyer,'authenticated'),(other,'authenticated')]:
                ordinary=read(auction,uid,role,seven)
                assert all('admin_delivery_references' not in b for b in ordinary['bids'])
        print('PASS: verified historical bid links, distinct acceptance/refund references, own-bid raises, both read overloads, no private fields for guests/participants/ordinary users')
        # Future bids bind to their receipt at insertion, with no worker upgrade.
        assert mail(89514,48889502,130,'bid',auction)=='accepted'
        assert mail(89514,48889502,130,'bid',auction)=='duplicate'
        assert sql('select count(*) from khub_bot.bid_receipts;')=='4'
        latest=read(auction,admin)['bids'][-1]
        assert [d['label'] for d in latest['admin_delivery_references']]==['Accepted']
        assert mail(89515,48889503,100,'bid',auction)!='accepted'
        assert sql('select count(*) from khub_bot.bid_receipts;')=='4'
        # Instant purchases have no acceptance notice; show actual excess refund
        # and winnings deliveries instead, without inventing an acknowledgement.
        instant=create(500)
        assert mail(89516,48889501,0,'list',instant,[{'id':2,'quantity':1}])=='accepted'
        assert mail(89517,48889502,600,'bid',instant)=='accepted'
        references=read(instant,admin)['bids'][0]['admin_delivery_references']
        assert {d['label'] for d in references}=={'Excess refund','Winnings'}
        direct=create(escrow=False)
        sql(f"select public.place_bid('{direct}',100);",buyer)
        assert read(direct,admin)['bids'][0]['admin_delivery_references']==[]
        expired=create()
        assert mail(89540,48889501,0,'list',expired,[{'id':2,'quantity':1}])=='accepted'
        sql(f"update public.auctions set created_at=clock_timestamp()-interval '2 days',end_time=clock_timestamp()-interval '1 second' where id='{expired}';")
        # A pre-deadline KMail timestamp does not override processing-time closure.
        assert mail(89541,48889502,100,'bid',expired)=='Bidding is closed.'
        assert read(expired,admin)['bids']==[]
        assert sql("select sum(meat) from khub_bot.deliveries where receipt_id='89541' and kind='refund';")=='100'
        reference=sql("select reference_number from khub_bot.deliveries where receipt_id='89541' and kind='refund' order by reference_number limit 1;")
        diagnostic=(ROOT/'scripts/diagnostics/d1170_bid_timing.sql').read_text().replace('where d.reference_number=1170','where d.reference_number='+reference)
        report=json.loads(sql(diagnostic))
        assert report['kmail_id']=='89541' and report['rejection_reason']=='Bidding is closed.'
        assert report['rejection_seconds_after_deadline']>0 and report['accepted_bids']==[]
        assert report['auction_number']==int(sql(f"select auction_number from public.auctions where id='{expired}';"))
        print('PASS: processing-time cutoff is unchanged; delayed pre-deadline mail is rejected and refunded, without creating a bid')
        print('PASS: future exact links, retry deduplication, rejected bids excluded, buyout excess and winnings, Direct bids have no fabricated delivery references')
        for role in ['anon','authenticated','service_role']:
            sql(f"set role {role};select * from khub_bot.bid_receipts;",error='permission denied')
            sql(f"set role {role};select khub_bot.admin_bid_delivery_references('{latest['id']}');",error='permission denied')
        # Metadata cannot grant access; restricted administrators lose access.
        sql(f"update auth.users set raw_user_meta_data='{{\"is_admin\":true}}' where id='{other}';")
        assert all('admin_delivery_references' not in b for b in read(auction,other)['bids'])
        sql("insert into khub_bot.account_bans(kol_player_id,username,reason) values(3552305,'Reference Admin','Fixture restriction');")
        assert all('admin_delivery_references' not in b for b in read(auction,admin)['bids'])
        print('PASS: private link/helper permissions, metadata spoof rejection and revoked access for restricted administrators')
    finally:
        if started: pg('-m','fast','-w','stop')
