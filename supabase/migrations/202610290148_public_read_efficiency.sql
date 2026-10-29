-- Public display work only. Apply after 147; deploy the cache worker afterward.
-- Do not call these snapshots to authorize bids, funding, refunds or settlement.
begin;
set local lock_timeout='2s';
create table khub_bot.public_discovery_snapshot (
    singleton boolean primary key default true check(singleton),
    price_bounds jsonb not null, hot_ids uuid[] not null,
    refreshed_at timestamptz not null
);
revoke all on khub_bot.public_discovery_snapshot from public,anon,authenticated,service_role;

create function khub_bot.refresh_public_discovery() returns void
language plpgsql security definer set search_path='' as $$
begin
    if exists(select 1 from khub_bot.public_discovery_snapshot where refreshed_at>clock_timestamp()-interval '60 seconds') then return; end if;
    -- Independent, nonblocking lock: never hold up a financial transaction or
    -- make simultaneous visitors rebuild the same global aggregates.
    if not pg_try_advisory_xact_lock(3888763) then return; end if;
    if exists(select 1 from khub_bot.public_discovery_snapshot where refreshed_at>clock_timestamp()-interval '60 seconds') then return; end if;
    insert into khub_bot.public_discovery_snapshot(singleton,price_bounds,hot_ids,refreshed_at)
        values(true,khub_bot.public_auction_price_bounds(),array(select khub_bot.hot_auction_ids()),clock_timestamp())
        on conflict(singleton) do update set price_bounds=excluded.price_bounds,hot_ids=excluded.hot_ids,refreshed_at=excluded.refreshed_at;
end;$$;
select khub_bot.refresh_public_discovery();
create function khub_bot.cached_public_price_bounds() returns jsonb language sql stable set search_path='' as $$
    select price_bounds from khub_bot.public_discovery_snapshot where singleton;
$$;
create function khub_bot.cached_hot_auction_ids() returns setof uuid language sql stable set search_path='' as $$
    select unnest(hot_ids) from khub_bot.public_discovery_snapshot where singleton;
$$;

-- Literal substring matching, including %, _ and backslashes, remains exact.
create extension if not exists pg_trgm with schema extensions;
create function khub_bot.literal_auction_pattern(search text) returns text
language sql immutable parallel safe set search_path='' as $$
    select '%'||replace(replace(replace(lower(btrim(coalesce(search,''))),chr(92),chr(92)||chr(92)),'%',chr(92)||'%'),'_',chr(92)||'_')||'%';
$$;
create function khub_bot.bundle_search_names(contents jsonb) returns text
language sql immutable parallel safe set search_path='' as $$
    select lower(coalesce(string_agg(x->>'name',chr(31)),'')) from jsonb_array_elements(contents) x;
$$;
do $$ declare ns text;
begin
    select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm';
    execute format('create index auctions_item_substring_idx on public.auctions using gin (lower(item) %I.gin_trgm_ops)',ns);
    execute format('create index auctions_bundle_substring_idx on public.auctions using gin (khub_bot.bundle_search_names(bundle_items) %I.gin_trgm_ops)',ns);
end;$$;
create index auctions_seller_created_idx on public.auctions(seller_id,created_at desc,id);

