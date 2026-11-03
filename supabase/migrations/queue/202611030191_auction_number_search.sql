-- Add an exact auction-number alternative to existing literal name search.
begin;
create function khub_bot.search_auction_number(p_search text) returns bigint
language plpgsql immutable set search_path='' as $$
declare term text:=btrim(p_search);
begin
    if term is null or term !~ '^[0-9]+$' then return null; end if;
    begin return term::bigint;
    exception when numeric_value_out_of_range then return null; end;
end; $$;
revoke all on function khub_bot.search_auction_number(text) from public,anon,authenticated,service_role;
do $$
declare target regprocedure; d text; matches integer:=0;
    anchor text:='lower(a.item) like khub_bot.literal_auction_pattern(p_search)';
begin
    for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where (n.nspname='public' and p.proname in ('read_filtered_auction_page','read_auction_page','read_home_auctions'))
           or (n.nspname='khub_bot' and p.proname='public_listing_page') loop
        d:=pg_get_functiondef(target);
        if strpos(d,anchor)>0 then
            execute replace(d,anchor,'('||anchor||' or a.auction_number=khub_bot.search_auction_number(p_search))');
            matches:=matches+1;
        end if;
    end loop;
    if matches<2 then raise exception 'Expected public and private listing search definitions'; end if;
end; $$;
notify pgrst,'reload schema';
commit;
