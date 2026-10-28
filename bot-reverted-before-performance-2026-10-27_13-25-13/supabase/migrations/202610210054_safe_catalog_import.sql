-- Apply after 053. Repairs catalog imports on Supabase with safe-update checks.
-- Only currently eligible rows need resetting. Previously inactive rows already
-- have both flags false. Snapshot validation and atomic replacement stay intact.
-- This does not import a catalog or change existing auctions, bids or deliveries.
begin;
create or replace function public.bot_replace_item_catalog(p_items jsonb,p_fetched_at timestamptz,p_source_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare total integer; tradable integer; previous khub_bot.item_catalog_state%rowtype;
begin
    if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Invalid item catalog.'; end if;
    total:=jsonb_array_length(p_items);
    if total not between 10000 and 50000 or p_fetched_at is null or p_fetched_at>clock_timestamp()+interval '1 hour'
        or p_source_sha256 is null or p_source_sha256!~'^[a-f0-9]{64}$' then raise exception 'Incomplete item catalog or invalid source metadata.'; end if;
    if exists(select 1 from jsonb_array_elements(p_items) x where
        jsonb_typeof(x->'id') is distinct from 'number' or (x->>'id')!~'^[1-9][0-9]{0,9}$'
        or jsonb_typeof(x->'name') is distinct from 'string' or char_length(btrim(x->>'name')) not between 1 and 128
        or jsonb_typeof(x->'image') is distinct from 'string' or char_length(x->>'image')>128
        or (x->>'image')!~'^([A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+[.]gif$'
        or jsonb_typeof(x->'tradeable') is distinct from 'boolean') then raise exception 'Invalid catalog item fields.'; end if;
    if exists(select 1 from jsonb_array_elements(p_items) x where (x->>'id')::bigint>2147483647)
        or (select count(distinct (x->>'id')::integer) from jsonb_array_elements(p_items) x)<>total then
        raise exception 'Invalid or duplicate catalog item IDs.';
    end if;
    select count(*) into tradable from jsonb_array_elements(p_items) x where (x->>'tradeable')::boolean;
    if tradable<5000 then raise exception 'Missing item tradeability data.'; end if;
    perform pg_advisory_xact_lock(3888760);
    select * into previous from khub_bot.item_catalog_state where id for update;
    if found and (p_fetched_at<previous.fetched_at or total<previous.known_items*0.9
        or tradable<previous.tradeable_items*0.9) then raise exception 'Stale or unexpectedly reduced item catalog; previous catalog retained.'; end if;
    -- A full snapshot replaces eligibility atomically; retain missing IDs privately
    -- so historic item references and ledger descriptions still have their names.
    update khub_bot.catalog set is_current=false,tradeable=false
        where is_current or tradeable;
    insert into khub_bot.catalog(id,name,image,tradeable,is_current)
        select (x->>'id')::integer,x->>'name',x->>'image',(x->>'tradeable')::boolean,true from jsonb_array_elements(p_items) x
        on conflict(id) do update set name=excluded.name,image=excluded.image,tradeable=excluded.tradeable,is_current=true;
    insert into khub_bot.item_catalog_state(id,source,source_sha256,fetched_at,synced_at,known_items,tradeable_items)
        values(true,'https://raw.githubusercontent.com/kolmafia/kolmafia/main/src/main/resources/data/items.txt',p_source_sha256,p_fetched_at,clock_timestamp(),total,tradable)
        on conflict(id) do update set source=excluded.source,source_sha256=excluded.source_sha256,
            fetched_at=excluded.fetched_at,synced_at=excluded.synced_at,known_items=excluded.known_items,tradeable_items=excluded.tradeable_items;
    return jsonb_build_object('known_items',total,'tradeable_items',tradable,'fetched_at',p_fetched_at);
end; $$;
revoke all on function public.bot_replace_item_catalog(jsonb,timestamptz,text) from public,anon,authenticated;
grant execute on function public.bot_replace_item_catalog(jsonb,timestamptz,text) to service_role;
notify pgrst,'reload schema';
commit;
