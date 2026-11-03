-- Apply after 174. Restore explicit selected-auction history scope after 173.
-- No financial routines, bidder aliases, visibility rules or ACLs change.
begin;
set local lock_timeout='2s';
do $patch$
declare
    f record;
    definition text;
    anchor text := 'from public.bids b join labels l using(auction_id,bidder_id)';
    replacement text := 'from (select * from public.bids where auction_id in (select id from page)) b join labels l using(auction_id,bidder_id)';
begin
    -- Include overloads and the derived narrow context reader. History must not
    -- depend on the labels CTE being page-filtered: 173 made that CTE global.
    for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','khub_bot') and p.prokind='f'
          and strpos(p.prosrc,anchor)>0
    loop
        definition := pg_get_functiondef(f.oid);
        if strpos(definition,'page as materialized (')=0 then
            raise exception 'Unexpected history reader: %',f.oid::regprocedure;
        end if;
        execute replace(definition,anchor,replacement);
    end loop;
    -- Fail closed if either critical reader has an unexpected definition.
    if not exists(select 1 from pg_proc where oid='public.read_auction_page(text,uuid,text,text,text,integer)'::regprocedure
        and strpos(prosrc,replacement)>0)
       or not exists(select 1 from pg_proc where oid='public.read_auction_detail_context(text,uuid,text,text,text,integer)'::regprocedure
        and strpos(prosrc,replacement)>0) then
        raise exception 'Expected scoped full and narrow detail history readers';
    end if;
end;
$patch$;
notify pgrst,'reload schema';
commit;
