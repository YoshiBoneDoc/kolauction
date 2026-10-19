-- Run once AFTER 202610190003_instant_purchase.sql. Old auctions remain legacy.
-- All bot_* RPCs are service-role only; never give that key to the browser.
begin;
create schema khub_bot;
revoke all on schema khub_bot from public, anon, authenticated;
grant usage on schema khub_bot to service_role;
create table khub_bot.settings (
    id boolean primary key default true check (id),
    fee_bps integer not null default 0 check (fee_bps between 0 and 10000),
    start_on_deposit boolean not null default true
);
insert into khub_bot.settings default values;
create table khub_bot.catalog (id integer primary key check (id > 0), name text not null);
alter table public.profiles add column kol_player_id bigint unique check (kol_player_id > 0),
    add column kol_player_name text, add column kol_verified_at timestamptz;
create table khub_bot.verifications (
    token text primary key, user_id uuid not null unique references public.profiles(id),
    expires_at timestamptz not null
);
alter table public.auctions
    drop constraint auctions_status_check,
    drop constraint auction_completed_confirmations,
    add column escrow_mode boolean not null default false,
    add column item_id integer references khub_bot.catalog(id),
    add column seller_kol_id bigint,
    add column highest_bidder_kol_id bigint,
    add column item_escrowed_at timestamptz,
    add column settled_at timestamptz,
    add column settlement_outcome text check (settlement_outcome in ('completed','ended_no_bids','cancelled')),
    add column fee_bps integer not null default 0 check (fee_bps between 0 and 10000),
    add column fee_meat bigint not null default 0 check (fee_meat >= 0),
    add column start_on_deposit boolean not null default true,
    add constraint auctions_status_check check (status in ('pending_escrow','active','settling','awaiting_trade','ended_no_bids','cancelled','completed')),
    add constraint auction_completed_confirmations check (status <> 'completed' or
        (escrow_mode and settled_at is not null and completed_at is not null) or
        (not escrow_mode and seller_confirmed_at is not null and buyer_confirmed_at is not null and completed_at is not null)),
    add constraint auction_escrow_identity check (not escrow_mode or (item_id is not null and seller_kol_id is not null)),
    drop constraint auction_instant_purchase_outcome,
    add constraint auction_instant_purchase_outcome check (instant_purchased_at is null or
        (instant_purchase_price is not null and final_price is not null and final_price=instant_purchase_price
         and winner_id is not null and finalized_at is not null and status in ('settling','awaiting_trade','completed')));
drop policy auctions_public_read on public.auctions;
create policy auctions_public_read on public.auctions for select to anon, authenticated
    using (status <> 'pending_escrow' or seller_id=(select auth.uid()));

create table khub_bot.receipts (
    mail_id text primary key, sender_id bigint not null check (sender_id > 0),
    received_at timestamptz not null, payload jsonb not null,
    result text not null default 'processing', created_at timestamptz not null default clock_timestamp()
);
create table khub_bot.deliveries (
    id uuid primary key default gen_random_uuid(), dedupe_key text not null unique,
    auction_id uuid references public.auctions(id), receipt_id text references khub_bot.receipts(mail_id),
    recipient_id bigint not null check (recipient_id > 0),
    kind text not null check (kind in ('refund','sale_item','sale_meat','return_item','notice')),
    meat bigint not null default 0 check (meat between 0 and 1000000000),
    item_id integer, quantity bigint not null default 0 check (quantity between 0 and 1000000000),
    message text not null, state text not null default 'pending' check (state in ('pending','sending','sent','unknown')),
    attempt uuid, evidence text, created_at timestamptz not null default clock_timestamp(), sent_at timestamptz,
    check ((item_id is null and quantity=0) or (item_id > 0 and quantity > 0))
);
create index deliveries_pending_idx on khub_bot.deliveries(created_at,id) where state='pending';
create table khub_bot.reconciliations (
    id bigint generated always as identity primary key, delivery_id uuid not null references khub_bot.deliveries(id),
    resolution text not null, evidence text not null, created_at timestamptz not null default clock_timestamp()
);
-- Defense in depth even if these private tables are later exposed by mistake.
alter table khub_bot.receipts enable row level security;
alter table khub_bot.deliveries enable row level security;
alter table khub_bot.verifications enable row level security;
alter table khub_bot.catalog enable row level security;
alter table khub_bot.settings enable row level security;
alter table khub_bot.reconciliations enable row level security;
grant all on all tables in schema khub_bot to service_role;
grant usage on all sequences in schema khub_bot to service_role;

