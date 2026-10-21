-- Manual test fixture script. Run after migration 050 in Supabase SQL Editor.
-- Creates test1..test5 and banned; passwords match the displayed names.
-- Logins use the website's KH_ prefix, e.g. KH_test1 / test1.
-- These are visible mock listings. Use for testing, not real trading.
-- Safe to rerun: existing fixture accounts, passwords, bans and auctions are retained.
-- No real escrow balances, item deposits or financial deliveries are fabricated.
-- Auth field reference: https://github.com/supabase/auth/blob/master/internal/models/user.go
begin;
select pg_advisory_xact_lock(3888760);
create extension if not exists pgcrypto;

create table if not exists khub_bot.test_accounts (
    user_id uuid primary key references public.profiles(id),
    username text not null unique,
    kol_player_id bigint not null unique,
    notification_recipient_id bigint not null default 3552305 check (notification_recipient_id=3552305)
);
create table if not exists khub_bot.test_auction_fixtures (
    seed_key text primary key,
    auction_id uuid not null unique references public.auctions(id)
);
alter table khub_bot.test_accounts enable row level security;
alter table khub_bot.test_auction_fixtures enable row level security;
revoke all on khub_bot.test_accounts,khub_bot.test_auction_fixtures from public,anon,authenticated;
grant all on khub_bot.test_accounts,khub_bot.test_auction_fixtures to service_role;

-- Route only the explicitly registered test identities. Ordinary users are untouched.
-- Refuse real asset transfers to fake identities rather than spending bot inventory.
create or replace function khub_bot.route_test_notifications() returns trigger
language plpgsql security definer set search_path='' as $$
declare target bigint;
begin
    select notification_recipient_id into target from khub_bot.test_accounts where kol_player_id=new.recipient_id;
    if found then
        if new.kind<>'notice' or new.meat<>0 or new.item_id is not null or new.quantity<>0 then
            raise exception 'Test identities cannot receive real escrow assets. Use an actual linked account for funded escrow testing.';
        end if;
        new.recipient_id:=target;
    end if;
    return new;
end; $$;
drop trigger if exists deliveries_route_test_notifications on khub_bot.deliveries;
create trigger deliveries_route_test_notifications before insert on khub_bot.deliveries
    for each row execute function khub_bot.route_test_notifications();

-- Prevent unrelated users from accidentally participating in a mock sale.
create or replace function khub_bot.guard_test_auction_bid() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if exists(select 1 from khub_bot.test_auction_fixtures where auction_id=new.auction_id)
        and not exists(select 1 from khub_bot.test_accounts where user_id=new.bidder_id)
        and not exists(select 1 from public.profiles where id=new.bidder_id and kol_player_id=3552305) then
        raise exception 'This is a test auction. Only test accounts or teres Minor may bid.';
    end if;
    return new;
end; $$;
drop trigger if exists bids_guard_test_auction on public.bids;
create trigger bids_guard_test_auction before insert or update on public.bids
    for each row execute function khub_bot.guard_test_auction_bid();
revoke all on function khub_bot.route_test_notifications(),khub_bot.guard_test_auction_bid() from public,anon,authenticated;

-- Respect the application's registration triggers: reserve an internal account
-- job, insert the Auth user/identity, then complete the reservation without KMail.
do $$
declare
    i integer; uname text; uid uuid; player bigint; mail text; address text; digest text; crypto_schema text;
begin
    if to_regprocedure('public.read_admin_accounts(text)') is null
        or to_regprocedure('public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean)') is null then
        raise exception 'Apply website migrations through 050 before seeding.';
    end if;
    select n.nspname into crypto_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
    for i in 1..6 loop
        uname:=case when i=6 then 'banned' else 'test'||i end;
        uid:=('d00d0000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid;
        player:=9000000000+i;
        mail:='khub-test-v1-'||uname;
        address:='account-'||uid||'@login.khub.invalid';
        if exists(select 1 from khub_bot.test_accounts where user_id=uid and username=uname and kol_player_id=player) then
            if not exists(select 1 from auth.users where id=uid and raw_app_meta_data->>'khub_test_seed'='v1') then
                raise exception 'Unexpected Auth record for fixture %. Nothing was changed.',uname;
            end if;
            continue;
        end if;
        if exists(select 1 from auth.users where id=uid or email=address)
            or exists(select 1 from public.profiles where lower(khub_username)=uname or kol_player_id=player)
            or exists(select 1 from khub_bot.account_jobs where mail_id=mail) then
            raise exception 'Fixture name, UUID or KoL ID for % is already in use. Refusing to overwrite it.',uname;
        end if;
        insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result)
            values(mail,player,now(),jsonb_build_object('test_fixture',true,'username',uname),'test_seed');
        insert into khub_bot.account_jobs(mail_id,kol_player_id,kol_name,user_id,username,login_email,action,state,temporary_password)
            values(mail,player,uname,uid,uname,address,'register','pending',repeat('test-fixture-',3));
        execute format('select %I.crypt($1,%I.gen_salt(''bf'',10))',crypto_schema,crypto_schema) into digest using uname;
        insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
            raw_app_meta_data,raw_user_meta_data,is_super_admin,created_at,updated_at,
            confirmation_token,recovery_token,email_change_token_current,email_change_token_new,email_change,
            phone_change_token,phone_change,reauthentication_token)
        values(uid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',address,digest,now(),
            jsonb_build_object('provider','email','providers',jsonb_build_array('email'),'khub_account_job',mail,'khub_test_seed','v1'),
            jsonb_build_object('khub_username',uname),false,now(),now(),'','','','','','','','');
        insert into auth.identities(id,provider_id,user_id,identity_data,provider,created_at,updated_at)
            values(gen_random_uuid(),uid::text,uid,jsonb_build_object('sub',uid::text,'email',address,'email_verified',true),'email',now(),now());
        update khub_bot.account_jobs set state='done',temporary_password=null where mail_id=mail;
        insert into khub_bot.test_accounts(user_id,username,kol_player_id) values(uid,uname,player);
    end loop;
