-- Apply after 071, then deploy the website. Read-only popularity metadata;
-- no changes to bids, fees, auction outcomes or bot delivery behavior.
begin;
select pg_advisory_xact_lock(3888760);

create function khub_bot.hot_auction_ids() returns setof uuid
language sql stable security definer set search_path='' as $$
    with active_counts as materialized (
        select a.id,a.created_at,count(b.id) as bid_count
        from public.auctions a left join public.bids b on b.auction_id=a.id
        where a.status='active' and a.end_time>statement_timestamp()
            and not khub_bot.profile_is_restricted(a.seller_id)
        group by a.id,a.created_at
    )
    select id from active_counts where bid_count>0
    -- Round up to a whole auction; ties prefer older listings, then UUID.
    order by bid_count desc,created_at asc,id asc
    limit (select (count(*)+9)/10 from active_counts);
$$;
revoke all on function khub_bot.hot_auction_ids() from public,anon,authenticated,service_role;

-- Rank once across ALL live listings, before the existing reader applies
-- search, seller, status and pagination. Preserve every privacy wrapper.
do $$
declare definition text;
    cte_anchor text:='with matching as materialized (';
    row_anchor text:='khub_bot.public_auction(a,p.bid_count,h.label,w.label)';
begin
    definition:=pg_get_functiondef('public.read_auction_page(text,uuid,text,text,text,integer)'::regprocedure);
    if strpos(definition,cte_anchor)=0 or strpos(definition,row_anchor)=0 then
        raise exception 'Unexpected auction page reader; hot-card migration not applied.';
    end if;
    definition:=replace(definition,cte_anchor,
        'with hot_auctions as materialized (select khub_bot.hot_auction_ids() as id), matching as materialized (');
    definition:=replace(definition,row_anchor,row_anchor||
        '||jsonb_build_object(''is_hot'',exists(select 1 from hot_auctions hot where hot.id=a.id))');
    execute definition;
end; $$;

notify pgrst,'reload schema';
commit;
