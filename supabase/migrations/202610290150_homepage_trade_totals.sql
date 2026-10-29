-- Display-only, anonymous aggregate. Never used for financial authorization.
-- Apply after 149. No auction, delivery, balance or settlement records change.
begin;
set local lock_timeout='2s';
create table khub_bot.site_trade_totals_snapshot (
    singleton boolean primary key default true check(singleton),
    totals jsonb not null, refreshed_at timestamptz not null
);
alter table khub_bot.site_trade_totals_snapshot enable row level security;
revoke all on khub_bot.site_trade_totals_snapshot from public,anon,authenticated,service_role;

create function khub_bot.site_trade_totals() returns jsonb
language plpgsql security definer set search_path='' as $$
declare cached jsonb;
begin
    select totals into cached from khub_bot.site_trade_totals_snapshot
        where refreshed_at>clock_timestamp()-interval '5 minutes';
    if cached is not null then return cached; end if;
    -- Separate nonblocking display lock; never acquire the financial lock.
    if not pg_try_advisory_xact_lock(3888764) then
        return (select totals from khub_bot.site_trade_totals_snapshot where singleton);
    end if;
    select totals into cached from khub_bot.site_trade_totals_snapshot
        where refreshed_at>clock_timestamp()-interval '5 minutes';
    if cached is not null then return cached; end if;
    with sales as (
        select a.final_price::numeric as meat,
            case when a.bundle_items<>'[]'::jsonb then
                (select sum((component.value->>'quantity')::numeric) from jsonb_array_elements(a.bundle_items) as component(value))
                else a.quantity::numeric end as units
        from public.auctions a where a.auction_kind='sell'
            and a.status='completed' and a.winner_id is not null and a.final_price is not null
    ), purchases as (
        -- Only confirmed payments, counted once per fulfillment, even when a
        -- partially filled order subsequently expires or is cancelled.
        select f.payment_meat::numeric as meat,f.quantity::numeric as units
        from khub_bot.buy_fulfillments f
        where exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id
            and d.dedupe_key like 'buy-fill-payment:%' and d.state='sent')
        and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id
            and d.dedupe_key like 'buy-fill-payment:%' and d.state<>'sent')
    ), trades as (select * from sales union all select * from purchases)
    select jsonb_build_object('meat',coalesce(sum(meat),0)::text,
        'items',coalesce(sum(units),0)::text,'trades',count(*)::text) into cached from trades;
    insert into khub_bot.site_trade_totals_snapshot values(true,cached,clock_timestamp())
        on conflict(singleton) do update set totals=excluded.totals,refreshed_at=excluded.refreshed_at;
    return cached;
end;$$;
revoke all on function khub_bot.site_trade_totals() from public,anon,authenticated,service_role;
select khub_bot.site_trade_totals();

-- Keep both the direct and shared-cache homepage paths consistent. Existing
-- bounded listing queries stay unchanged; no extra browser request is needed.
alter function public.read_home_auctions() rename to read_home_auctions_before_site_totals;
revoke all on function public.read_home_auctions_before_site_totals() from public,anon,authenticated,service_role;
create function public.read_home_auctions() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
    return public.read_home_auctions_before_site_totals()
        ||jsonb_build_object('site_totals',khub_bot.site_trade_totals());
end;$$;
revoke all on function public.read_home_auctions() from public;
grant execute on function public.read_home_auctions() to anon,authenticated;
notify pgrst,'reload schema';
commit;
