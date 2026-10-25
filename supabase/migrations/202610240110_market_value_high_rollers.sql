-- Apply after 109. Read-only discovery changes; no bot runtime change required.
begin;
create function khub_bot.auction_market_value(p_item_id integer,p_quantity bigint) returns numeric
language sql stable set search_path='' as $$
    select coalesce((select m.price_meat::numeric*p_quantity from khub_bot.market_prices m
        join khub_bot.catalog c on c.id=m.item_id and c.is_current and c.tradeable
        where m.item_id=p_item_id and m.available),0);
$$;
create function khub_bot.high_roller_value(a public.auctions) returns numeric
language sql stable set search_path='' as $$
    select greatest(case when a.auction_kind='buy' then a.min_bid_meat
        when a.status='completed' then coalesce(a.final_price,a.current_bid)
        else coalesce(nullif(a.current_bid,0),a.min_bid_meat) end::numeric,
        khub_bot.auction_market_value(a.item_id,a.quantity));
$$;
revoke all on function khub_bot.auction_market_value(integer,bigint),khub_bot.high_roller_value(public.auctions)
    from public,anon,authenticated,service_role;

-- Reuse every existing privacy-filtered reader. Only the new internal sort
-- filters High Rollers before pagination; ordinary browsing stays unchanged.
do $patch$
declare target regprocedure; definition text; patched integer:=0;
    filter_anchor text:='from public.auctions a'||E'\n    where';
    sort_anchor text:='select m.* from matching m order by';
    row_anchor text:='khub_bot.public_auction(a,p.bid_count,h.label,w.label)';
begin
    for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='read_auction_page'
    loop
        definition:=pg_get_functiondef(target);
        if strpos(definition,filter_anchor)=0 or strpos(definition,sort_anchor)=0 or strpos(definition,row_anchor)=0 then
            raise exception 'Unexpected auction reader: %',target;
        end if;
        definition:=replace(definition,filter_anchor,filter_anchor||
            ' (p_sort<>''high-rollers'' or (a.status in (''active'',''completed'') and khub_bot.high_roller_value(a)>=50000000)) and');
        definition:=replace(definition,sort_anchor,sort_anchor||E'\n        case when p_sort=''high-rollers'' then greatest(\n            case when m.auction_kind=''buy'' then m.min_bid_meat\n                when m.status=''completed'' then coalesce(m.final_price,m.current_bid)\n                else coalesce(nullif(m.current_bid,0),m.min_bid_meat) end::numeric,\n            khub_bot.auction_market_value(m.item_id,m.quantity)) end desc,');
        definition:=replace(definition,row_anchor,row_anchor||
            '||jsonb_build_object(''market_value_meat'',khub_bot.auction_market_value(a.item_id,a.quantity)::text)');
        execute definition;patched:=patched+1;
    end loop;
    if patched<>3 then raise exception 'Expected 3 auction readers; found %',patched;end if;
end; $patch$;
notify pgrst,'reload schema';
commit;
