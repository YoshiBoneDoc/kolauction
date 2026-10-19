-- Run once AFTER 202610180001_create_profiles.sql in Supabase SQL Editor.
begin;

create table public.auctions (
    id uuid primary key default gen_random_uuid(),
    seller_id uuid not null references public.profiles(id),
    seller_username text not null,
    item text not null check (char_length(btrim(item)) between 1 and 200),
    quantity bigint not null check (quantity between 1 and 5000000000),
    min_bid_meat bigint not null check (min_bid_meat between 1 and 10000000000),
    duration_hours integer not null check (duration_hours in (6, 12, 24, 72, 168, 720)),
    image text check (image is null or char_length(image) <= 2048),
    created_at timestamptz not null default clock_timestamp(),
    end_time timestamptz not null,
    current_bid bigint not null default 0 check (current_bid between 0 and 20000000000),
    highest_bidder_id uuid references public.profiles(id),
    check (end_time > created_at)
);

create table public.bids (
    id uuid primary key default gen_random_uuid(),
    auction_id uuid not null references public.auctions(id),
    bidder_id uuid not null references public.profiles(id),
    bidder_username text not null,
    amount bigint not null check (amount between 1 and 20000000000),
    created_at timestamptz not null default clock_timestamp(),
    unique (auction_id, amount)
);

create index auctions_created_at_idx on public.auctions (created_at desc, id);
create index auctions_seller_id_idx on public.auctions (seller_id);
create index bids_auction_id_idx on public.bids (auction_id, amount);
create index bids_bidder_id_idx on public.bids (bidder_id);

alter table public.auctions enable row level security;
alter table public.bids enable row level security;
revoke all on table public.auctions, public.bids from public, anon, authenticated;
grant select on table public.auctions, public.bids to anon, authenticated;
grant all on table public.auctions, public.bids to service_role;
create policy auctions_public_read on public.auctions for select to anon, authenticated using (true);
create policy bids_public_read on public.bids for select to anon, authenticated using (true);

-- All client writes use these functions, never arbitrary table updates.
-- Identity and public username snapshots come from the authenticated profile.
create function public.create_auction(
    p_item text, p_quantity bigint, p_min_bid_meat bigint,
    p_duration_hours integer, p_image text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user uuid := auth.uid();
    v_username text;
    v_id uuid;
    v_created timestamptz := clock_timestamp();
begin
    if v_user is null then
        raise exception 'Please log in to create an auction.';
    end if;
    select khub_username into v_username from public.profiles where id = v_user;
    if not found then raise exception 'Your user profile could not be found.'; end if;
    if p_duration_hours is null or p_duration_hours not in (6, 12, 24, 72, 168, 720) then
        raise exception 'Choose a valid auction duration.';
    end if;
    insert into public.auctions (
        seller_id, seller_username, item, quantity, min_bid_meat,
        duration_hours, image, created_at, end_time
    ) values (
        v_user, v_username, btrim(p_item), p_quantity, p_min_bid_meat,
        p_duration_hours, p_image, v_created,
        v_created + pg_catalog.make_interval(hours => p_duration_hours)
    ) returning id into v_id;
    return v_id;
end;
$$;

create function public.place_bid(p_auction_id uuid, p_amount bigint)
returns void
language plpgsql
security definer
set search_path = ''
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

    -- Serialize bids per auction. Re-check time and amount AFTER acquiring
    -- the lock, including when another bidder made us wait.
    select * into v_auction from public.auctions where id = p_auction_id for update;
    if not found then raise exception 'Auction not found.'; end if;
    if v_auction.end_time <= clock_timestamp() then raise exception 'This auction has ended.'; end if;
    if v_auction.seller_id = v_user then raise exception 'You cannot bid on your own auction.'; end if;
    if v_auction.highest_bidder_id = v_user then raise exception 'You are already the highest bidder.'; end if;
    if p_amount < v_auction.min_bid_meat or p_amount <= v_auction.current_bid then
        raise exception 'Your bid must meet the minimum and exceed the current bid. Please check the latest price.';
    end if;

    insert into public.bids (auction_id, bidder_id, bidder_username, amount)
        values (p_auction_id, v_user, v_username, p_amount);
    update public.auctions set current_bid = p_amount, highest_bidder_id = v_user
        where id = p_auction_id;
end;
$$;

revoke all on function public.create_auction(text, bigint, bigint, integer, text) from public, anon, authenticated;
revoke all on function public.place_bid(uuid, bigint) from public, anon, authenticated;
grant execute on function public.create_auction(text, bigint, bigint, integer, text) to authenticated;
grant execute on function public.place_bid(uuid, bigint) to authenticated;

notify pgrst, 'reload schema';
commit;
