-- Apply once after 023, then deploy the matching website.
-- Existing listings, fee snapshots, escrow and delivery obligations are unchanged.
begin;

create function khub_bot.require_verified_trader() returns public.profiles
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype;
begin
    select * into p from public.profiles where id=auth.uid();
    if not found then raise exception 'Please log in to trade.'; end if;
    if p.is_banned or khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name) then
        raise exception 'This kHub account is restricted.';
    end if;
    if p.kol_player_id is null or p.kol_verified_at is null then
        raise exception 'Verify your KoL account on Your Account before trading.';
    end if;
    return p;
end; $$;
revoke all on function khub_bot.require_verified_trader() from public,anon,authenticated;

-- One signature, with escrow still the default for older clients.
drop function public.create_auction(text,bigint,bigint,integer,text,bigint,integer);
create function public.create_auction(p_item text,p_quantity bigint,p_min_bid_meat bigint,
    p_duration_hours integer,p_image text default null,p_instant_purchase_price bigint default null,
    p_item_id integer default null,p_escrow_mode boolean default true)
returns uuid language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; v_id uuid; v_now timestamptz:=clock_timestamp(); s khub_bot.settings%rowtype;
begin
    p:=khub_bot.require_verified_trader();
    if p_escrow_mode is null then raise exception 'Choose Escrow or Direct settlement.'; end if;
    if p_item_id is null or not exists(select 1 from khub_bot.catalog where id=p_item_id and name=btrim(p_item)) then
        raise exception 'Choose a catalog item. The bot catalog must be synced before listing.';
    end if;
    if p_duration_hours is null or p_duration_hours not in (6,12,24,72,168,720) then
        raise exception 'Choose a valid auction duration.';
    end if;
    select * into s from khub_bot.settings where id;
    insert into public.auctions(seller_id,seller_username,item,item_id,quantity,min_bid_meat,duration_hours,image,
        created_at,end_time,instant_purchase_price,escrow_mode,status,seller_kol_id,fee_bps,start_on_deposit)
    values(p.id,p.khub_username,btrim(p_item),p_item_id,p_quantity,p_min_bid_meat,p_duration_hours,p_image,
        v_now,v_now+make_interval(hours=>p_duration_hours),p_instant_purchase_price,p_escrow_mode,
        case when p_escrow_mode then 'pending_escrow' else 'active' end,p.kol_player_id,
        case when p_escrow_mode then s.fee_bps else 0 end,p_escrow_mode and s.start_on_deposit)
    returning id into v_id;
    return v_id;
end; $$;
revoke all on function public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean) from public,anon,authenticated;
grant execute on function public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean) to authenticated;

-- Even privileged code cannot silently convert a published auction or its terms.
create function khub_bot.guard_settlement_terms() returns trigger
language plpgsql set search_path='' as $$
begin
    if new.escrow_mode is distinct from old.escrow_mode
        or new.fee_bps is distinct from old.fee_bps
        or new.start_on_deposit is distinct from old.start_on_deposit then
        raise exception 'The settlement mode and fee terms are fixed when a listing is published.';
    end if;
    if not old.escrow_mode and old.finalized_at is not null and (
        new.winner_id is distinct from old.winner_id or new.final_price is distinct from old.final_price
        or new.finalized_at is distinct from old.finalized_at) then
        raise exception 'A closed direct sale has a fixed winner and price.';
    end if;
    return new;
end; $$;
revoke all on function khub_bot.guard_settlement_terms() from public,anon,authenticated;
create trigger auctions_guard_settlement_terms before update of escrow_mode,fee_bps,start_on_deposit,winner_id,final_price,finalized_at
    on public.auctions for each row execute function khub_bot.guard_settlement_terms();

create or replace function public.place_bid(p_auction_id uuid,p_amount bigint) returns void
language plpgsql security definer set search_path='' as $$
begin
    -- Same lock order as expiry, bot intake, cancellation and confirmation.
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from public.auctions where id=p_auction_id and escrow_mode) then
        raise exception 'Send your funded bid by KMail to kHub (#3888760).';
    end if;
    perform khub_bot.require_verified_trader();
    perform public.legacy_place_bid(p_auction_id,p_amount);
end; $$;

create or replace function public.purchase_auction(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from public.auctions where id=p_auction_id and escrow_mode) then
        raise exception 'Send the instant purchase Meat by KMail to kHub (#3888760).';
    end if;
    perform khub_bot.require_verified_trader();
    perform public.legacy_purchase_auction(p_auction_id);
end; $$;

-- The existing confirmation transaction freezes the result on server close,
-- accepts only seller/winner, preserves the first timestamp on retry and requires
-- BOTH confirmations for completion. No transfers or compulsory fees for direct sales.
-- Silence is neither a negative rating nor proof of completion.

create function public.read_pending_trades(p_page integer default 1) returns jsonb
language sql stable security definer set search_path='' as $$
with matching as materialized (
    select a.* from public.auctions a
    where auth.uid() is not null and not a.escrow_mode and a.status='awaiting_trade'
        and a.finalized_at is not null and a.winner_id is not null
        and (a.seller_id=auth.uid() or a.winner_id=auth.uid())
), page as (
    select * from matching order by finalized_at,id limit 12
    offset (greatest(1,least(coalesce(p_page,1),1000000))-1)*12
)
select jsonb_build_object('privacy_version',1,'total',(select count(*) from matching),
    'rows',coalesce((select jsonb_agg(khub_bot.public_auction(a,
        (select count(*) from public.bids b where b.auction_id=a.id),'Anonymous bidder','Anonymous bidder')
        order by a.finalized_at,a.id) from page a),'[]'::jsonb));
$$;
revoke all on function public.read_pending_trades(integer) from public,anon,authenticated;
grant execute on function public.read_pending_trades(integer) to authenticated;

notify pgrst,'reload schema';
commit;
