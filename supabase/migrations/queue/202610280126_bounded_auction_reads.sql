-- Apply after 125, BEFORE deploying the matching website. Safe to rerun.
-- Read-only discovery: no changes to bot/financial routines, locks or balances.
begin;

-- Per-page Recent Activity lookups otherwise scan every bid for a lot.
create index if not exists bids_auction_created_at_idx on public.bids(auction_id,created_at desc);

create or replace function public.read_home_auctions() returns jsonb
language sql stable security definer set search_path='' as $$
with active as materialized (
    select a.id,a.item_id,a.item,a.created_at,coalesce(a.escrow_buyout_received_at,a.end_time) as deadline,
        (select count(*) from public.bids b where b.auction_id=a.id) as bid_count
    from public.auctions a
    where a.status='active' and coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp()
        and not khub_bot.profile_is_restricted(a.seller_id)
), ranked as (
    -- One representative per item, selected independently for each Explore tab.
    select *, row_number() over(partition by case when item_id is not null then 'id:'||item_id::text else 'name:'||lower(btrim(item)) end order by bid_count desc,created_at desc,id) as popular_rank,
        row_number() over(partition by case when item_id is not null then 'id:'||item_id::text else 'name:'||lower(btrim(item)) end order by created_at desc,id) as new_rank,
        row_number() over(partition by case when item_id is not null then 'id:'||item_id::text else 'name:'||lower(btrim(item)) end order by deadline,created_at desc,id) as ending_rank
    from active
), popular as materialized (
    select id,row_number() over(order by bid_count desc,created_at desc,id) as ordinal from ranked
    where popular_rank=1 order by bid_count desc,created_at desc,id limit 24
), newest as materialized (
    select id,row_number() over(order by created_at desc,id) as ordinal from ranked
    where new_rank=1 order by created_at desc,id limit 24
), ending as materialized (
    select id,row_number() over(order by deadline,created_at desc,id) as ordinal from ranked
    where ending_rank=1 order by deadline,created_at desc,id limit 24
), high_candidates as materialized (
    select a.id,khub_bot.high_roller_value(a) as value,
        a.status='active' and coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp()
            and coalesce(a.escrow_buyout_received_at,a.end_time)<=statement_timestamp()+interval '3 hours' as soon,
        coalesce(a.escrow_buyout_received_at,a.end_time) as deadline
    from public.auctions a where a.status='completed' or a.id in(select id from active)
), high as materialized (
    select id,row_number() over(order by soon desc,case when soon then deadline end,value desc,id) as ordinal
    from high_candidates where value>=50000000
    order by soon desc,case when soon then deadline end,value desc,id limit 24
), recent as materialized (
    select a.id,row_number() over(order by a.completed_at desc nulls last,a.id) as ordinal
    from public.auctions a where a.status='completed' and not khub_bot.is_abandoned_escrow_draft(a)
    order by a.completed_at desc nulls last,a.id limit 24
), selected as materialized (
    select id from popular union select id from newest union select id from ending union select id from high union select id from recent
), labels as materialized (
    select b.auction_id,b.bidder_id,'Bidder '||row_number() over(partition by b.auction_id order by min(b.created_at),b.bidder_id)::text as label
    from public.bids b where b.auction_id in(select id from selected) group by b.auction_id,b.bidder_id
), hot as materialized (select khub_bot.hot_auction_ids() as id)
select jsonb_build_object('privacy_version',1,'server_time',statement_timestamp(),
    'total',(select count(*) from active),'bids','[]'::jsonb,
    'sections',jsonb_build_object(
        'popular',coalesce((select jsonb_agg(id order by ordinal) from popular),'[]'::jsonb),
        'new',coalesce((select jsonb_agg(id order by ordinal) from newest),'[]'::jsonb),
        'ending',coalesce((select jsonb_agg(id order by ordinal) from ending),'[]'::jsonb),
        'highRollers',coalesce((select jsonb_agg(id order by ordinal) from high),'[]'::jsonb),
        'recent',coalesce((select jsonb_agg(id order by ordinal) from recent),'[]'::jsonb)),
    'rows',coalesce((select jsonb_agg(khub_bot.public_auction(a,
        (select count(*) from public.bids b where b.auction_id=a.id),h.label,w.label)
        ||jsonb_build_object('market_value_meat',khub_bot.auction_market_value(a.item_id,a.quantity)::text,
            'is_hot',exists(select 1 from hot where hot.id=a.id)) order by a.id)
        from selected s join public.auctions a on a.id=s.id
        left join labels h on h.auction_id=a.id and h.bidder_id=a.highest_bidder_id
        left join labels w on w.auction_id=a.id and w.bidder_id=a.winner_id),'[]'::jsonb));
$$;
revoke all on function public.read_home_auctions() from public;
grant execute on function public.read_home_auctions() to anon,authenticated;

