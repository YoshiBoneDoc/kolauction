-- Apply after 133. Recommended browse ordering: red timers (<= 3 hours)
-- ending soonest, then every other matching auction newest first.
-- Explicit sorts, status filters, pagination and all writes are unchanged.
begin;
do $patch$
declare target regprocedure; definition text; patched integer:=0;
    old_sort text:=$old$
        case when p_sort='recommended' then case when m.status='active'
            and coalesce(m.escrow_buyout_received_at,m.end_time)>statement_timestamp()
            and coalesce(m.escrow_buyout_received_at,m.end_time)<=statement_timestamp()+interval '24 hours' then 0 else 1 end end asc,
        case when p_sort='recommended' and m.status='active'
            and coalesce(m.escrow_buyout_received_at,m.end_time)>statement_timestamp()
            and coalesce(m.escrow_buyout_received_at,m.end_time)<=statement_timestamp()+interval '24 hours'
            then coalesce(m.escrow_buyout_received_at,m.end_time) end asc,
        case when p_sort='recommended' then m.created_at end desc,
$old$;
    new_sort text;
begin
    new_sort:=replace(old_sort,'interval ''24 hours''','interval ''3 hours''');
    new_sort:=replace(new_sort,'case when p_sort=''recommended'' then case',
        '/* red_time_recommended_v1 */ case when p_sort=''recommended'' then case');
    for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('read_auction_page','read_filtered_auction_page')
    loop
        definition:=pg_get_functiondef(target);
        if strpos(definition,'red_time_recommended_v1')>0 then
            patched:=patched+1;
        elsif strpos(definition,old_sort)>0 then
            execute replace(definition,old_sort,new_sort);
            patched:=patched+1;
        elsif strpos(definition,'p_sort=''recommended''')>0 then
            raise exception 'Unexpected recommended auction reader: %. Inspect before applying 137.',target;
        end if;
    end loop;
    if patched<3 then raise exception 'Expected recommended auction readers from migration 133. Inspect before applying 137.'; end if;
end; $patch$;
notify pgrst,'reload schema';
commit;
