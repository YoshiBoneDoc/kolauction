-- Apply after 051, then deploy the updated bot and website.
-- The live bot imports its bundled catalog on first startup, then refreshes weekly.
-- Until the first validated import, new listings fail closed. Existing auctions,
-- bid history, stored item names/images and financial deliveries are untouched.
begin;
alter table khub_bot.catalog add column image text,
    add column tradeable boolean not null default false,
    add column is_current boolean not null default false;
create table khub_bot.item_catalog_state (
    id boolean primary key default true check(id),
    source text not null,
    source_sha256 text not null,
    fetched_at timestamptz not null,
    synced_at timestamptz not null default clock_timestamp(),
    known_items integer not null,
    tradeable_items integer not null
);
alter table khub_bot.item_catalog_state enable row level security;
revoke all on khub_bot.item_catalog_state from public,anon,authenticated;
grant all on khub_bot.item_catalog_state to service_role;

create function public.bot_item_catalog_state() returns jsonb
language sql stable security definer set search_path='' as $$
    select to_jsonb(s)-'id' from khub_bot.item_catalog_state s where id;
$$;
create function public.bot_replace_item_catalog(p_items jsonb,p_fetched_at timestamptz,p_source_sha256 text) returns jsonb
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
    update khub_bot.catalog set is_current=false,tradeable=false;
    insert into khub_bot.catalog(id,name,image,tradeable,is_current)
        select (x->>'id')::integer,x->>'name',x->>'image',(x->>'tradeable')::boolean,true from jsonb_array_elements(p_items) x
        on conflict(id) do update set name=excluded.name,image=excluded.image,tradeable=excluded.tradeable,is_current=true;
    insert into khub_bot.item_catalog_state(id,source,source_sha256,fetched_at,synced_at,known_items,tradeable_items)
        values(true,'https://raw.githubusercontent.com/kolmafia/kolmafia/main/src/main/resources/data/items.txt',p_source_sha256,p_fetched_at,clock_timestamp(),total,tradable)
        on conflict(id) do update set source=excluded.source,source_sha256=excluded.source_sha256,
            fetched_at=excluded.fetched_at,synced_at=excluded.synced_at,known_items=excluded.known_items,tradeable_items=excluded.tradeable_items;
    return jsonb_build_object('known_items',total,'tradeable_items',tradable,'fetched_at',p_fetched_at);
end; $$;

-- Older name-only imports cannot erase/override the new eligibility metadata.
create or replace function public.bot_sync_catalog(p_items jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin raise exception 'Use the updated bot sync-catalog command to import names, images and tradeability together.'; end; $$;

create function public.read_item_catalog() returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_build_object('ready',exists(select 1 from khub_bot.item_catalog_state where id),
        'fetched_at',(select fetched_at from khub_bot.item_catalog_state where id),
        'items',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'image',c.image,'tradeable',true) order by c.id)
            from khub_bot.catalog c where c.is_current and c.tradeable),'[]'::jsonb));
$$;

create or replace function public.create_auction(p_item text,p_quantity bigint,p_min_bid_meat bigint,
    p_duration_hours integer,p_image text default null,p_instant_purchase_price bigint default null,
    p_item_id integer default null,p_escrow_mode boolean default true)
returns uuid language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; c khub_bot.catalog%rowtype; v_id uuid; v_now timestamptz:=clock_timestamp(); s khub_bot.settings%rowtype; item_image text;
begin
    perform pg_advisory_xact_lock(3888760);
    p:=khub_bot.require_verified_trader();
    if p_escrow_mode is null then raise exception 'Choose Escrow or Direct settlement.'; end if;
    if p_escrow_mode and p_min_bid_meat>1000000 then
        raise exception 'Escrow is limited to a minimum bid of 1M Meat during early access. Choose Direct to continue with this amount.';
    end if;
    if not exists(select 1 from khub_bot.item_catalog_state where id) then raise exception 'The item catalog is being updated. Please try again shortly.'; end if;
    select * into c from khub_bot.catalog where id=p_item_id and name=btrim(p_item);
    if not found then raise exception 'Choose a current catalog item. Refresh the page and select the item again.'; end if;
    if not c.tradeable or not c.is_current then raise exception 'Only tradeable items can be listed for auction.'; end if;
    if p_duration_hours is null or p_duration_hours not in (6,12,24,72,168,720) then raise exception 'Choose a valid auction duration.'; end if;
    -- Use the catalog image, never a client-supplied URL. Folder images use an
    -- explicit otherimages/... path rather than the usual itemimages directory.
    item_image:='https://images.kingdomofloathing.com/'||case when strpos(c.image,'/')>0 then c.image else 'itemimages/'||c.image end;
    select * into s from khub_bot.settings where id;
    insert into public.auctions(seller_id,seller_username,item,item_id,quantity,min_bid_meat,duration_hours,image,
        created_at,end_time,instant_purchase_price,escrow_mode,status,seller_kol_id,fee_bps,start_on_deposit)
    values(p.id,p.khub_username,c.name,c.id,p_quantity,p_min_bid_meat,p_duration_hours,item_image,
        v_now,v_now+make_interval(hours=>p_duration_hours),p_instant_purchase_price,p_escrow_mode,
        case when p_escrow_mode then 'pending_escrow' else 'active' end,p.kol_player_id,
        case when p_escrow_mode then s.fee_bps else 0 end,p_escrow_mode and s.start_on_deposit)
    returning id into v_id;
    return v_id;
end; $$;

revoke all on function public.bot_item_catalog_state(),public.bot_replace_item_catalog(jsonb,timestamptz,text),
    public.read_item_catalog() from public,anon,authenticated;
grant execute on function public.bot_item_catalog_state(),public.bot_replace_item_catalog(jsonb,timestamptz,text) to service_role;
grant execute on function public.read_item_catalog() to anon,authenticated;
notify pgrst,'reload schema';
commit;