-- Preserve the public slider's global bounds, but join market/catalog tables
-- once rather than performing repeated per-auction market-value function calls.
create or replace function khub_bot.public_auction_price_bounds() returns jsonb
language sql stable set search_path='' as $$
with lots as materialized (
    select case when a.auction_kind='buy' then a.min_bid_meat
            else coalesce(a.final_price,nullif(a.current_bid,0),a.min_bid_meat) end::numeric as raw_price,
        case when c.id is not null then coalesce(m.price_meat::numeric*a.quantity,0) else 0 end as raw_market
    from public.auctions a
    left join khub_bot.market_prices m on m.item_id=a.item_id and m.available
    left join khub_bot.catalog c on c.id=m.item_id and c.is_current and c.tradeable
    where a.status<>'pending_escrow' and not khub_bot.is_abandoned_escrow_draft(a)
), prices as (
    select least(9007199254740991::numeric,greatest(0::numeric,coalesce(nullif(raw_price,0),raw_market))) as price,
        least(9007199254740991::numeric,raw_market) as market from lots
)
select jsonb_build_object('min',coalesce(min(least(price,coalesce(nullif(market,0),price))),0)::text,
    'max',coalesce(max(greatest(price,market)),0)::text) from prices;
$$;
revoke all on function khub_bot.public_auction_price_bounds() from public,anon,authenticated,service_role;

-- Keep the existing filtered reader, authorization rules, projection and bounds.
-- Only compute bid statistics across the full matching set when sorting by them;
-- otherwise compute them for the selected 24 rows. This also preserves all
-- profile-reader overloads untouched.
do $patch$
declare definition text;
    count_anchor text := '(select count(*) from public.bids b where b.auction_id=a.id) as bid_count';
    activity_anchor text := 'greatest((select max(b.created_at) from public.bids b where b.auction_id=a.id),(select max(f.created_at) from khub_bot.buy_fulfillments f where f.auction_id=a.id)) as latest_bid_at';
    projection_anchor text := 'khub_bot.public_auction(a,p.bid_count,h.label,w.label)';
    bounds_anchor text := '''price_bounds'',(select jsonb_build_object(''min'',coalesce(min(least(v.price,coalesce(nullif(v.market,0),v.price))),0)::text,''max'',coalesce(max(greatest(v.price,v.market)),0)::text) from (select khub_bot.filter_auction_price(a) as price,least(9007199254740991::numeric,khub_bot.auction_market_value(a.item_id,a.quantity)) as market from public.auctions a where a.status<>''pending_escrow'' and not khub_bot.is_abandoned_escrow_draft(a)) v)';
begin
    definition:=pg_get_functiondef('public.read_filtered_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric)'::regprocedure);
    if strpos(definition,'/* bounded_read_v1 */')=0 then
        if strpos(definition,count_anchor)=0 or strpos(definition,activity_anchor)=0 or strpos(definition,projection_anchor)=0 or strpos(definition,bounds_anchor)=0 then
            raise exception 'Unexpected filtered reader; inspect its definition before applying migration 126.';
        end if;
        definition:=replace(definition,count_anchor,'/* bounded_read_v1 */ case when p_sort in (''bids-desc'',''bids-asc'') or p_view=''home'' then (select count(*) from public.bids b where b.auction_id=a.id) end as bid_count');
        definition:=replace(definition,activity_anchor,'case when p_sort=''activity'' then greatest((select max(b.created_at) from public.bids b where b.auction_id=a.id),(select max(f.created_at) from khub_bot.buy_fulfillments f where f.auction_id=a.id)) end as latest_bid_at');
        definition:=replace(definition,projection_anchor,'khub_bot.public_auction(a,coalesce(p.bid_count,(select count(*) from public.bids b where b.auction_id=a.id)),h.label,w.label)');
        definition:=replace(definition,'''latest_bid_at'',p.latest_bid_at','''latest_bid_at'',coalesce(p.latest_bid_at,greatest((select max(b.created_at) from public.bids b where b.auction_id=a.id),(select max(f.created_at) from khub_bot.buy_fulfillments f where f.auction_id=a.id)))');
        definition:=replace(definition,bounds_anchor,'''price_bounds'',khub_bot.public_auction_price_bounds()');
        -- Match the existing browser lifecycle: a deadline alone does not prove
        -- closure. Active includes finalizing, while restricted bidding is closed.
        definition:=replace(definition,'when p_status=''ended'' then a.status not in (''pending_escrow'',''on_hold'')
                    and (a.status<>''active'' or coalesce(a.escrow_buyout_received_at,a.end_time)<=statement_timestamp())',
            'when p_status=''ended'' then a.status not in (''active'',''pending_escrow'',''on_hold'',''bidding_closed'')');
        definition:=replace(definition,'else a.status=''active'' and coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp() end)',
            'else a.status=''active'' and not (khub_bot.profile_is_restricted(a.seller_id) and coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp()) end)');
        definition:=replace(definition,'least(m.end_time,m.finalized_at,m.instant_purchased_at) end desc nulls last',
            'case when m.status in (''cancelled'',''voided'') then m.cancelled_at else least(m.end_time,m.finalized_at,m.instant_purchased_at) end end desc nulls last');
        execute definition;
    end if;
end;
$patch$;

notify pgrst,'reload schema';
commit;
