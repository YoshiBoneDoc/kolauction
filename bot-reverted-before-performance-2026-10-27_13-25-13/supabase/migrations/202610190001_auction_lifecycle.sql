-- Run once after both 20261018 migrations. Existing listings and bids are kept.
begin;

alter table public.auctions
    add column status text not null default 'active'
        check (status in ('active', 'awaiting_trade', 'ended_no_bids', 'cancelled', 'completed')),
    add column highest_bidder_username text,
    add column winner_id uuid references public.profiles(id),
    add column winner_username text,
    add column final_price bigint check (final_price between 1 and 20000000000),
    add column finalized_at timestamptz,
    add column seller_confirmed_at timestamptz,
    add column buyer_confirmed_at timestamptz,
    add column completed_at timestamptz,
    add column cancelled_at timestamptz,
    add constraint auction_winner_price_pair check (
        (winner_id is null and winner_username is null and final_price is null)
        or (winner_id is not null and winner_username is not null and final_price is not null)
    ),
    add constraint auction_completed_confirmations check (
        status <> 'completed' or (
            seller_confirmed_at is not null and buyer_confirmed_at is not null
            and completed_at is not null
        )
    );

update public.auctions a set highest_bidder_username = (
    select b.bidder_username from public.bids b
    where b.auction_id = a.id and b.bidder_id = a.highest_bidder_id
    order by b.amount desc limit 1
) where a.highest_bidder_id is not null;

create index auctions_active_end_time_idx on public.auctions (end_time, id)
    where status = 'active';

-- Internal helper. All state changes lock the same listing as place_bid.
create function public.finalize_auction(p_auction_id uuid)
returns public.auctions
language plpgsql security definer set search_path = ''
as $$
declare
    v_auction public.auctions%rowtype;
begin
    select * into v_auction from public.auctions where id = p_auction_id for update;
    if not found then raise exception 'Auction not found.'; end if;
    if v_auction.status = 'active' and v_auction.end_time <= clock_timestamp() then
        update public.auctions set
            status = case when highest_bidder_id is null then 'ended_no_bids' else 'awaiting_trade' end,
            winner_id = highest_bidder_id,
            winner_username = highest_bidder_username,
            final_price = case when highest_bidder_id is null then null else current_bid end,
            finalized_at = clock_timestamp()
        where id = p_auction_id returning * into v_auction;
    end if;
    return v_auction;
end;
$$;

-- Public maintenance is limited to closing auctions whose server deadline passed.
-- Locked listings are retried on the next refresh, rather than delaying reads.
create function public.finalize_expired_auctions()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_id uuid;
begin
    for v_id in
        select id from public.auctions
        where status = 'active' and end_time <= clock_timestamp()
        order by id for update skip locked
    loop
        perform public.finalize_auction(v_id);
    end loop;
end;
$$;

-- Each participant confirms their own completed in-game exchange.
-- Repeated confirmation is safe and does not reset the original timestamps.
create function public.confirm_auction_trade(p_auction_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_user uuid := auth.uid();
    v_auction public.auctions%rowtype;
begin
    if v_user is null then raise exception 'Please log in to confirm a trade.'; end if;
    v_auction := public.finalize_auction(p_auction_id);
    if v_user <> v_auction.seller_id and v_user is distinct from v_auction.winner_id then
        raise exception 'Only the seller and winning bidder can confirm this trade.';
    end if;
    if v_auction.status = 'completed' then return; end if;
    if v_auction.status <> 'awaiting_trade' then
        raise exception 'Only an ended auction with a winning bid can be confirmed.';
    end if;
    if v_user = v_auction.seller_id then
        update public.auctions set seller_confirmed_at = coalesce(seller_confirmed_at, clock_timestamp())
            where id = p_auction_id;
    else
        update public.auctions set buyer_confirmed_at = coalesce(buyer_confirmed_at, clock_timestamp())
            where id = p_auction_id;
    end if;
    update public.auctions set status = 'completed', completed_at = clock_timestamp()
        where id = p_auction_id and seller_confirmed_at is not null and buyer_confirmed_at is not null;
end;
$$;

create function public.cancel_auction(p_auction_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_user uuid := auth.uid();
    v_auction public.auctions%rowtype;
begin
    if v_user is null then raise exception 'Please log in to cancel a listing.'; end if;
    v_auction := public.finalize_auction(p_auction_id);
    if v_user <> v_auction.seller_id then raise exception 'Only the seller can cancel this listing.'; end if;
    if v_auction.status = 'cancelled' then return; end if;
    if v_auction.status <> 'active' then raise exception 'This auction has already ended.'; end if;
    if v_auction.highest_bidder_id is not null then
        raise exception 'An auction with bids cannot be cancelled.';
    end if;
    update public.auctions set status = 'cancelled', cancelled_at = clock_timestamp()
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

revoke all on function public.finalize_auction(uuid) from public, anon, authenticated;
revoke all on function public.finalize_expired_auctions() from public, anon, authenticated;
revoke all on function public.confirm_auction_trade(uuid) from public, anon, authenticated;
revoke all on function public.cancel_auction(uuid) from public, anon, authenticated;
grant execute on function public.finalize_expired_auctions() to anon, authenticated;
grant execute on function public.confirm_auction_trade(uuid) to authenticated;
grant execute on function public.cancel_auction(uuid) to authenticated;
-- CREATE OR REPLACE preserves the existing authenticated-only bid grant.

select public.finalize_expired_auctions();
notify pgrst, 'reload schema';
commit;
