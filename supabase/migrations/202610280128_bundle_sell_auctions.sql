-- Bundle sell lots: one bid, one winner, immutable catalog-backed contents.
-- Apply after 127. Stop bot workers while applying; existing listings are unchanged.
begin;
select pg_advisory_xact_lock(3888760);
alter table public.auctions add column bundle_items jsonb not null default '[]'::jsonb
    check (jsonb_typeof(bundle_items)='array' and jsonb_array_length(bundle_items) in (0,2,3,4,5,6,7,8,9,10));
alter table public.auctions add constraint auction_bundle_sell_only check
    (bundle_items='[]'::jsonb or (auction_kind='sell' and quantity=1));

create function khub_bot.auction_items(a public.auctions) returns jsonb
language sql immutable set search_path='' as $$
    select case when a.bundle_items='[]'::jsonb then jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',a.quantity))
        else (select jsonb_agg(jsonb_build_object('id',(x->>'id')::integer,'quantity',(x->>'quantity')::bigint) order by (x->>'id')::integer)
            from jsonb_array_elements(a.bundle_items) x) end;
$$;
create function khub_bot.auction_units(a public.auctions) returns bigint
language sql immutable set search_path='' as $$
    select coalesce(sum((x->>'quantity')::bigint),0)::bigint from jsonb_array_elements(khub_bot.auction_items(a)) x;
$$;
create function khub_bot.lot_market_value(a public.auctions) returns numeric
language sql stable set search_path='' as $$
    select case when a.bundle_items='[]'::jsonb then khub_bot.auction_market_value(a.item_id,a.quantity)
        else coalesce((select sum(khub_bot.auction_market_value((x->>'id')::integer,(x->>'quantity')::bigint))
            from jsonb_array_elements(a.bundle_items) x),0) end;
$$;
create function khub_bot.guard_bundle_terms() returns trigger
language plpgsql set search_path='' as $$
begin
    if old.bundle_items<>'[]'::jsonb and (new.bundle_items is distinct from old.bundle_items
        or new.item_id is distinct from old.item_id or new.quantity is distinct from old.quantity
        or new.item is distinct from old.item or new.image is distinct from old.image) then
        raise exception 'Published bundle contents cannot change.';
    end if;
    if old.bundle_items='[]'::jsonb and new.bundle_items<>'[]'::jsonb
        and (old.item_escrowed_at is not null or old.highest_bidder_id is not null or old.status not in ('pending_escrow','active')) then
        raise exception 'A funded or concluded listing cannot become a bundle.';
    end if;
    return new;
end; $$;
create trigger auctions_guard_bundle_terms before update on public.auctions for each row execute function khub_bot.guard_bundle_terms();

