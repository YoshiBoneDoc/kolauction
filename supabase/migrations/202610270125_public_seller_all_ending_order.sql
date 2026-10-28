-- Profile-only ordering for the All auctions + Ending soon view.
-- Apply after 202610260115_auction_price_filters.sql. Pagination is applied
-- after this ordering so active auctions stay ahead of history on every page.
begin;
select pg_advisory_xact_lock(3888760);

do $patch$
declare
    target regprocedure;
    definition text;
    anchor text := 'case when p_view=''home'' or p_sort=''ending'' then m.end_time end asc,';
    addition text := E'case when p_view=''seller'' and p_status=''all'' and p_sort=''ending'' then\n' ||
        E'            case when m.status=''active'' and coalesce(m.escrow_buyout_received_at,m.end_time)>statement_timestamp() then 0 else 1 end\n' ||
        E'        end asc,\n' ||
        E'        case when p_view=''seller'' and p_status=''all'' and p_sort=''ending''\n' ||
        E'            and m.status=''active'' and coalesce(m.escrow_buyout_received_at,m.end_time)>statement_timestamp()\n' ||
        E'        then coalesce(m.escrow_buyout_received_at,m.end_time) end asc,\n' ||
        E'        case when p_view=''seller'' and p_status=''all'' and p_sort=''ending''\n' ||
        E'            and not (m.status=''active'' and coalesce(m.escrow_buyout_received_at,m.end_time)>statement_timestamp())\n' ||
        E'        then coalesce(m.completed_at,m.cancelled_at,m.finalized_at,m.instant_purchased_at,m.end_time) end desc nulls last,\n' ||
        '        ';
    patched integer := 0;
begin
    for target in
        select p.oid::regprocedure
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('read_auction_page','read_filtered_auction_page')
    loop
        definition:=pg_get_functiondef(target);
        if strpos(definition,anchor)=0 then
            raise exception 'Unexpected auction reader: %',target;
        end if;
        if strpos(definition,'p_view=''seller'' and p_status=''all'' and p_sort=''ending'' then')=0 then
            definition:=replace(definition,anchor,addition||anchor);
            execute definition;
        end if;
        patched:=patched+1;
    end loop;
    if patched<3 then raise exception 'Expected at least 3 auction readers; found %',patched; end if;
end;
$patch$;

notify pgrst,'reload schema';
commit;
