-- Apply once after 117, then deploy the matching website/bot and sync-catalog.
-- Catalog eligibility only. Financial intake, fees, locks, transfers and recovery
-- remain unchanged. Giftable items can be sent using ordinary KoL KMail.
begin;
select pg_advisory_xact_lock(3888760);
alter table khub_bot.catalog add column giftable boolean not null default false,
    add column is_gift_package boolean not null default false;

create function khub_bot.auction_item_eligible(c khub_bot.catalog) returns boolean
language sql immutable set search_path='' as $$
    select c.is_current and (c.tradeable or c.giftable) and not c.is_gift_package;
$$;
revoke all on function khub_bot.auction_item_eligible(khub_bot.catalog) from public,anon,authenticated,service_role;

-- Retain the existing full-snapshot validation, freshness checks, size guards,
-- atomic import and lock. Older snapshots fail closed for gift-only eligibility.
alter function public.bot_replace_item_catalog(jsonb,timestamptz,text) rename to replace_catalog_before_giftable;
alter function public.replace_catalog_before_giftable(jsonb,timestamptz,text) set schema khub_bot;
revoke all on function khub_bot.replace_catalog_before_giftable(jsonb,timestamptz,text) from public,anon,authenticated,service_role;
create function public.bot_replace_item_catalog(p_items jsonb,p_fetched_at timestamptz,p_source_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
    if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Invalid item catalog.';end if;
    if exists(select 1 from jsonb_array_elements(p_items) x where
        (x ? 'giftable' or x ? 'is_gift_package') and (
            jsonb_typeof(x->'giftable') is distinct from 'boolean' or
            jsonb_typeof(x->'is_gift_package') is distinct from 'boolean')) then
        raise exception 'Invalid gift eligibility metadata.';
    end if;
    result:=khub_bot.replace_catalog_before_giftable(p_items,p_fetched_at,p_source_sha256);
    update khub_bot.catalog c set giftable=coalesce(x.giftable,false),is_gift_package=coalesce(x.is_gift_package,false)
        from jsonb_to_recordset(p_items) as x(id integer,giftable boolean,is_gift_package boolean) where c.id=x.id;
    return result||jsonb_build_object('gift_only_items',(select count(*) from khub_bot.catalog c
        where khub_bot.auction_item_eligible(c) and not c.tradeable));
end; $$;
revoke all on function public.bot_replace_item_catalog(jsonb,timestamptz,text) from public,anon,authenticated;
grant execute on function public.bot_replace_item_catalog(jsonb,timestamptz,text) to service_role;

create or replace function public.read_item_catalog() returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_build_object('ready',exists(select 1 from khub_bot.item_catalog_state where id),
        'fetched_at',(select fetched_at from khub_bot.item_catalog_state where id),
        'items',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'image',c.image,
            'tradeable',c.tradeable,'giftable',c.giftable,'is_gift_package',c.is_gift_package) order by c.id)
            from khub_bot.catalog c where khub_bot.auction_item_eligible(c)),'[]'::jsonb));
$$;

-- Patch ONLY the eligibility predicate/message in both Sell creation overloads
-- and Buy creation. Keep their existing signatures, permissions and safeguards.
do $$
declare signature text;definition text;
    sell_predicate text:='not c.tradeable or not c.is_current';
    buy_predicate text:='id=p_item_id and tradeable and is_current';
begin
    foreach signature in array array[
        'public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean)',
        'public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean,timestamptz)'
    ] loop
        definition:=pg_get_functiondef(signature::regprocedure);
        if strpos(definition,sell_predicate)=0 then raise exception 'Unexpected Sell creator: %',signature;end if;
        definition:=replace(definition,sell_predicate,'not khub_bot.auction_item_eligible(c)');
        execute replace(definition,'Only tradeable items can be listed for auction.',
            'Choose a current tradeable or giftable item. Gift packages cannot be auctioned.');
    end loop;
    definition:=pg_get_functiondef('public.create_buy_auction(integer,bigint,bigint,integer,text)'::regprocedure);
    if strpos(definition,buy_predicate)=0 then raise exception 'Unexpected Buy creator.';end if;
    definition:=replace(definition,buy_predicate,'id=p_item_id and khub_bot.auction_item_eligible(catalog)');
    execute replace(definition,'Choose a current tradeable catalog item.',
        'Choose a current tradeable or giftable item. Gift packages cannot be auctioned.');
end; $$;
notify pgrst,'reload schema';
commit;
