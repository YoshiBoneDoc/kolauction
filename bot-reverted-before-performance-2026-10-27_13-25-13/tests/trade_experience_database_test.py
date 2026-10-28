"""Exercise persistent trade response and independent experience reminders.
Creates a disposable local PostgreSQL database; no live Supabase or KoL calls.
Run: python3 tests/trade_experience_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-trade-experience-',dir='/tmp') as folder:
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
        # Apply existing behavior before testing the privacy upgrade.
        for migration in migrations:
            if migration.name<'202610230094_': sql(migration.read_text())
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

        buyer,_=account(91001,48889101,'Buy Order Buyer')
        seller,_=account(91002,48889102,'Fill Seller One')
        seller2,_=account(91003,48889103,'Fill Seller Two')
        admin,_=account(91004,3552305,'Buy Order Admin')
        def pending(uid,page=1):return json.loads(sql(f"set role authenticated;select public.read_pending_trades({page});",uid))
        def ids(uid):return {a['id'] for a in pending(uid)['rows']}
        def create(status='awaiting_trade',escrow=False):
            ident=str(uuid4())
            sql(f"insert into public.auctions(id,seller_id,seller_username,item,quantity,min_bid_meat,duration_hours,created_at,end_time,escrow_mode,status,finalized_at,winner_id,winner_username,final_price,current_bid,seller_confirmed_at,buyer_confirmed_at,completed_at,settled_at,item_id,seller_kol_id) values('{ident}','{seller}','Seller','Trade fixture',2,100,24,now()-interval '2 days',now()-interval '1 hour',{str(escrow).lower()},'{status}',now(),'{buyer}','Buyer',200,200,{'now()' if status=='completed' else 'null'},{'now()' if status=='completed' else 'null'},{'now()' if status=='completed' else 'null'},now(),1,48889102);")
            return ident
        unanswered=create()
        confirmed=create()
        sql(f"update public.auctions set seller_confirmed_at=now() where id='{confirmed}';")
        negative=create()
        sql(f"set role authenticated;select public.submit_trade_report('{uuid4()}','{negative}','The agreed items were not delivered.');",seller)
        completed=create('completed')
        sql(f"update public.auctions set seller_confirmed_at=now(),buyer_confirmed_at=now() where id='{completed}';")
        escrow=create('completed',True)
        before=sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'feedback',(select jsonb_agg(to_jsonb(f)) from khub_bot.trade_feedback f),'reports',(select jsonb_agg(to_jsonb(t)) from khub_bot.trade_reports t));")
        assert confirmed not in ids(seller) and negative not in ids(seller)
        migration=next(p for p in migrations if p.name.startswith('202610230094_'))
        sql(migration.read_text())
        assert before==sql("select jsonb_build_object('auctions',(select jsonb_agg(to_jsonb(a) order by id) from public.auctions a),'feedback',(select jsonb_agg(to_jsonb(f)) from khub_bot.trade_feedback f),'reports',(select jsonb_agg(to_jsonb(t)) from khub_bot.trade_reports t));")
        assert ids(seller)=={unanswered,confirmed,negative,completed}
        assert ids(buyer)=={unanswered,confirmed,negative,completed}
        assert pending(seller2)['total']==0 and pending(admin)['total']==0
        assert escrow not in ids(seller)
        assert sql("set role authenticated;select public.read_pending_trades();") and json.loads(sql("select public.read_pending_trades();"))['total']==0
        sql('set role anon;select public.read_pending_trades();',error='permission denied')
        sql(f"set role authenticated;select public.rate_trade_partner('{unanswered}',1);",seller,error='before rating')
        states=sql("select jsonb_agg(jsonb_build_array(id,status,seller_confirmed_at,buyer_confirmed_at,completed_at,settled_at,item_id,seller_kol_id) order by id) from public.auctions;")
        for ident,rating in [(confirmed,-1),(negative,1),(completed,-1)]:
            sql(f"set role authenticated;select public.rate_trade_partner('{ident}',{rating});",seller)
            assert ident not in ids(seller) and ident in ids(buyer)
        assert sql("select jsonb_agg(jsonb_build_array(id,status,seller_confirmed_at,buyer_confirmed_at,completed_at,settled_at,item_id,seller_kol_id) order by id) from public.auctions;")==states
        assert ids(seller)=={unanswered}
        # Stable pages count both unanswered trades and pending ratings, without duplication.
        for _ in range(15):create()
        first,second=pending(seller),pending(seller,2)
        assert first['total']==16 and second['total']==16 and len(first['rows'])==12 and len(second['rows'])==4
        assert not {a['id'] for a in first['rows']} & {a['id'] for a in second['rows']}
        banned=json.loads(sql(f"begin;update auth.users set banned_until=now()+interval '1 day' where id='{seller}';set request.jwt.claim.sub='{seller}';set role authenticated;select public.read_pending_trades();rollback;"))
        assert banned['total']==0 and banned['rows']==[]
        print('PASS: answered and incomplete Direct trades retain private rating reminders; saved votes remove only own reminders; completion unchanged; completed-trade ratings, pagination, restricted/guest/outsider and escrow guards')
    finally:
        if started:pg('-m','fast','-w','stop')
