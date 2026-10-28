-- Apply after 108. Captures future completions only; existing trades are untouched.
begin;
create table khub_bot.auction_market_prices (
    auction_id uuid primary key references public.auctions(id) on delete cascade,
    item_id integer,
    price_meat bigint check(price_meat>0 and price_meat<=9007199254740991),
    observed_at timestamptz,
    checked_at timestamptz,
    available boolean not null,
    captured_at timestamptz not null default clock_timestamp(),
    check (not available or (price_meat is not null and observed_at is not null and checked_at is not null))
);
alter table khub_bot.auction_market_prices enable row level security;
revoke all on khub_bot.auction_market_prices from public,anon,authenticated;
grant all on khub_bot.auction_market_prices to service_role;

create function khub_bot.capture_completed_market_price() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if new.status='completed' then
        if tg_op='UPDATE' and old.status='completed' then return new; end if;
        insert into khub_bot.auction_market_prices(auction_id,item_id,price_meat,observed_at,checked_at,available)
            select new.id,new.item_id,case when m.available then m.price_meat end,
                m.observed_at,m.checked_at,coalesce(m.available,false)
            from (select 1) seed left join khub_bot.market_prices m on m.item_id=new.item_id
            on conflict(auction_id) do nothing;
    end if;
    return new;
end; $$;
revoke all on function khub_bot.capture_completed_market_price() from public,anon,authenticated;
create trigger auctions_capture_completed_market_price after insert or update of status on public.auctions
    for each row execute function khub_bot.capture_completed_market_price();

create function public.read_completed_market_prices(p_auction_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
    if p_auction_ids is null or cardinality(p_auction_ids)>500 then raise exception 'Request at most 500 auction prices.'; end if;
    return coalesce((select jsonb_agg(jsonb_build_object('auction_id',ids.id,
        'has_snapshot',m.auction_id is not null,'available',coalesce(m.available,false),
        'price_meat',case when m.available then m.price_meat end,
        'observed_at',m.observed_at,'checked_at',m.checked_at,'captured_at',m.captured_at))
        from (select distinct unnest(p_auction_ids) id) ids
        left join public.auctions a on a.id=ids.id and a.status='completed'
        left join khub_bot.auction_market_prices m on m.auction_id=a.id where ids.id is not null),'[]'::jsonb);
end; $$;
revoke all on function public.read_completed_market_prices(uuid[]) from public,anon,authenticated;
grant execute on function public.read_completed_market_prices(uuid[]) to anon,authenticated;
notify pgrst,'reload schema';
commit;
