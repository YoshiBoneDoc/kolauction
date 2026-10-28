"""Verify single-auction test cleanup against an isolated PostgreSQL database.
No live Supabase, KoL, credentials or network are used.
Run: python3 tests/remove_test_auction_1114_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-single-test-cleanup-',dir='/tmp') as folder:
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
        catalog=json.loads((ROOT/'src/data/items.json').read_text())
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
        seller,_=account(81101,3552305,'teres Minor')
        buyer,_=account(81102,1582168,'Anrath1')
        def completed_lot():
            aid=sql("select public.create_auction('5-ball',1,100,24,null,null,1904,true);",seller)
            sql(f"update public.auctions set created_at=clock_timestamp()-interval '2 days',end_time=clock_timestamp()-interval '1 day',item_escrowed_at=clock_timestamp()-interval '2 days',status='completed',current_bid=10000,highest_bidder_id='{buyer}',highest_bidder_username='Anrath1',winner_id='{buyer}',winner_username='Anrath1',final_price=10000,finalized_at=clock_timestamp(),settled_at=clock_timestamp(),completed_at=clock_timestamp(),fee_meat=500,settlement_outcome='completed' where id='{aid}';")
            sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{aid}','{buyer}','Anrath1',10000);")
            sql(f"select khub_bot.queue('test-cleanup-item:{aid}','{aid}',null,1582168,'sale_item',0,'[{{\"id\":1904,\"quantity\":1}}]','Synthetic test item');")
            sql(f"select khub_bot.queue('test-cleanup-payout:{aid}','{aid}',null,3552305,'sale_meat',9500,'[]','Synthetic test payout');")
            sql(f"update khub_bot.deliveries set state='sent',sent_at=clock_timestamp(),evidence='Synthetic local test transfer; no KoL request.' where auction_id='{aid}';")
            sql(f"update khub_bot.closet_transfers set state='moved',moved_at=clock_timestamp(),evidence='Synthetic local closet transfer.' where auction_id='{aid}';")
            return aid
        target=completed_lot()
        unrelated=completed_lot()
        number=sql(f"select auction_number from public.auctions where id='{target}';")
        cleanup=(ROOT/'supabase/testing/remove_test_auction_1114.sql').read_text()
        cleanup=cleanup.replace('f60d798e-f020-44d0-a351-57f808745c10',target).replace('1114',number)
        def fingerprint(table,where='true'):
            return sql(f"select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') from {table} x where {where};")
        protected={t:fingerprint(t) for t in ['auth.users','auth.sessions','public.profiles','khub_bot.receipts','khub_bot.reconciliations']}
        before_deliveries=sql("select jsonb_agg(to_jsonb(d)-'auction_id' order by id) from khub_bot.deliveries d;")
        before_closet=sql("select jsonb_agg(to_jsonb(c)-'auction_id' order by id) from khub_bot.closet_transfers c;")
        before_unrelated=fingerprint('public.auctions',f"id='{unrelated}'")
        sequence=sql('select last_value from public.auctions_auction_number_seq;')
        unknown=sql(f"select id from khub_bot.deliveries where auction_id='{target}' and kind='sale_meat';")
        sql(f"update khub_bot.deliveries set state='unknown' where id='{unknown}';")
        sql(cleanup,error='unfinished deliveries')
        assert sql(f"select count(*) from public.auctions where id='{target}';")=='1'
        assert sql("select to_regclass('khub_bot.test_auction_archive') is null;")=='t'
        sql(f"update khub_bot.deliveries set state='sent' where id='{unknown}';")
        sql(f"update public.auctions set fee_meat=499 where id='{target}';")
        sql(cleanup,error='does not match')
        sql(f"update public.auctions set fee_meat=500 where id='{target}';")
        sql(cleanup)
        assert sql(f"select count(*) from public.auctions where id='{target}';")=='0'
        assert sql(f"select count(*) from public.bids where auction_id='{target}';")=='0'
        assert fingerprint('public.auctions',f"id='{unrelated}'")==before_unrelated
        assert sql("select jsonb_agg(to_jsonb(d)-'auction_id' order by id) from khub_bot.deliveries d;")==before_deliveries
        assert sql("select jsonb_agg(to_jsonb(c)-'auction_id' order by id) from khub_bot.closet_transfers c;")==before_closet
        assert sql(f"select count(*) from khub_bot.deliveries where auction_id='{unrelated}';")=='2'
        assert sql(f"select auction_data->>'auction_number' from khub_bot.test_auction_archive where auction_id='{target}';")==number
        assert sql(f"select jsonb_array_length(related_data->'bids') from khub_bot.test_auction_archive where auction_id='{target}';")=='1'
        for table,value in protected.items():assert fingerprint(table)==value,table
        assert sql('select last_value from public.auctions_auction_number_seq;')==sequence
        for role in ['anon','authenticated']:
            sql(f'set role {role};select * from khub_bot.test_auction_archive;',error='permission denied')
        stats=json.loads(sql('select public.bot_financial_stats();'))
        assert stats['sales']['completed']=='1' and stats['sales']['trade_meat']=='10000'
        assert sql(f"select count(*) from public.auctions where seller_id='{seller}' and status='completed';")=='1'
        assert sql(f"select sum(final_price) from public.auctions where winner_id='{buyer}' and status='completed';")=='10000'
        sql(cleanup)
        assert sql('select count(*) from khub_bot.test_auction_archive;')=='1'
        print('PASS: exact test guards and unknown-send blockers; private archive; public removal and derived totals; unrelated auction/account/receipt preservation; unchanged delivery/closet financial evidence and sequences; idempotent cleanup.')
    finally:
        if started: pg('-m','fast','-w','stop')
