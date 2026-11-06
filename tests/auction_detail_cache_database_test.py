"""Auction detail cache migrations, narrow context privacy and unchanged financial RPCs.
Creates a disposable PostgreSQL cluster on a temporary Unix socket. No production
credentials, network, real bot, KoL account or live database is used.
Run: python3 tests/auction_detail_cache_database_test.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
with tempfile.TemporaryDirectory(prefix='khub-detail-cache-',dir='/tmp') as folder:
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

        definitions="""select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname in ('public','khub_bot') and p.prokind='f' and p.proname in
            ('bot_ingest_mail','bot_tick','bot_claim_delivery','bot_ack_delivery','finish_listing','finish_buy_order','bot_liabilities');"""
        financial_before=None
        for migration in migrations:
            financial_before=sql(definitions)
            if migration.name.startswith('202611060234_'):
                definition=sql("select pg_get_functiondef('public.read_auction_bid_history(uuid,bigint,uuid,bigint)'::regprocedure)")
                sql(definition.replace('FUNCTION public.read_auction_bid_history(', 'FUNCTION khub_bot.history_before_234('))
            sql(migration.read_text())
            if migration.name.startswith(('202611030176_', '202611030177_', '202611050227_')):
                assert sql(definitions)==financial_before, 'Performance migration changed financial definitions'
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
        aid=sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,current_bid,duration_hours,end_time,status,giveaway_title) values('{owner}','Traffic Seller','Giveaway fixture',1,100,100,24,now()+interval '1 hour','active','Fixture') returning id;")
        sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{aid}','{other}','Traffic Buyer',100);")
        sql(f"update public.auctions set highest_bidder_id='{other}',highest_bidder_username='Traffic Buyer' where id='{aid}';")
        # A second auction must never leak into full/narrow detail histories.
        unrelated=sql(f"insert into public.auctions(seller_id,seller_username,item,quantity,min_bid_meat,current_bid,duration_hours,end_time,status) values('{other}','Traffic Buyer','Unrelated fixture',1,100,100,24,now()+interval '1 hour','active') returning id;")
        sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{unrelated}','{owner}','Traffic Seller',100);")
        administrator=account(98004,3552305,'Administrator Fixture')
        for viewer in [None,owner,other,restricted,administrator]:
            full=json.loads(sql(f"select public.read_auction_page(p_view=>'detail',p_id=>'{aid}');",viewer))
            narrow=json.loads(sql(f"select public.read_auction_detail_context(p_id=>'{aid}');",viewer))
            # The UI maps an omitted giveaway_winner flag to false. Compare
            # those equivalent active-history values; a true flag must still match.
            history=lambda payload: [dict(b,giveaway_winner=b.get('giveaway_winner',False)) for b in payload['bids']]
            assert history(narrow)==history(full),(viewer,narrow,full)
            static=json.loads(sql(f"select public.read_auction_detail_static(p_view=>'detail',p_id=>'{aid}');",viewer))
            identity=json.loads(sql(f"select public.read_auction_viewer_context(p_id=>'{aid}');",viewer))
            recent=json.loads(sql(f"select public.read_auction_bid_history('{aid}');",viewer))
            assert static['bids']==[] and identity['bids']==[]
            assert [r.get('latest_bid_at') for r in static['rows']]==[r.get('latest_bid_at') for r in full['rows']]
            assert recent['bids']==full['bids'],(viewer,recent,full)
            assert not recent['has_more']
            unchanged=json.loads(sql(f"select public.read_auction_bid_history('{aid}',p_known_revision=>{recent['revision']});",viewer))
            if viewer!=administrator:
                assert unchanged['unchanged'] and unchanged['bids']==[],unchanged
            else:assert unchanged['bids']==recent['bids']


            for payload in [full,narrow]:
                assert len(payload['bids'])==1,(viewer,payload)
                assert {bid['auction_id'] for bid in payload['bids']}=={aid},(viewer,payload)
            # Missing IDs cannot return global history through an empty page.
            missing=str(uuid4())
            for rpc in ['read_auction_page','read_auction_detail_context']:
                empty=json.loads(sql(f"select public.{rpc}(p_view=>'detail',p_id=>'{missing}');",viewer))
                assert empty['rows']==[] and empty['bids']==[],(viewer,rpc,empty)

            if viewer:
                card=json.loads(sql(f"select public.read_auction_card_context(array['{aid}'::uuid]);",viewer))['rows'][0]
                for key in ['seller_id','seller_username','highest_bidder_id','highest_bidder_username','usernames_visible','viewer_is_highest_bidder','bidding_restricted','escrow_timing_review']:
                    assert card[key]==full['rows'][0][key],(viewer,key,card,full['rows'][0])
                assert 'settlement_contacts' not in card
            row=narrow['rows'][0]
            for key in ['usernames_visible','seller_username','highest_bidder_id','highest_bidder_username','viewer_is_highest_bidder','bidding_restricted','escrow_timing_review']:
                assert row[key]==full['rows'][0][key],(key,row,full['rows'][0])
            assert not set(row)&{'item','image','current_bid','bid_count','end_time','quantity'}
        assert sql(f"select ordinal from khub_bot.auction_bidder_labels where auction_id='{aid}' and bidder_id='{other}';")=='1'
        assert 'khub_bot.auction_bidder_labels' in sql("select prosrc from pg_proc where oid='public.read_auction_detail_context(text,uuid,text,text,text,integer)'::regprocedure;")
        public=json.loads(sql(f"select public.read_public_auction_detail_state('{aid}');"))
        assert public['rows'][0]['bid_count']==1
        assert 'seller_id' not in public['rows'][0]
        body=sql("select prosrc from pg_proc where oid='public.read_auction_detail_context(text,uuid,text,text,text,integer)'::regprocedure;")
        assert 'khub_bot.public_auction(' not in body
        assert 'select count(*) from public.bids b where b.auction_id=a.id' not in body
        sql(f"update public.auctions set status='awaiting_trade',winner_username='Traffic Buyer',final_price=100,finalized_at=now(),winner_id='{other}' where id='{aid}';")
        assert json.loads(sql(f"select public.read_auction_detail_context(p_id=>'{aid}');"))['rows'][0]['_detail_full_required']
        # Two concurrent first bidders serialize label assignment on the auction row.
        jobs=[]
        for amount,bidder in enumerate([administrator,restricted],200):
            jobs.append(subprocess.Popen([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',
                f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) values('{aid}','{bidder}','Fixture',{amount});"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True))
        for job in jobs:
            out,err=job.communicate(timeout=10)
            assert job.returncode==0,err
        assert sql(f"select string_agg(ordinal::text,',' order by ordinal) from khub_bot.auction_bidder_labels where auction_id='{aid}';")=='1,2,3'
        assert sql("select prosrc from pg_proc where oid='public.khub_record_site_activity(uuid)'::regprocedure;").lower().find('delete')==-1
        assert 'refresh_public_discovery' not in sql("select prosrc from pg_proc where oid='public.read_public_home_auctions()'::regprocedure;")
        # PostgREST executes STABLE RPCs in READ ONLY transactions, even on POST.
        sql("update khub_bot.site_trade_totals_snapshot set refreshed_at=now()-interval '1 day';")
        before_totals=sql('select row_to_json(s) from khub_bot.site_trade_totals_snapshot s;')
        for role in ['anon','authenticated']:
            sql(f"begin read only; set local role {role}; select public.read_public_home_auctions(); commit;")
        assert sql('select row_to_json(s) from khub_bot.site_trade_totals_snapshot s;')==before_totals
        sql('set role service_role; select public.bot_refresh_public_discovery(); reset role;')
        assert sql("select refreshed_at>now()-interval '1 minute' from khub_bot.site_trade_totals_snapshot;")=='t'
        saved=sql('select totals from khub_bot.site_trade_totals_snapshot;')
        sql('delete from khub_bot.site_trade_totals_snapshot;')
        sql('begin read only; set local role anon; select public.read_public_home_auctions(); commit;')
        sql('set role service_role; select public.bot_refresh_public_discovery(); reset role;')
        assert sql('select totals from khub_bot.site_trade_totals_snapshot;')==saved
        assert sql(definitions)==financial_before
        # Paginated history preserves ordering, exact scope, aliases and cursors.
        sql(f"insert into public.bids(auction_id,bidder_id,bidder_username,amount) select '{aid}','{other}','Traffic Buyer',500+n from generate_series(1,120) n;")
        expected=int(sql(f"select count(*) from public.bids where auction_id='{aid}';"))
        assert int(sql(f"select display_bid_count from public.auctions where id='{aid}';"))==expected
        seen=set();cursor={};pages=0
        while True:
            args='' if not cursor else f",{cursor['amount']},'{cursor['id']}'"
            page=json.loads(sql(f"select public.read_auction_bid_history('{aid}'{args});",other))
            ids={b['id'] for b in page['bids']}
            assert len(ids)<=50 and not seen.intersection(ids)
            assert all(b['auction_id']==aid for b in page['bids'])
            seen.update(ids);pages+=1
            if not page['has_more']:break
            cursor=page['next_cursor']
        assert len(seen)==expected and pages==3,(len(seen),expected,pages)
        assert json.loads(sql(f"select public.read_auction_bid_history('{uuid4()}');"))['bids']==[]
        for viewer in [None,owner,other,restricted,administrator]:
            for known in ['null','0']:
                pair=json.loads(sql(f"select jsonb_build_object('old',khub_bot.history_before_234('{aid}',null,null,{known}),'new',public.read_auction_bid_history('{aid}',null,null,{known}))",viewer))
                assert pair['old']==pair['new'],(viewer,known,pair)
        for status in ['settling','awaiting_trade','completed']:
            sql(f"update public.auctions set status='{status}',winner_id='{other}',seller_confirmed_at=now(),buyer_confirmed_at=now() where id='{aid}'")
            for viewer in [None,owner,other,restricted,administrator]:
                pair=json.loads(sql(f"select jsonb_build_object('old',khub_bot.history_before_234('{aid}'),'new',public.read_auction_bid_history('{aid}'))",viewer))
                assert pair['old']==pair['new'],(viewer,status,pair)
        sql(f"update public.auctions set status='active' where id='{aid}'")
        for rpc in ['khub_bot.history_before_234','public.read_auction_bid_history']:
            times=[]
            for _ in range(5):
                plan=json.loads(sql(f"explain(analyze,buffers,format json) select {rpc}('{aid}')",other))
                times.append(plan[0]['Execution Time'])
            print(rpc,'50-row history fixture ms:',times)
        # Ignore-list filtering must still authorize history before any rows or
        # revision metadata are returned, even to a previously cached viewer.
        sql(f"insert into public.player_ignores(user_id,kol_player_id) values('{other}',48889801);")
        hidden=json.loads(sql(f"select public.read_auction_bid_history('{aid}');",other))
        assert hidden['bids']==[] and hidden['visible'] is False and hidden['revision'] is None,hidden
        sql(f"delete from public.player_ignores where user_id='{other}';")

        sql(f"delete from public.bids where auction_id='{aid}' and amount>500;")
        assert int(sql(f"select display_bid_count from public.auctions where id='{aid}';"))==expected-120
        # Moving/deleting a bid changes only auction-local count/revision state.
        moved=sql(f"select id from public.bids where auction_id='{aid}' order by amount desc limit 1;")
        old_count=int(sql(f"select display_bid_count from public.auctions where id='{aid}';"))
        sql(f"update public.bids set auction_id='{unrelated}',amount=99999 where id='{moved}';")
        assert int(sql(f"select display_bid_count from public.auctions where id='{aid}';"))==old_count-1
        assert sql(f"select display_bid_count=(select count(*) from public.bids where auction_id='{unrelated}') from public.auctions where id='{unrelated}';")=='t'
        # The maintenance role has exactly the explicit RPC grants, no financial access.
        sql("set role anon; select public.site_refresh_discovery();",error='permission denied')
        sql("set role khub_site_maintenance; select public.bot_tick();",error='permission denied')
        sql("set role khub_site_maintenance; select public.activate_site_maintenance();",error='permission denied')
        sql("select public.activate_site_maintenance();",error='Verify all three')
        sql("insert into public.site_activity(visitor_id,last_seen) select gen_random_uuid(),now()-interval '1 hour' from generate_series(1,1001);")
        for rpc in ['site_refresh_discovery','site_cleanup_activity','site_refresh_totals']:
            result=json.loads(sql(f"set role khub_site_maintenance; select public.{rpc}(); reset role;"))
            assert result['state']=='ok',(rpc,result)
        assert sql("select count(*) from public.site_activity where last_seen<now()-interval '5 minutes';")=='1'
        sql("select public.activate_site_maintenance();")
        assert json.loads(sql("select public.bot_worker_status();"))['siteMaintenanceOwned']
        sql("update khub_bot.site_trade_totals_snapshot set refreshed_at=now()-interval '1 day';")
        sql("select public.bot_refresh_public_discovery();")
        assert sql("select refreshed_at<now()-interval '1 hour' from khub_bot.site_trade_totals_snapshot;")=='t'
        # A failing totals task must retain its snapshot and defer optional work.
        before=sql("select row_to_json(s) from khub_bot.site_trade_totals_snapshot s;")
        sql("update khub_bot.site_maintenance_state set next_attempt='-infinity'; insert into khub_bot.site_totals_dirty values(txid_current()) on conflict do nothing;")
        sql("alter function khub_bot.refresh_site_trade_totals() rename to fixture_saved_totals; create function khub_bot.refresh_site_trade_totals() returns jsonb language plpgsql as $$begin raise exception 'fixture timeout' using errcode='57014'; end;$$;")
        failure=json.loads(sql("set role khub_site_maintenance; select public.site_refresh_totals(); reset role;"))
        assert failure=={'state':'deferred','code':'57014'},failure
        assert sql("select row_to_json(s) from khub_bot.site_trade_totals_snapshot s;")==before
        assert sql("select bool_and(next_attempt>now()) from khub_bot.site_maintenance_state;")=='t'
        assert sql("select count(*)>0 from khub_bot.site_totals_dirty;")=='t'
        manifest=json.loads(sql("set role anon; select public.read_item_catalog_manifest(); reset role;"))
        snapshot=json.loads(sql("set role anon; select public.read_item_catalog_snapshot("+lit(manifest['version'])+"); reset role;"))
        assert snapshot['ready'] and len(snapshot['items'])>8000
        assert sql("set role anon;select public.read_item_catalog_snapshot('missing');reset role;")==''
        print('PostgreSQL checks passed: history scope/privacy/pagination/revisions, counters, maintenance ownership/ACLs/backoff, catalogue versions, and unchanged financial definitions.')
    finally:
        if started:pg('-m','immediate','-w','stop')
