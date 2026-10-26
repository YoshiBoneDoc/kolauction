-- Apply after 114 before deploying the auction Filters dropdown.
-- Read-only discovery changes. Auction, escrow and reservation writes are unchanged.
begin;
select pg_advisory_xact_lock(3888760);

create or replace function khub_bot.filter_auction_price(a public.auctions) returns numeric
language sql stable set search_path='' as $$
    select least(9007199254740991::numeric,greatest(0::numeric,coalesce(nullif(
        case when a.auction_kind='buy' then a.min_bid_meat
            else coalesce(a.final_price,nullif(a.current_bid,0),a.min_bid_meat) end,0),
        khub_bot.auction_market_value(a.item_id,a.quantity))));
$$;
revoke all on function khub_bot.filter_auction_price(public.auctions) from public,anon,authenticated,service_role;

do $patch$
declare target regprocedure; definition text; body text; patched integer:=0;
    status_anchor text:='when p_status=''completed'' then a.status=''completed''';
    filter_anchor text:='from public.auctions a'||E'\n    where';
    bounds_anchor text:='''privacy_version'',1,';
begin
    for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='read_auction_page'
    loop
        definition:=pg_get_functiondef(target);
        if strpos(definition,status_anchor)=0 then raise exception 'Unexpected auction reader: %',target;end if;
        if strpos(definition,'when p_status=''cancelled''')=0 then
        definition:=replace(definition,status_anchor,
            'when p_status=''cancelled'' then a.status in (''cancelled'',''voided'') '||
            'when p_status=''expired'' then a.status in (''expired'',''ended_no_bids'') '||status_anchor);
        execute definition;
        end if;
        patched:=patched+1;
    end loop;
    if patched<>3 then raise exception 'Expected 3 auction readers; found %',patched;end if;

    -- Reuse the existing privacy projection and trading/kind/ownership filters.
    select prosrc into body from pg_proc where oid='public.read_auction_page(text,uuid,text,text,text,integer,text,text)'::regprocedure;
    if strpos(body,filter_anchor)=0 or strpos(body,bounds_anchor)=0 then raise exception 'Unexpected filtered auction reader';end if;
    body:=replace(body,filter_anchor,filter_anchor||
        ' (p_min_price is null or khub_bot.filter_auction_price(a)>=p_min_price)'||
        ' and (p_max_price is null or khub_bot.filter_auction_price(a)<=p_max_price) and');
    -- Consider BOTH the current price and available market value for each lot.
    -- An unavailable market quote (0) must not artificially lower the minimum.
    -- Bounds never depend on page, search, ownership, status, kind, or trade.
    -- Pending deposits are private and must not affect this public aggregate.
    body:=replace(body,bounds_anchor,bounds_anchor||
        ' ''price_bounds'',(select jsonb_build_object(''min'',coalesce(min(least(v.price,coalesce(nullif(v.market,0),v.price))),0)::text,''max'',coalesce(max(greatest(v.price,v.market)),0)::text)'||
        ' from (select khub_bot.filter_auction_price(a) as price,least(9007199254740991::numeric,khub_bot.auction_market_value(a.item_id,a.quantity)) as market from public.auctions a where a.status<>''pending_escrow'' and not khub_bot.is_abandoned_escrow_draft(a)) v),');
    execute 'create or replace function public.read_filtered_auction_page(p_view text,p_id uuid,p_search text,p_status text,p_sort text,p_page integer,p_trade text,p_kind text,p_min_price numeric,p_max_price numeric)'||
        ' returns jsonb language sql stable security definer set search_path='''' as '||quote_literal(body);
end; $patch$;
revoke all on function public.read_filtered_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric) from public;
grant execute on function public.read_filtered_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric) to anon,authenticated;
notify pgrst,'reload schema';
commit;
