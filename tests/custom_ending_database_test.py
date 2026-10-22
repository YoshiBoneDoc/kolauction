"""Exercise custom auction deadlines, validation and escrow deposits against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/custom_ending_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-custom-ending-',dir='/tmp') as folder:
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
        for migration in migrations: sql(migration.read_text())
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

        from datetime import datetime,timezone
        seller,_=account(89801,48889801,'Schedule Seller')
        buyer,_=account(89802,48889802,'Schedule Buyer')
        epoch=int(sql('select floor(extract(epoch from clock_timestamp()))::bigint;'))
        ending=datetime.fromtimestamp(epoch+2*3600+17*60,timezone.utc).isoformat()
        def create(escrow,end=ending,actor=seller,role='authenticated',minimum=100):
            return sql(f"set role {role};select public.create_auction('seal tooth',1,{minimum},24,null,null,2,{'true' if escrow else 'false'},{lit(end)}::timestamptz);",actor)
        def row(ident):return json.loads(sql(f"select to_jsonb(a) from public.auctions a where id='{ident}';"))
        def deposit(ident,mid):
            payload={'id':str(mid),'sender_id':48889801,'sender_name':'Schedule Seller','received_at':datetime.fromtimestamp(epoch,timezone.utc).isoformat(),
                'command':{'type':'list','auction_id':ident},'meat':0,'items':[{'id':2,'quantity':1}],
                'raw':{'type':'normal','azunixtime':epoch}}
            return sql('set role service_role;select public.bot_ingest_mail('+lit(json.dumps(payload))+');')
        direct=create(False);escrow=create(True)
        for ident in [direct,escrow]:
            saved=row(ident)
            assert datetime.fromisoformat(saved['end_time']).timestamp()==epoch+8220
            assert datetime.fromisoformat(saved['custom_end_at']).timestamp()==epoch+8220
            assert saved['duration_hours']==3 and not saved['start_on_deposit']
            projected=json.loads(sql(f"set role anon;select public.read_auction_page('detail','{ident}');"))
            if ident==direct:
                assert datetime.fromisoformat(projected['rows'][0]['custom_end_at']).timestamp()==epoch+8220
            else:
                assert projected['rows']==[] # Pending deposits retain seller-only visibility.
        sql(f"update public.auctions set start_on_deposit=true where id='{escrow}';",error='fixed when a listing is published')
        short=create(False,datetime.fromtimestamp(epoch+1800,timezone.utc).isoformat());assert row(short)['duration_hours']==1
        longest=create(False,datetime.fromtimestamp(epoch+30*86400,timezone.utc).isoformat());assert row(longest)['duration_hours']==720
        before=row(escrow)['end_time']
        assert deposit(escrow,89810)=='accepted'
        assert row(escrow)['end_time']==before and row(escrow)['status']=='active'
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{escrow}' and kind in ('sale_item','sale_meat');")=='0'
        sql(f"select public.place_bid('{direct}',100);",buyer)
        print('PASS: exact custom timestamps in Direct and Escrow, private unfunded drafts, fixed deadlines survive deposits and ordinary bids still work')
        preset=sql("select public.create_auction('seal tooth',1,100,24,null,null,2,true);",seller)
        sql(f"update public.auctions set created_at=clock_timestamp()-interval '2 hours',end_time=clock_timestamp()+interval '22 hours' where id='{preset}';")
        before=row(preset)['end_time']
        assert deposit(preset,89811)=='accepted'
        assert row(preset)['end_time']>before and row(preset)['start_on_deposit'] and row(preset)['custom_end_at'] is None
        print('PASS: the original preset RPC and full timer-on-deposit behavior remain unchanged')
        late=create(True)
        sql(f"update public.auctions set created_at=clock_timestamp()-interval '1 hour',end_time=clock_timestamp()-interval '1 second',custom_end_at=clock_timestamp()-interval '1 second' where id='{late}';")
        assert deposit(late,89812)=='The listing deadline has passed.'
        assert row(late)['item_escrowed_at'] is None
        assert sql("select sum(quantity) from khub_bot.deliveries where receipt_id='89812' and kind='refund' and item_id=2;")=='1'
        print('PASS: deposits processed after a custom deadline are rejected and returned without opening the auction')
        for deadline in ['-infinity','infinity','2020-01-01T00:00:00Z',datetime.fromtimestamp(epoch+31*86400,timezone.utc).isoformat()]:
            sql(f"set role authenticated;select public.create_auction('seal tooth',1,100,24,null,null,2,true,{lit(deadline)}::timestamptz);",seller,error='Choose an ending time')
        sql("set role authenticated;select public.create_auction('seal tooth',1,100,24,null,null,2,true,null::timestamptz);",seller,error='Choose an ending time')
        sql(f"set role anon;select public.create_auction('seal tooth',1,100,24,null,null,2,false,{lit(ending)}::timestamptz);",error='permission denied')
        sql(f"set role authenticated;select public.create_auction('seal tooth',1,1000001,24,null,null,2,true,{lit(ending)}::timestamptz);",seller,error='Escrow is limited')
        sql(f"set role authenticated;select public.create_auction('seal tooth',1,100,24,null,null,43,false,{lit(ending)}::timestamptz);",seller,error='current catalog item')
        sql(f"set role authenticated;select public.create_auction('Untradeable fixture 0',1,100,24,null,null,1900000,false,{lit(ending)}::timestamptz);",seller,error='Only tradeable items')
        sql("insert into khub_bot.account_bans(kol_player_id,username,reason) values(48889801,'Schedule Seller','Fixture ban');")
        sql(f"set role authenticated;select public.create_auction('seal tooth',1,100,24,null,null,2,false,{lit(ending)}::timestamptz);",seller,error='restricted')
        print('PASS: server-side bounds, null/infinite/past timestamps, guest/ban protections, current-catalog checks and escrow limits')
    finally:
        if started: pg('-m','fast','-w','stop')