create function public.request_kol_verification() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_token text := replace(gen_random_uuid()::text,'-',''); v_user uuid := auth.uid();
begin
    if v_user is null then raise exception 'Please log in first.'; end if;
    if exists(select 1 from public.profiles where id=v_user and kol_player_id is not null) then
        raise exception 'This account is already linked to a KoL player.';
    end if;
    insert into khub_bot.verifications values(v_token,v_user,clock_timestamp()+interval '20 minutes')
        on conflict(user_id) do update set token=excluded.token,expires_at=excluded.expires_at;
    return jsonb_build_object('command','VERIFY '||v_token,'bot','kHub (#3888760)','expiresInMinutes',20);
end; $$;

-- The catalog is loaded from the checked-in item data using bot/sync-catalog.
create function public.bot_sync_catalog(p_items jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
    insert into khub_bot.catalog(id,name)
        select (x->>'id')::integer,x->>'name' from jsonb_array_elements(p_items) x
        on conflict(id) do update set name=excluded.name;
end; $$;

drop function public.create_auction(text,bigint,bigint,integer,text,bigint);
create function public.create_auction(p_item text,p_quantity bigint,p_min_bid_meat bigint,
    p_duration_hours integer,p_image text default null,p_instant_purchase_price bigint default null,p_item_id integer default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_profile public.profiles%rowtype; v_id uuid; v_now timestamptz:=clock_timestamp(); v_settings khub_bot.settings%rowtype;
begin
    select * into v_profile from public.profiles where id=auth.uid();
    if not found then raise exception 'Please log in to create a listing.'; end if;
    if v_profile.kol_player_id is null then raise exception 'Link your KoL account on Your Account before listing items.'; end if;
    if p_item_id is null or not exists(select 1 from khub_bot.catalog where id=p_item_id and name=btrim(p_item)) then
        raise exception 'Choose a catalog item. The bot catalog must be synced before listing.';
    end if;
    if p_duration_hours is null or p_duration_hours not in (6,12,24,72,168,720) then raise exception 'Choose a valid auction duration.'; end if;
    select * into v_settings from khub_bot.settings where id;
    insert into public.auctions(seller_id,seller_username,item,item_id,quantity,min_bid_meat,duration_hours,image,
        created_at,end_time,instant_purchase_price,escrow_mode,status,seller_kol_id,fee_bps,start_on_deposit)
    values(v_profile.id,v_profile.khub_username,btrim(p_item),p_item_id,p_quantity,p_min_bid_meat,p_duration_hours,p_image,
        v_now,v_now+make_interval(hours=>p_duration_hours),p_instant_purchase_price,true,'pending_escrow',v_profile.kol_player_id,
        v_settings.fee_bps,v_settings.start_on_deposit) returning id into v_id;
    return v_id;
end; $$;

-- Make one durable obligation per physical send, chunking large amounts to stay
-- within KoL's per-mail integer limits. Each dedupe key is deterministic.
create function khub_bot.queue(p_key text,p_auction uuid,p_receipt text,p_recipient bigint,
    p_kind text,p_meat bigint,p_items jsonb,p_message text) returns void
language plpgsql set search_path='' as $$
declare n bigint; part integer; x jsonb; q bigint;
begin
    n:=p_meat; part:=0;
    while n>0 loop
        insert into khub_bot.deliveries(dedupe_key,auction_id,receipt_id,recipient_id,kind,meat,message)
        values(p_key||':meat:'||part,p_auction,p_receipt,p_recipient,p_kind,least(n,1000000000),p_message) on conflict(dedupe_key) do nothing;
        n:=n-least(n,1000000000); part:=part+1;
    end loop;
    for x in select * from jsonb_array_elements(p_items) loop
        q:=(x->>'quantity')::bigint; part:=0;
        while q>0 loop
            insert into khub_bot.deliveries(dedupe_key,auction_id,receipt_id,recipient_id,kind,item_id,quantity,message)
            values(p_key||':item:'||(x->>'id')||':'||part,p_auction,p_receipt,p_recipient,p_kind,(x->>'id')::integer,least(q,1000000000),p_message)
                on conflict(dedupe_key) do nothing;
            q:=q-least(q,1000000000); part:=part+1;
        end loop;
    end loop;
    if p_meat=0 and jsonb_array_length(p_items)=0 then
        insert into khub_bot.deliveries(dedupe_key,auction_id,receipt_id,recipient_id,kind,message)
        values(p_key||':notice',p_auction,p_receipt,p_recipient,'notice',p_message) on conflict(dedupe_key) do nothing;
    end if;
end; $$;

create function khub_bot.finish_listing(p_id uuid,p_reason text) returns void
language plpgsql set search_path='' as $$
declare a public.auctions%rowtype; fee bigint; outcome text;
begin
    select * into a from public.auctions where id=p_id for update;
    if not found or not a.escrow_mode or a.status<>'active' then return; end if;
    if p_reason='deadline' and a.end_time>clock_timestamp() then return; end if;
    if p_reason='cancel' and a.highest_bidder_id is not null then raise exception 'An auction with bids cannot be cancelled.'; end if;
    outcome:=case when p_reason='cancel' then 'cancelled' when a.highest_bidder_id is null then 'ended_no_bids' else 'completed' end;
    fee:=case when outcome='completed' then a.current_bid*a.fee_bps/10000 else 0 end;
    update public.auctions set status='settling',settlement_outcome=outcome,fee_meat=fee,
        finalized_at=clock_timestamp(),winner_id=case when outcome='completed' then highest_bidder_id end,
        winner_username=case when outcome='completed' then highest_bidder_username end,
        final_price=case when outcome='completed' then current_bid end,
        instant_purchased_at=case when p_reason='instant' then clock_timestamp() end
    where id=p_id;
    if outcome='completed' then
        perform khub_bot.queue('sale-item:'||p_id,p_id,null,a.highest_bidder_kol_id,'sale_item',0,
            jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',a.quantity)),'Auction '||p_id||': your winning item(s).');
        if a.current_bid-fee>0 then
            perform khub_bot.queue('sale-meat:'||p_id,p_id,null,a.seller_kol_id,'sale_meat',a.current_bid-fee,'[]',
                'Auction '||p_id||': seller payment; fee '||fee||' Meat.');
        end if;
    else
        perform khub_bot.queue('return-item:'||p_id,p_id,null,a.seller_kol_id,'return_item',0,
            jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',a.quantity)),'Auction '||p_id||': returning your item(s), '||outcome||'.');
    end if;
end; $$;

-- Normalized mail comes only from the authenticated bot adapter, never a public
-- client. Receipt insertion, escrow changes, and refund plans commit together.
create function public.bot_ingest_mail(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare mid text:=p_mail->>'id'; sid bigint:=(p_mail->>'sender_id')::bigint;
    meat bigint:=(p_mail->>'meat')::bigint; attachments jsonb:=p_mail->'items';
    cmd text:=p_mail#>>'{command,type}'; aid uuid; a public.auctions%rowtype; u public.profiles%rowtype;
    tok khub_bot.verifications%rowtype; reason text; accepted bigint; old_sender bigint; old_bid bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    if mid is null or mid!~'^[1-9][0-9]*$' or sid is null or sid<=0 or sid=3888760 or meat is null or meat<0 or meat>20000000000
       or jsonb_typeof(attachments) is distinct from 'array' then raise exception 'Invalid normalized KMail.'; end if;
    if exists(select 1 from jsonb_array_elements(attachments) x where (x->>'id') is null or (x->>'quantity') is null or (x->>'id')::integer<=0 or
        (x->>'quantity')::bigint<=0 or (x->>'quantity')::bigint>5000000000) then raise exception 'Invalid attachments.'; end if;
    if exists(select 1 from khub_bot.receipts where mail_id=mid) then
        if (select payload from khub_bot.receipts where mail_id=mid) <> p_mail then raise exception 'KMail ID payload changed; reconcile before continuing.'; end if;
        return 'duplicate';
    end if;
    insert into khub_bot.receipts(mail_id,sender_id,received_at,payload)
        values(mid,sid,(p_mail->>'received_at')::timestamptz,p_mail);
    if cmd='verify' then
        select * into tok from khub_bot.verifications where token=p_mail#>>'{command,token}' and expires_at>clock_timestamp() for update;
        if not found then reason:='Verification code is invalid or expired.';
        elsif meat<>0 or jsonb_array_length(attachments)<>0 then reason:='Verification must not contain items or Meat.';
        elsif sid=3888760 or exists(select 1 from public.profiles where kol_player_id=sid and id<>tok.user_id) then reason:='This KoL player is already linked or is the bot.';
        else
            update public.profiles set kol_player_id=sid,kol_player_name=p_mail->>'sender_name',kol_verified_at=clock_timestamp()
                where id=tok.user_id and kol_player_id is null;
            if not found then reason:='Website account is already linked.';
            else delete from khub_bot.verifications where token=tok.token;
                perform khub_bot.queue('verified:'||mid,null,mid,sid,'notice',0,'[]','Your KoL account is now linked to kHub.');
            end if;
        end if;
    elsif cmd in ('list','bid','buy') then
        aid:=(p_mail#>>'{command,auction_id}')::uuid;
        select * into a from public.auctions where id=aid for update;
        select * into u from public.profiles where kol_player_id=sid;
        if a.id is null or not a.escrow_mode then reason:='Unknown escrow auction ID.';
        elsif u.id is null then reason:='Link your KoL account on the website before sending deposits or bids.';
        elsif cmd='list' then
            if a.seller_kol_id<>sid then reason:='Only the listing seller can deposit its items.';
            elsif a.status<>'pending_escrow' then reason:='This listing is not waiting for a deposit.';
            elsif not a.start_on_deposit and a.end_time<=clock_timestamp() then reason:='The listing deadline has passed.';
            elsif meat<>0 or attachments<>jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',a.quantity)) then
                reason:='Send exactly the listed item and quantity, with no Meat or extra items.';
            else
                update public.auctions set status='active',item_escrowed_at=clock_timestamp(),
                    end_time=case when start_on_deposit then clock_timestamp()+make_interval(hours=>duration_hours) else end_time end where id=aid;
                perform khub_bot.queue('activated:'||mid,aid,mid,sid,'notice',0,'[]','Auction '||aid||' is active. Your items are held in escrow.');
            end if;
        else
            if a.status<>'active' or a.end_time<=clock_timestamp() then reason:='Bidding is closed.';
            elsif a.seller_kol_id=sid then reason:='Sellers cannot bid on their own auction.';
            elsif jsonb_array_length(attachments)<>0 then reason:='Bids must contain Meat only, without items.';
            elsif cmd='buy' and a.instant_purchase_price is null then reason:='This listing has no instant purchase price.';
            elsif meat<a.min_bid_meat or meat<=a.current_bid or meat>20000000000 then reason:='Send the full bid, meeting the minimum and exceeding the current bid, up to 20 billion Meat.';
            elsif cmd='buy' and meat<a.instant_purchase_price then reason:='The attached Meat does not meet the instant purchase price.';
            else
                accepted:=case when a.instant_purchase_price is not null and meat>=a.instant_purchase_price then a.instant_purchase_price else meat end;
                old_sender:=a.highest_bidder_kol_id; old_bid:=a.current_bid;
                if old_sender is not null then
                    perform khub_bot.queue('outbid:'||mid,aid,mid,old_sender,'refund',old_bid,'[]','Auction '||aid||': your previous bid is refunded in full.');
                end if;
                insert into public.bids(auction_id,bidder_id,bidder_username,amount) values(aid,u.id,u.khub_username,accepted);
                update public.auctions set current_bid=accepted,highest_bidder_id=u.id,highest_bidder_username=u.khub_username,highest_bidder_kol_id=sid where id=aid;
                if meat>accepted then perform khub_bot.queue('excess:'||mid,aid,mid,sid,'refund',meat-accepted,'[]','Auction '||aid||': excess above the instant price is refunded.'); end if;
                if a.instant_purchase_price is not null and accepted=a.instant_purchase_price then perform khub_bot.finish_listing(aid,'instant');
                else perform khub_bot.queue('bid-accepted:'||mid,aid,mid,sid,'notice',0,'[]','Auction '||aid||': your funded bid of '||accepted||' Meat was accepted.'); end if;
            end if;
        end if;
    else reason:='Unknown command. Use VERIFY <code>, LIST <auction-id>, BID <auction-id>, or BUY <auction-id>.';
    end if;
    -- Do not engage other auto-responders in an infinite empty-mail loop.
    if reason is not null and (cmd<>'unknown' or meat>0 or jsonb_array_length(attachments)>0) then
        perform khub_bot.queue('rejected:'||mid,null,mid,sid,'refund',meat,attachments,'KHub could not accept KMail '||mid||': '||reason||' Your attachments are returned.');
    end if;
    update khub_bot.receipts set result=coalesce(reason,'accepted') where mail_id=mid;
    return coalesce(reason,'accepted');
end; $$;

-- Preserve development-mode behavior for existing listings, while rejecting
-- unfunded public bids/purchases and manual completion for every new listing.
alter function public.place_bid(uuid,bigint) rename to legacy_place_bid;
alter function public.purchase_auction(uuid) rename to legacy_purchase_auction;
alter function public.confirm_auction_trade(uuid) rename to legacy_confirm_auction_trade;
alter function public.cancel_auction(uuid) rename to legacy_cancel_auction;
alter function public.finalize_auction(uuid) rename to legacy_finalize_auction;
create function public.place_bid(p_auction_id uuid,p_amount bigint) returns void
language plpgsql security definer set search_path='' as $$ begin
    if exists(select 1 from public.auctions where id=p_auction_id and escrow_mode) then raise exception 'Send your funded bid by KMail to kHub (#3888760).'; end if;
    perform public.legacy_place_bid(p_auction_id,p_amount);
end; $$;
create function public.purchase_auction(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$ begin
    if exists(select 1 from public.auctions where id=p_auction_id and escrow_mode) then raise exception 'Send the instant purchase Meat by KMail to kHub (#3888760).'; end if;
    perform public.legacy_purchase_auction(p_auction_id);
end; $$;
create function public.confirm_auction_trade(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$ begin
    if exists(select 1 from public.auctions where id=p_auction_id and escrow_mode) then raise exception 'Escrow delivery is confirmed by the bot, not by participants.'; end if;
    perform public.legacy_confirm_auction_trade(p_auction_id);
end; $$;
create function public.finalize_auction(p_auction_id uuid) returns public.auctions
language plpgsql security definer set search_path='' as $$ declare a public.auctions%rowtype; begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    if not found then raise exception 'Auction not found.'; end if;
    if not a.escrow_mode then return public.legacy_finalize_auction(p_auction_id); end if;
    perform khub_bot.finish_listing(p_auction_id,'deadline');
    select * into a from public.auctions where id=p_auction_id; return a;
end; $$;
create or replace function public.finalize_expired_auctions() returns void
language plpgsql security definer set search_path='' as $$ declare v_id uuid; begin
    -- Acquire advisory lock before row locks throughout all escrow entry points.
    perform pg_advisory_xact_lock(3888760);
    for v_id in select id from public.auctions where status='active' and end_time<=clock_timestamp() order by id
    loop perform public.finalize_auction(v_id); end loop;
end; $$;
create function public.cancel_auction(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$ declare a public.auctions%rowtype; begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    if not found then raise exception 'Auction not found.'; end if;
    if not a.escrow_mode then perform public.legacy_cancel_auction(p_auction_id); return; end if;
    if auth.uid() is null or auth.uid()<>a.seller_id then raise exception 'Only the seller can cancel this listing.'; end if;
    if a.status='pending_escrow' then update public.auctions set status='cancelled',cancelled_at=clock_timestamp() where id=p_auction_id;
    elsif a.status='active' and a.end_time>clock_timestamp() then perform khub_bot.finish_listing(p_auction_id,'cancel');
    else raise exception 'This listing has already closed.'; end if;
end; $$;

create function public.bot_tick() returns void language plpgsql security definer set search_path='' as $$ begin
    perform pg_advisory_xact_lock(3888760);
    perform public.finalize_expired_auctions();
    update public.auctions set status='cancelled',cancelled_at=clock_timestamp()
        where escrow_mode and status='pending_escrow' and not start_on_deposit and end_time<=clock_timestamp();
    update public.auctions a set status=settlement_outcome,settled_at=clock_timestamp(),
        completed_at=case when settlement_outcome='completed' then clock_timestamp() end,
        cancelled_at=case when settlement_outcome='cancelled' then clock_timestamp() end
        where escrow_mode and status='settling' and not exists(select 1 from khub_bot.deliveries d where d.auction_id=a.id and d.state<>'sent');
end; $$;

create function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
    select jsonb_build_object('deliveryCounts',(select jsonb_object_agg(state,n) from (select state,count(*) n from khub_bot.deliveries group by state)s),
        'attention',(select coalesce(jsonb_agg(to_jsonb(d)),'[]') from khub_bot.deliveries d where state in ('sending','unknown')),
        'receipts',(select count(*) from khub_bot.receipts),'settings',(select to_jsonb(s) from khub_bot.settings s where id));
$$;
create function public.bot_claim_delivery() returns jsonb language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.deliveries where state in ('sending','unknown')) then raise exception 'Uncertain delivery requires reconciliation. No automatic resend.'; end if;
    select * into d from khub_bot.deliveries where state='pending' order by created_at,id limit 1 for update;
    if not found then return null; end if;
    update khub_bot.deliveries set state='sending',attempt=gen_random_uuid() where id=d.id returning * into d;
    return to_jsonb(d);
end; $$;
create function public.bot_ack_delivery(p_id uuid,p_attempt uuid,p_sent boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$ begin
    perform pg_advisory_xact_lock(3888760);
    update khub_bot.deliveries set state=case when p_sent then 'sent' else 'unknown' end,
        sent_at=case when p_sent then clock_timestamp() end,evidence=p_evidence
        where id=p_id and attempt=p_attempt and state='sending';
    if not found then raise exception 'Delivery claim does not match. Reconcile before continuing.'; end if;
    perform public.bot_tick();
end; $$;
create function public.bot_reconcile_delivery(p_id uuid,p_sent boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$ begin
    perform pg_advisory_xact_lock(3888760);
    if length(btrim(p_evidence))<12 then raise exception 'Record evidence from KoL before resolving a delivery.'; end if;
    update khub_bot.deliveries set state=case when p_sent then 'sent' else 'pending' end,
        sent_at=case when p_sent then clock_timestamp() end,attempt=null,evidence=p_evidence
        where id=p_id and state in ('sending','unknown');
    if not found then raise exception 'Only uncertain deliveries can be reconciled.'; end if;
    insert into khub_bot.reconciliations(delivery_id,resolution,evidence) values(p_id,case when p_sent then 'sent' else 'not-sent' end,p_evidence);
    perform public.bot_tick();
end; $$;
create function public.bot_liabilities() returns jsonb language sql security definer set search_path='' as $$
    with holdings as (
        select item_id,quantity,0::bigint meat from public.auctions where escrow_mode and status='active' and item_escrowed_at is not null
        union all select null,0,current_bid from public.auctions where escrow_mode and status='active'
        union all select item_id,quantity,meat from khub_bot.deliveries where state<>'sent'
    ), items as (select item_id,sum(quantity) quantity from holdings where item_id is not null group by item_id)
    select jsonb_build_object('meat',(select coalesce(sum(meat),0)::text from holdings),
        'items',coalesce((select jsonb_object_agg(item_id,quantity::text) from items),'{}'));
$$;

-- Revoke every new/internal and renamed legacy function, then grant only the
-- intended entry points. The private schema is never exposed to public clients.
revoke all on all functions in schema khub_bot from public,anon,authenticated;
revoke all on function public.legacy_place_bid(uuid,bigint),public.legacy_purchase_auction(uuid),public.legacy_confirm_auction_trade(uuid),public.legacy_cancel_auction(uuid),public.legacy_finalize_auction(uuid) from public,anon,authenticated;
revoke all on function public.finalize_auction(uuid) from public,anon,authenticated;
revoke all on function public.request_kol_verification(),public.create_auction(text,bigint,bigint,integer,text,bigint,integer),public.place_bid(uuid,bigint),public.purchase_auction(uuid),public.confirm_auction_trade(uuid),public.cancel_auction(uuid) from public,anon,authenticated;
grant execute on function public.request_kol_verification(),public.create_auction(text,bigint,bigint,integer,text,bigint,integer),public.place_bid(uuid,bigint),public.purchase_auction(uuid),public.confirm_auction_trade(uuid),public.cancel_auction(uuid) to authenticated;
revoke all on function public.bot_sync_catalog(jsonb),public.bot_ingest_mail(jsonb),public.bot_tick(),public.bot_inspect(),public.bot_claim_delivery(),public.bot_ack_delivery(uuid,uuid,boolean,text),public.bot_reconcile_delivery(uuid,boolean,text),public.bot_liabilities() from public,anon,authenticated;
grant execute on function public.bot_sync_catalog(jsonb),public.bot_ingest_mail(jsonb),public.bot_tick(),public.bot_inspect(),public.bot_claim_delivery(),public.bot_ack_delivery(uuid,uuid,boolean,text),public.bot_reconcile_delivery(uuid,boolean,text),public.bot_liabilities() to service_role;
notify pgrst,'reload schema';
commit;
