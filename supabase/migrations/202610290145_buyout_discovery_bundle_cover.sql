-- Apply before deploying the buyout filter. No financial/transaction changes.
begin;
select pg_advisory_xact_lock(3888760);

-- Keep the existing ten-argument reader compatible. The filtered overload uses
-- the same privacy projection, bounds, order, count and pagination machinery.
do $patch$
declare body text;
    anchor text := 'from public.auctions a'||E'\n    where';
begin
    select prosrc into body from pg_proc
        where oid='public.read_filtered_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric)'::regprocedure;
    if strpos(body,anchor)=0 then raise exception 'Unexpected auction reader; inspect before applying 145.'; end if;
    -- Only the matching set, not the independent public price bounds.
    body:=replace(body,anchor,anchor||$filter$
        (case p_buyout when 'any' then true
            when 'with' then coalesce(a.instant_purchase_price,0)>0
            when 'without' then coalesce(a.instant_purchase_price,0)<=0
            else false end) and$filter$);
    execute 'create or replace function public.read_filtered_auction_page(p_view text,p_id uuid,p_search text,p_status text,p_sort text,p_page integer,p_trade text,p_kind text,p_min_price numeric,p_max_price numeric,p_buyout text)'
        ||' returns jsonb language sql stable security definer set search_path='''' as '||quote_literal(body);
end; $patch$;
revoke all on function public.read_filtered_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text) from public,anon,authenticated,service_role;
grant execute on function public.read_filtered_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text) to anon,authenticated;

-- Preserve explicit component selection. Otherwise choose the highest known
-- unit market price, with canonical item ID as a stable tie/unavailable fallback.
do $patch$
declare definition text;
    anchor text := '    update public.auctions set item=title,bundle_items=contents,';
begin
    definition:=pg_get_functiondef('public.create_bundle_auction(jsonb,bigint,integer,bigint,boolean,timestamptz,text,integer)'::regprocedure);
    if strpos(definition,'bundle_market_cover_v1')=0 then
        if strpos(definition,anchor)=0 then raise exception 'Unexpected bundle creator; inspect before applying 145.'; end if;
        definition:=replace(definition,anchor,$cover$
    -- bundle_market_cover_v1: display choice only; contents and lot terms stay frozen.
    if p_image_item_id is null then
        select catalog.* into c from jsonb_array_elements(contents) component
            join khub_bot.catalog catalog on catalog.id=(component->>'id')::integer
            left join khub_bot.market_prices m on m.item_id=catalog.id and m.available
            order by coalesce(m.price_meat,0) desc,catalog.id asc limit 1;
    end if;
$cover$||anchor);
        execute definition;
    end if;
end; $patch$;
notify pgrst,'reload schema';
commit;
