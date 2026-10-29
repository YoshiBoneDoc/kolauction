-- Reject explicit custom bundle titles that exactly match a currently live
-- bundle. Past auctions, automatic titles and ordinary item listings are unchanged.
-- The existing creation lock serializes the check with other auction creation.
begin;
create index if not exists auctions_active_bundle_title_idx on public.auctions(item)
    where status='active' and bundle_items<>'[]'::jsonb;

do $patch$
declare definition text;
    anchor text:='title:=nullif(btrim(p_title),'''');';
begin
    definition:=pg_get_functiondef('public.create_bundle_auction(jsonb,bigint,integer,bigint,boolean,timestamptz,text,integer)'::regprocedure);
    if strpos(definition,'live_bundle_title_validation_v1')=0 then
        if strpos(definition,anchor)=0 or strpos(definition,'perform pg_advisory_xact_lock(3888760);')=0 then
            raise exception 'Unexpected bundle creator; inspect before applying 139.';
        end if;
        definition:=replace(definition,anchor,anchor||$check$
    -- live_bundle_title_validation_v1: display names are case-sensitive.
    if title is not null and exists (
        select 1 from public.auctions a
        where a.item='Bundle: '||title and a.bundle_items<>'[]'::jsonb and a.status='active'
            and coalesce(a.escrow_buyout_received_at,a.end_time)>clock_timestamp()
    ) then
        raise exception 'A live bundle auction already uses this exact name. Please choose a different bundle title.'
            using errcode='PBT01';
    end if;
$check$);
        execute definition;
    end if;
end; $patch$;
notify pgrst,'reload schema';
commit;
