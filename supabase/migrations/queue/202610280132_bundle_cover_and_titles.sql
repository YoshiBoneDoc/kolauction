-- Bundle display titles and a catalog-validated cover selection. Apply after 131.
-- Existing listings, immutable contents, deposits and settlement rules are unchanged.
begin;
select pg_advisory_xact_lock(3888760);

-- Replace the signature rather than adding an ambiguous default-argument overload.
-- Existing callers may omit p_title and retain the automatic catalog-based title.
drop function public.create_bundle_auction(jsonb,bigint,integer,bigint,boolean,timestamptz,text);
create function public.create_bundle_auction(p_items jsonb,p_min_bid_meat bigint,p_duration_hours integer,
    p_instant_purchase_price bigint default null,p_escrow_mode boolean default true,p_custom_end_at timestamptz default null,
    p_title text default null,p_image_item_id integer default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare c khub_bot.catalog%rowtype; x jsonb; contents jsonb:='[]'; aid uuid; title text;
begin
    perform pg_advisory_xact_lock(3888760);
    perform khub_bot.require_verified_trader();
    if p_title is not null and (char_length(btrim(p_title))>100 or p_title ~ '[[:cntrl:]<>]'
        or p_title ~ U&'[\007F-\009F\2028\2029\202A-\202E\2066-\2069]') then
        raise exception 'Bundle title must be 100 characters or fewer and use plain text on one line.';
    end if;
    title:=nullif(btrim(p_title),'');
    if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Choose 2 to 10 different items for the bundle.'; end if;
    if jsonb_array_length(p_items) not between 2 and 10 then raise exception 'Choose 2 to 10 different items for the bundle.'; end if;
    for x in select value from jsonb_array_elements(p_items) loop
        if jsonb_typeof(x) is distinct from 'object' or coalesce(x->>'id','')!~'^[1-9][0-9]{0,9}$'
            or coalesce(x->>'quantity','')!~'^[1-9][0-9]{0,9}$' then raise exception 'Each bundle item needs a valid ID and whole quantity.'; end if;
        if (x->>'id')::bigint>2147483647 or (x->>'quantity')::bigint>5000000000 then raise exception 'Bundle item ID or quantity exceeds the supported limit.'; end if;
        if exists(select 1 from jsonb_array_elements(contents) y where y->>'id'=((x->>'id')::integer)::text) then raise exception 'Use one quantity per item; duplicate bundle items are not allowed.'; end if;
        select * into c from khub_bot.catalog where id=(x->>'id')::integer;
        if not found or not khub_bot.auction_item_eligible(c) then raise exception 'Choose current tradeable or giftable catalog items. Gift packages cannot be auctioned.'; end if;
        contents:=contents||jsonb_build_array(jsonb_build_object('id',c.id,'quantity',(x->>'quantity')::bigint,'name',c.name,
            'image','https://images.kingdomofloathing.com/'||case when strpos(c.image,'/')>0 then c.image else 'itemimages/'||c.image end));
    end loop;
    select jsonb_agg(value order by (value->>'id')::integer) into contents from jsonb_array_elements(contents);
    select * into c from khub_bot.catalog where id=(contents->0->>'id')::integer;
    -- The existing creator validates identity, catalog state, prices, fees and schedule.
    if p_custom_end_at is null then
        aid:=public.create_auction(c.name,1,p_min_bid_meat,p_duration_hours,null,p_instant_purchase_price,c.id,p_escrow_mode);
    else
        aid:=public.create_auction(c.name,1,p_min_bid_meat,p_duration_hours,null,p_instant_purchase_price,c.id,p_escrow_mode,p_custom_end_at);
    end if;
    title:=coalesce('Bundle: '||title,'Bundle: '||left(contents->0->>'name',140)||' + '||(jsonb_array_length(contents)-1)||' more item types');
    if p_image_item_id is not null and not exists(select 1 from jsonb_array_elements(contents) component(value) where (component.value->>'id')::integer=p_image_item_id) then
        raise exception 'Choose a bundle component as the cover image.';
    end if;
    update public.auctions set item=title,bundle_items=contents,
        image=coalesce((select component.value->>'image' from jsonb_array_elements(contents) component(value) where (component.value->>'id')::integer=coalesce(p_image_item_id,c.id)),image)
        where id=aid;
    return aid;
end; $$;

revoke all on function public.create_bundle_auction(jsonb,bigint,integer,bigint,boolean,timestamptz,text,integer)
    from public,anon,authenticated,service_role;
grant execute on function public.create_bundle_auction(jsonb,bigint,integer,bigint,boolean,timestamptz,text,integer) to authenticated;
notify pgrst,'reload schema';
commit;