end; $$;

-- Seed through real auction RPCs. Each scenario is created only once.
do $$
declare
    cfg record; seller uuid; buyer uuid; lot uuid; item_record record;
    previous_subject text:=current_setting('request.jwt.claim.sub',true);
begin
    for cfg in select * from (values
        ('direct-no-bids',        'test1','test2', 'asbestos ore', 3,   1000::bigint, 20000::bigint, false,'open'),
        ('direct-with-bids',      'test2','test3', 'seal tooth',   5,   1000::bigint, null::bigint,  false,'bids'),
        ('direct-large-price',    'test3','test4', 'Cold Fang',    1,25000000::bigint,50000000::bigint,false,'open'),
        ('direct-awaiting-trade', 'test4','test1', 'helmet turtle',2,    100::bigint,   500::bigint, false,'awaiting'),
        ('direct-buyer-confirmed','test5','test2', 'disco ball',   1,    100::bigint,  1000::bigint, false,'buyer_confirmed'),
        ('direct-both-complete',  'test1','test3', 'seal tooth',   2,    100::bigint,   400::bigint, false,'completed'),
        ('direct-incomplete',    'test2','test4', 'asbestos ore', 4,    100::bigint,   800::bigint, false,'incomplete'),
        ('direct-canceled',      'test5','test1', 'helmet turtle',1,    100::bigint, null::bigint,  false,'canceled'),
        ('ban-test-listing',     'banned','test1','asbestos ore', 1,   1000::bigint, 10000::bigint, false,'open'),
        ('escrow-awaiting-deposit','test1','test2','seal tooth',   1,   1000::bigint, null::bigint,  true, 'open'),
        ('escrow-1m-boundary',    'test3','test4', 'disco ball',   1,1000000::bigint, null::bigint,  true, 'open')
    ) as x(seed_key,seller_name,buyer_name,item_name,quantity,minimum,buyout,escrow,scenario) loop
        if exists(select 1 from khub_bot.test_auction_fixtures where seed_key=cfg.seed_key) then continue; end if;
        select user_id into strict seller from khub_bot.test_accounts where username=cfg.seller_name;
        select user_id into strict buyer from khub_bot.test_accounts where username=cfg.buyer_name;
        select id,name into item_record from khub_bot.catalog where lower(name)=lower(cfg.item_name) order by id limit 1;
        if not found then raise exception 'Sync the bot item catalog first: missing %.',cfg.item_name; end if;
        perform set_config('request.jwt.claim.sub',seller::text,true);
        lot:=public.create_auction(item_record.name,cfg.quantity,cfg.minimum,72,
            'https://images.kingdomofloathing.com/itemimages/'||case lower(cfg.item_name)
                when 'asbestos ore' then 'aore.gif' when 'seal tooth' then 'tooth.gif'
                when 'cold fang' then 'book4.gif' when 'helmet turtle' then 'turtle.gif' else 'discoball.gif' end,
            cfg.buyout,item_record.id,cfg.escrow);
        insert into khub_bot.test_auction_fixtures(seed_key,auction_id) values(cfg.seed_key,lot);
        if cfg.scenario='canceled' then perform public.cancel_auction(lot); end if;
        if cfg.scenario='bids' then
            perform set_config('request.jwt.claim.sub',buyer::text,true);
            perform public.place_bid(lot,cfg.minimum);
            perform set_config('request.jwt.claim.sub',(select user_id::text from khub_bot.test_accounts where username='test4'),true);
            perform public.place_bid(lot,cfg.minimum+200);
        elsif cfg.scenario in ('awaiting','buyer_confirmed','completed','incomplete') then
            perform set_config('request.jwt.claim.sub',buyer::text,true);
            perform public.purchase_auction(lot);
            if cfg.scenario in ('buyer_confirmed','completed','incomplete') then perform public.confirm_auction_trade(lot); end if;
            if cfg.scenario='completed' then
                perform set_config('request.jwt.claim.sub',seller::text,true);
                perform public.confirm_auction_trade(lot);
                perform public.rate_trade_partner(lot,1);
            elsif cfg.scenario='incomplete' then
                perform set_config('request.jwt.claim.sub',seller::text,true);
                perform public.submit_trade_report(gen_random_uuid(),lot,'');
            end if;
        end if;
    end loop;
    perform set_config('request.jwt.claim.sub',coalesce(previous_subject,''),true);
end; $$;
commit;

-- The account named banned is intentionally NOT banned. Ban it using the admin UI.
select 'KH_'||t.username as login,t.username as password,t.kol_player_id,
    khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name) as currently_banned
from khub_bot.test_accounts t join public.profiles p on p.id=t.user_id order by t.username;
select f.seed_key,a.auction_number,a.status,case when a.escrow_mode then 'Escrow' else 'Direct' end as method,
    '/auction/'||a.id as page
from khub_bot.test_auction_fixtures f join public.auctions a on a.id=f.auction_id order by f.seed_key;
