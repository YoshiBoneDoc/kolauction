-- Run once AFTER the auction lifecycle migration. Existing listings keep
-- normal bidding with no instant purchase price. No history is deleted.
begin;

alter table public.auctions
    add column instant_purchase_price bigint,
    add column instant_purchased_at timestamptz,
    add constraint auction_instant_purchase_price check (
        instant_purchase_price is null or
        instant_purchase_price between min_bid_meat and 20000000000
    ),
    add constraint auction_instant_purchase_outcome check (
        instant_purchased_at is null or (
            instant_purchase_price is not null and final_price is not null
            and final_price = instant_purchase_price and winner_id is not null
            and finalized_at is not null and status in ('awaiting_trade', 'completed')
        )
    );

-- Replace the old signature so PostgREST does not see ambiguous overloads.
-- Older callers omitting the optional price still create normal auctions.
drop function public.create_auction(text, bigint, bigint, integer, text);
create function public.create_auction(
    p_item text, p_quantity bigint, p_min_bid_meat bigint,
    p_duration_hours integer, p_image text default null,
    p_instant_purchase_price bigint default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
    v_user uuid := auth.uid();
    v_username text;
    v_id uuid;
    v_created timestamptz := clock_timestamp();
begin
    if v_user is null then raise exception 'Please log in to create an auction.'; end if;
    select khub_username into v_username from public.profiles where id = v_user;
    if not found then raise exception 'Your user profile could not be found.'; end if;
    if p_duration_hours is null or p_duration_hours not in (6, 12, 24, 72, 168, 720) then
        raise exception 'Choose a valid auction duration.';
    end if;
    if p_instant_purchase_price is not null and (
        p_instant_purchase_price < p_min_bid_meat or
        p_instant_purchase_price < 1 or p_instant_purchase_price > 20000000000
    ) then
        raise exception 'Instant purchase price must meet the minimum bid and be at most 20 billion Meat.';
    end if;
    insert into public.auctions (
        seller_id, seller_username, item, quantity, min_bid_meat,
        duration_hours, image, created_at, end_time, instant_purchase_price
    ) values (
        v_user, v_username, btrim(p_item), p_quantity, p_min_bid_meat,
        p_duration_hours, p_image, v_created,
        v_created + pg_catalog.make_interval(hours => p_duration_hours), p_instant_purchase_price
    ) returning id into v_id;
    return v_id;
end;
$$;

-- Price and buyer identity are read on the server, never trusted from the UI.
-- The lock is shared with bidding, cancellation, expiry, and trade confirmation.
create function public.purchase_auction(p_auction_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_user uuid := auth.uid();
    v_username text;
    v_auction public.auctions%rowtype;
    v_purchased timestamptz;
begin
    if v_user is null then raise exception 'Please log in to purchase an auction.'; end if;
    select khub_username into v_username from public.profiles where id = v_user;
    if not found then raise exception 'Your user profile could not be found.'; end if;
    select * into v_auction from public.auctions where id = p_auction_id for update;
    if not found then raise exception 'Auction not found.'; end if;
    -- A retry after a successful purchase must not insert another bid or change
    -- the recorded amount/timestamps, including after trade completion.
    if v_auction.instant_purchased_at is not null and v_auction.winner_id = v_user then return; end if;
    if v_auction.status <> 'active' or v_auction.end_time <= clock_timestamp() then
        raise exception 'This auction has ended or was cancelled.';
    end if;
    if v_auction.seller_id = v_user then raise exception 'You cannot purchase your own auction.'; end if;
    if v_auction.instant_purchase_price is null then raise exception 'This listing has no instant purchase price.'; end if;
    if v_auction.current_bid >= v_auction.instant_purchase_price then
        raise exception 'The instant purchase price is no longer available. Refresh the listing.';
    end if;
    v_purchased := clock_timestamp();
    insert into public.bids (auction_id, bidder_id, bidder_username, amount)
        values (p_auction_id, v_user, v_username, v_auction.instant_purchase_price);
    update public.auctions set
        current_bid = instant_purchase_price, highest_bidder_id = v_user,
        highest_bidder_username = v_username, status = 'awaiting_trade',
        winner_id = v_user, winner_username = v_username,
        final_price = instant_purchase_price, finalized_at = v_purchased,
        instant_purchased_at = v_purchased
    where id = p_auction_id;
end;
$$;

create or replace function public.place_bid(p_auction_id uuid, p_amount bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_user uuid := auth.uid();
    v_username text;
    v_auction public.auctions%rowtype;
begin
    if v_user is null then raise exception 'Please log in to place a bid.'; end if;
    if p_amount is null or p_amount < 1 or p_amount > 20000000000 then
        raise exception 'Bid must be between 1 and 20 billion Meat.';
    end if;
    select khub_username into v_username from public.profiles where id = v_user;
    if not found then raise exception 'Your user profile could not be found.'; end if;
    select * into v_auction from public.auctions where id = p_auction_id for update;
    if not found then raise exception 'Auction not found.'; end if;
    if v_auction.status <> 'active' or v_auction.end_time <= clock_timestamp() then
        raise exception 'This auction has ended or was cancelled.';
    end if;
    if v_auction.seller_id = v_user then raise exception 'You cannot bid on your own auction.'; end if;
    -- This also lets the current high bidder accept the instant price.
    if v_auction.instant_purchase_price is not null and p_amount >= v_auction.instant_purchase_price then
        perform public.purchase_auction(p_auction_id);
        return;
    end if;
    if v_auction.highest_bidder_id = v_user then raise exception 'You are already the highest bidder.'; end if;
    if p_amount < v_auction.min_bid_meat or p_amount <= v_auction.current_bid then
        raise exception 'Your bid must meet the minimum and exceed the current bid. Please check the latest price.';
    end if;
    insert into public.bids (auction_id, bidder_id, bidder_username, amount)
        values (p_auction_id, v_user, v_username, p_amount);
    update public.auctions set current_bid = p_amount, highest_bidder_id = v_user,
        highest_bidder_username = v_username where id = p_auction_id;
end;
$$;

revoke all on function public.create_auction(text, bigint, bigint, integer, text, bigint) from public, anon, authenticated;
revoke all on function public.purchase_auction(uuid) from public, anon, authenticated;
grant execute on function public.create_auction(text, bigint, bigint, integer, text, bigint) to authenticated;
grant execute on function public.purchase_auction(uuid) to authenticated;
-- CREATE OR REPLACE preserves the existing authenticated-only place_bid grant.
notify pgrst, 'reload schema';
commit;
