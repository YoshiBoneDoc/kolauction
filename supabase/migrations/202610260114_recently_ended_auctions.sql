-- Apply after 113, before deploying the Recently Ended browse default.
-- Rank the full matching set before pagination, including early closures.
begin;
select pg_advisory_xact_lock(3888760);
do $patch$
declare target regprocedure; definition text; patched integer:=0;
    anchor text:='select m.* from matching m order by';
    addition text:=E'\n        case when p_sort=''ended-desc'' then least(m.end_time,m.finalized_at,m.instant_purchased_at) end desc nulls last,';
begin
    for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='read_auction_page'
    loop
        definition:=pg_get_functiondef(target);
        if strpos(definition,anchor)=0 then
            raise exception 'Unexpected auction reader: %',target;
        end if;
        if strpos(definition,addition)=0 then
            execute replace(definition,anchor,anchor||addition);
        end if;
        patched:=patched+1;
    end loop;
    if patched<>3 then raise exception 'Expected 3 auction readers; found %',patched;end if;
end; $patch$;
notify pgrst,'reload schema';
commit;
