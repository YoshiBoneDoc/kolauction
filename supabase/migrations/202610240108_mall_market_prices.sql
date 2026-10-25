-- Apply after 107. Deploy the updated website and standalone bot separately.
-- Reference prices only: no bidding, fee, balance or settlement rules change.
begin;
create table khub_bot.market_price_state (
    id boolean primary key default true check (id),
    last_success_at timestamptz,
    next_attempt_at timestamptz,
    last_failure_at timestamptz
);
insert into khub_bot.market_price_state(id) values(true);
create table khub_bot.market_prices (
    item_id integer primary key references khub_bot.catalog(id),
    price_meat bigint check(price_meat > 0 and price_meat <= 9007199254740991),
    observed_at timestamptz,
    checked_at timestamptz not null,
    available boolean not null,
    check ((price_meat is null) = (observed_at is null)),
    check (not available or price_meat is not null),
    check (observed_at is null or observed_at <= checked_at)
);
alter table khub_bot.market_price_state enable row level security;
alter table khub_bot.market_prices enable row level security;
revoke all on khub_bot.market_price_state,khub_bot.market_prices from public,anon,authenticated;
grant all on khub_bot.market_price_state,khub_bot.market_prices to service_role;

create function public.bot_market_price_state() returns jsonb
language sql stable security definer set search_path='' as $$
    select to_jsonb(s)-'id' from khub_bot.market_price_state s where id;
$$;

create function public.bot_market_price_failure() returns void
language plpgsql security definer set search_path='' as $$
begin
    update khub_bot.market_price_state set last_failure_at=clock_timestamp(),
        next_attempt_at=clock_timestamp()+interval '1 hour' where id;
end; $$;

create function public.bot_import_market_prices(p_items jsonb,p_observed_at timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare previous timestamptz;
begin
    if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>50000
        or p_observed_at is null or p_observed_at>clock_timestamp()+interval '5 minutes'
        or p_observed_at<clock_timestamp()-interval '1 hour' then raise exception 'Invalid market snapshot.'; end if;
    if exists(select 1 from jsonb_array_elements(p_items) x where
        jsonb_typeof(x) is distinct from 'object'
        or jsonb_typeof(x->'item_id') is distinct from 'number'
        or (x->>'item_id')!~'^[1-9][0-9]{0,9}$'
        or (x->>'item_id')::numeric>2147483647
        or not (x ? 'price_meat')
        or (x->'price_meat'<>'null'::jsonb and (jsonb_typeof(x->'price_meat') is distinct from 'number'
            or (x->>'price_meat')!~'^[1-9][0-9]{0,15}$'
            or (x->>'price_meat')::numeric>9007199254740991))) then raise exception 'Invalid market item.'; end if;
    if (select count(distinct x->>'item_id') from jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) then raise exception 'Duplicate market items.'; end if;
    -- Independent reference-data lock; never acquire the escrow advisory lock.
    perform pg_advisory_xact_lock(3888782);
    select last_success_at into previous from khub_bot.market_price_state where id for update;
    if previous is not null and p_observed_at<=previous then return; end if;
    if not exists(select 1 from khub_bot.item_catalog_state where id) then raise exception 'Catalog not initialized.'; end if;
    -- Missing, empty and limited-only items are normal unavailable observations.
    -- Retain the historical value privately, but never serve it as a current quote.
    insert into khub_bot.market_prices(item_id,price_meat,observed_at,checked_at,available)
        select c.id,(x->>'price_meat')::bigint,
            case when x->>'price_meat' is not null then p_observed_at end,p_observed_at,x->>'price_meat' is not null
        from khub_bot.catalog c left join jsonb_array_elements(p_items) x on (x->>'item_id')::integer=c.id
        where c.is_current and c.tradeable
        on conflict(item_id) do update set
            price_meat=coalesce(excluded.price_meat,khub_bot.market_prices.price_meat),
            observed_at=coalesce(excluded.observed_at,khub_bot.market_prices.observed_at),
            checked_at=excluded.checked_at,available=excluded.available;
    update khub_bot.market_price_state set last_success_at=p_observed_at,
        next_attempt_at=p_observed_at+interval '24 hours' where id;
end; $$;

create function public.read_market_prices(p_item_ids integer[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
    if p_item_ids is null or cardinality(p_item_ids)>500 then raise exception 'Request at most 500 item prices.'; end if;
    return coalesce((select jsonb_agg(jsonb_build_object('item_id',ids.id,
        'price_meat',case when m.available then m.price_meat end,
        'available',coalesce(m.available,false),'observed_at',m.observed_at,'checked_at',m.checked_at))
        from (select distinct unnest(p_item_ids) id) ids
        left join khub_bot.catalog c on c.id=ids.id and c.is_current and c.tradeable
        left join khub_bot.market_prices m on m.item_id=c.id where ids.id>0),'[]'::jsonb);
end; $$;

revoke all on function public.bot_market_price_state(),public.bot_market_price_failure(),
    public.bot_import_market_prices(jsonb,timestamptz),public.read_market_prices(integer[]) from public,anon,authenticated;
grant execute on function public.bot_market_price_state(),public.bot_market_price_failure(),
    public.bot_import_market_prices(jsonb,timestamptz) to service_role;
grant execute on function public.read_market_prices(integer[]) to anon,authenticated;
notify pgrst,'reload schema';
commit;
