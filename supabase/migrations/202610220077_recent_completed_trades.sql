-- Apply after 076, before deploying the completed-trades carousel.
-- Read-only ordering; completion rules and privacy projection are unchanged.
begin;
select pg_advisory_xact_lock(3888760);
do $$
declare
    signature regprocedure;
    definition text;
    anchor text := 'select m.* from matching m order by';
    addition text := E'\n        case when p_sort=''completed'' then m.completed_at end desc nulls last,';
begin
    foreach signature in array array[
        'public.read_auction_page(text,uuid,text,text,text,integer)'::regprocedure,
        'public.read_auction_page(text,uuid,text,text,text,integer,text)'::regprocedure
    ] loop
        definition := pg_get_functiondef(signature);
        if strpos(definition,addition)>0 then continue; end if;
        if strpos(definition,anchor)=0 then
            raise exception 'Unexpected auction reader; completed-trades migration not applied.';
        end if;
        execute replace(definition,anchor,anchor || addition);
    end loop;
end; $$;
notify pgrst,'reload schema';
commit;