create function public.create_bundle_auction(p_items jsonb,p_min_bid_meat bigint,p_duration_hours integer,
    p_instant_purchase_price bigint default null,p_escrow_mode boolean default true,p_custom_end_at timestamptz default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare c khub_bot.catalog%rowtype; x jsonb; contents jsonb:='[]'; aid uuid; title text;
begin
    perform pg_advisory_xact_lock(3888760);
    perform khub_bot.require_verified_trader();
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
    -- Reuse current verified identity, catalog state, pricing, fee policy and scheduling validation.
    if p_custom_end_at is null then
        aid:=public.create_auction(c.name,1,p_min_bid_meat,p_duration_hours,null,p_instant_purchase_price,c.id,p_escrow_mode);
    else
        aid:=public.create_auction(c.name,1,p_min_bid_meat,p_duration_hours,null,p_instant_purchase_price,c.id,p_escrow_mode,p_custom_end_at);
    end if;
    title:='Bundle: '||left(contents->0->>'name',140)||' + '||(jsonb_array_length(contents)-1)||' more item types';
    update public.auctions set item=title,bundle_items=contents where id=aid;
    return aid;
end; $$;

-- Replace only the single-item assumption at the existing durable intake,
-- settlement and liability boundaries. Fail closed if the installed source differs.
do $$
declare def text; old text; target regprocedure;
begin
    foreach target in array array[
        'khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,
        'khub_bot.finish_listing_before_receipt_time(uuid,text)'::regprocedure
    ] loop
        def:=pg_get_functiondef(target);
        old:='jsonb_build_array(jsonb_build_object(''id'',a.item_id,''quantity'',a.quantity))';
        if strpos(def,old)=0 then raise exception 'Unexpected bundle integration source: %',target; end if;
        execute replace(def,old,'khub_bot.auction_items(a)');
    end loop;
    target:='khub_bot.liabilities_before_incoming_gifts()'::regprocedure;
    def:=pg_get_functiondef(target);
    old:='select item_id,quantity,0::bigint meat from public.auctions where auction_kind=''sell'' and escrow_mode and status=''active'' and item_escrowed_at is not null';
    if strpos(def,old)=0 then raise exception 'Unexpected bundle liability source.'; end if;
    execute replace(def,old,'select (x->>''id'')::integer item_id,(x->>''quantity'')::bigint quantity,0::bigint meat from public.auctions a cross join lateral jsonb_array_elements(khub_bot.auction_items(a)) x where a.auction_kind=''sell'' and a.escrow_mode and a.status=''active'' and a.item_escrowed_at is not null');
end; $$;

alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to auction_before_bundles;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language sql stable security definer set search_path='' as $$
    select khub_bot.auction_before_bundles(a,p_bid_count,p_highest_label,p_winner_label)
        ||jsonb_build_object('bundle_items',a.bundle_items,'is_bundle',a.bundle_items<>'[]'::jsonb);
$$;

-- All discovery surfaces use the complete lot's market value and unit count.
-- Search matches every component, even when the compact listing title abbreviates it.
do $$
declare r record; def text; changed text;
begin
    for r in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','khub_bot') and p.prokind='f'
        and p.proname not in ('lot_market_value','auction_items','auction_units')
        and (strpos(p.prosrc,'khub_bot.auction_market_value(a.item_id,a.quantity)')>0
            or strpos(p.prosrc,'sum(a.quantity)')>0
            or (strpos(p.prosrc,'p_search')>0 and strpos(p.prosrc,'lower(a.item)')>0))
    loop
        def:=pg_get_functiondef(r.oid);
        changed:=replace(def,'khub_bot.auction_market_value(a.item_id,a.quantity)','khub_bot.lot_market_value(a)');
        changed:=replace(changed,'sum(a.quantity)','sum(khub_bot.auction_units(a))');
        changed:=replace(changed,'strpos(lower(a.item),lower(btrim(coalesce(p_search,''''))))>0',
            '(strpos(lower(a.item),lower(btrim(coalesce(p_search,''''))))>0 or (a.bundle_items<>''[]''::jsonb and exists(select 1 from jsonb_array_elements(a.bundle_items) component where strpos(lower(component->>''name''),lower(btrim(coalesce(p_search,''''))))>0)))');
        if changed<>def then execute changed; end if;
    end loop;
end; $$;

-- A single-item completion quote is not a valid quote for a mixed-item lot.
-- Mark the legacy per-item snapshot unavailable for bundles instead of recording
-- a misleading price for just the first component.
do $$
declare def text; anchor text:='if new.status=''completed'' then';
begin
    def:=pg_get_functiondef('khub_bot.capture_completed_market_price()'::regprocedure);
    if strpos(def,anchor)=0 then raise exception 'Unexpected completed market-price capture source.'; end if;
    execute replace(def,anchor,anchor||E'\n'||
        'if new.bundle_items<>''[]''::jsonb then insert into khub_bot.auction_market_prices(auction_id,available) values(new.id,false) on conflict(auction_id) do nothing; return new; end if;');
end; $$;

-- Each existing item delivery still has its own claim, acknowledgment and recovery.
-- Say which component is attached instead of claiming the entire bundle arrived.
alter function khub_bot.friendly_message(khub_bot.deliveries) rename to message_before_bundles;
create function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql set search_path='' as $$
declare a public.auctions%rowtype; component jsonb;
begin
    select * into a from public.auctions where id=d.auction_id;
    if a.bundle_items<>'[]'::jsonb and d.kind in ('sale_item','return_item') then
        select value into component from jsonb_array_elements(a.bundle_items) where (value->>'id')::integer=d.item_id;
        if component is null then raise exception 'Bundle delivery item does not match its frozen contents.'; end if;
        return case when d.kind='sale_item' then 'You won the bundle!' else 'Your bundle items are being returned.' end
            ||E'\n\nAuction #'||a.auction_number||E'\nAttached in this message: '||khub_bot.format_message_number(d.quantity)||' x '||khub_bot.escape_report_kmail(component->>'name')
            ||E'\n\nThe bundle is delivered in separately tracked messages. Check the auction page for the complete contents.';
    end if;
    return khub_bot.message_before_bundles(d);
end; $$;

revoke all on function khub_bot.auction_items(public.auctions),khub_bot.auction_units(public.auctions),khub_bot.lot_market_value(public.auctions),
    khub_bot.guard_bundle_terms(),khub_bot.auction_before_bundles(public.auctions,bigint,text,text),khub_bot.message_before_bundles(khub_bot.deliveries),
    khub_bot.public_auction(public.auctions,bigint,text,text),khub_bot.friendly_message(khub_bot.deliveries),
    public.create_bundle_auction(jsonb,bigint,integer,bigint,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.create_bundle_auction(jsonb,bigint,integer,bigint,boolean,timestamptz) to authenticated;
notify pgrst,'reload schema';
commit;