do $patch$
declare target regprocedure; definition text;
    original text := '(strpos(lower(a.item),lower(btrim(coalesce(p_search,''''))))>0 or (a.bundle_items<>''[]''::jsonb and exists(select 1 from jsonb_array_elements(a.bundle_items) component where strpos(lower(component->>''name''),lower(btrim(coalesce(p_search,''''))))>0)))';
    replacement text := '(lower(a.item) like khub_bot.literal_auction_pattern(p_search) or (khub_bot.bundle_search_names(a.bundle_items) like khub_bot.literal_auction_pattern(p_search) and exists(select 1 from jsonb_array_elements(a.bundle_items) component where strpos(lower(component->>''name''),lower(btrim(coalesce(p_search,''''))))>0)))';
    matched integer:=0;
begin
    for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('read_filtered_auction_page','read_auction_page','read_home_auctions') loop
        definition:=pg_get_functiondef(target);
        if strpos(definition,original)>0 then definition:=replace(definition,original,replacement);matched:=matched+1; end if;
        definition:=replace(definition,'khub_bot.hot_auction_ids()','khub_bot.cached_hot_auction_ids()');
        definition:=replace(definition,'khub_bot.public_auction_price_bounds()','khub_bot.cached_public_price_bounds()');
        execute definition;
    end loop;
    if matched<>6 then raise exception 'Expected six bundle-aware readers, found %; inspect before applying 148.',matched; end if;
end; $patch$;

-- Extract the existing seller statistics verbatim. They stay outside the public
-- cache and retain the existing names/privacy/confirmed-transaction calculations.
do $patch$
declare body text; cut integer; ending integer; summary text;
begin
    select prosrc into body from pg_proc where oid='public.read_filtered_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text,text)'::regprocedure;
    cut:=strpos(body,', seller_lots as materialized (');
    ending:=strpos(body,E'\nselect jsonb_build_object(');
    if cut=0 or ending<=cut or strpos(body,'''seller'',(select to_jsonb(s) from seller_summary s)')=0 then raise exception 'Unexpected seller summary layout; inspect before applying 148.'; end if;
    summary:='with '||replace(substring(body from cut+2 for ending-cut-2),'p_view','''seller''')||' select to_jsonb(s) from seller_summary s';
    execute 'create function khub_bot.seller_read_summary(p_id uuid) returns jsonb language sql stable set search_path='''' as '||quote_literal(summary);
    body:=substring(body from 1 for cut-1)||substring(body from ending);
    body:=replace(body,'''seller'',(select to_jsonb(s) from seller_summary s)','''seller'',null');
    body:=replace(body,'from public.auctions a'||E'\n    where','from public.auctions a'||E'\n    where a.status<>''pending_escrow'' and');
    -- Anonymous cached rows never display participant names or bid histories.
    body:=replace(body,'where b.auction_id in (select id from page)','where false');
    execute 'create function khub_bot.public_listing_page(p_view text,p_id uuid,p_search text,p_status text,p_sort text,p_page integer,p_trade text,p_kind text,p_min_price numeric,p_max_price numeric,p_buyout text,p_bundle text) returns jsonb language sql stable set search_path='''' as '||quote_literal(body);
end; $patch$;

create function public.read_public_auction_page(p_view text,p_id uuid,p_search text,p_status text,p_sort text,p_page integer,p_trade text,p_kind text,p_min_price numeric,p_max_price numeric,p_buyout text default 'any',p_bundle text default 'any') returns jsonb
language plpgsql security definer set search_path='' as $$
begin
    if p_view is null or p_view not in ('browse','seller') or (p_view='seller' and p_id is null) then raise exception 'Choose a public listing view.'; end if;
    if length(coalesce(p_search,''))>120 or p_page is null or p_page not between 1 and 1000000 then raise exception 'Invalid public search or page.'; end if;
    perform khub_bot.refresh_public_discovery();
    return khub_bot.public_listing_page(p_view,p_id,p_search,p_status,p_sort,p_page,p_trade,p_kind,p_min_price,p_max_price,p_buyout,p_bundle);
end;$$;
create function public.read_public_home_auctions() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
    perform khub_bot.refresh_public_discovery();
    return public.read_home_auctions();
end;$$;
create function public.read_seller_auction_context(p_seller_id uuid,p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare context jsonb;
begin
    if p_seller_id is null or p_ids is null or cardinality(p_ids)>24 then raise exception 'Choose a seller and at most 24 auctions.'; end if;
    context:=case when auth.uid() is not null then public.read_auction_card_context(p_ids)
        else jsonb_build_object('privacy_version',1,'server_time',statement_timestamp(),'rows','[]'::jsonb) end;
    return context||jsonb_build_object('seller',khub_bot.seller_read_summary(p_seller_id),'bids','[]'::jsonb,'total',0);
end;$$;
revoke all on function khub_bot.refresh_public_discovery(),khub_bot.cached_public_price_bounds(),khub_bot.cached_hot_auction_ids(),khub_bot.seller_read_summary(uuid),khub_bot.public_listing_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text,text) from public,anon,authenticated,service_role;
-- Immutable search expressions must remain executable when ordinary auction
-- writers maintain their indexes; no table access or private data is involved.
revoke all on function public.read_public_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text,text),public.read_public_home_auctions(),public.read_seller_auction_context(uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.read_public_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text,text),public.read_public_home_auctions(),public.read_seller_auction_context(uuid,uuid[]) to anon,authenticated;
notify pgrst,'reload schema';
commit;
