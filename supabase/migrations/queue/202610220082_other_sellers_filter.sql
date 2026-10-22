-- Apply after 081, before deploying the My Auctions / Others / View All cycle.
-- Read-only: filter other sellers before counting, sorting and pagination.
-- No bot rebuild or restart is required.
begin;
select pg_advisory_xact_lock(3888760);
do $$
declare signature regprocedure; definition text;
    filter_anchor text := 'from public.auctions a' || E'\n    where';
    views_anchor text := 'p_view in (''home'',''browse'',''seller'')';
    pages_anchor text := 'p_view in (''browse'',''seller'')';
begin
    foreach signature in array array[
        'public.read_auction_page(text,uuid,text,text,text,integer)'::regprocedure,
        'public.read_auction_page(text,uuid,text,text,text,integer,text)'::regprocedure
    ] loop
        definition:=pg_get_functiondef(signature);
        if strpos(definition,filter_anchor)=0 or strpos(definition,views_anchor)=0 or strpos(definition,pages_anchor)=0 then
            raise exception 'Unexpected auction reader; other-sellers migration not applied.';
        end if;
        -- The viewer comes from the authenticated database session. A supplied
        -- p_id cannot change whose auctions this view excludes; guests get none.
        definition:=replace(definition,filter_anchor,filter_anchor
            ||' (p_view<>''others'' or (auth.uid() is not null and a.seller_id<>auth.uid())) and');
        definition:=replace(definition,views_anchor,'p_view in (''home'',''browse'',''seller'',''others'')');
        definition:=replace(definition,pages_anchor,'p_view in (''browse'',''seller'',''others'')');
        execute definition;
    end loop;
end; $$;
notify pgrst,'reload schema';
commit;
