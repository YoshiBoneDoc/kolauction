-- Apply after 170. Reuse its public Sell projection for anonymous featured reads.
-- Authenticated featured reads retain the full authorized projection. Selection,
-- ignore filtering, deadlines, bid counts and seller restrictions are unchanged.
begin;
set local lock_timeout='2s';
do $patch$
declare definition text; anchor text:='khub_bot.public_auction(a,';
begin
    definition:=pg_get_functiondef('public.read_featured_giveaway()'::regprocedure);
    if strpos(definition,anchor)=0 then raise exception 'Unexpected featured projection; inspect before applying 171.';end if;
    execute replace(definition,anchor,'khub_bot.public_home_listing_projection(a,');
end;$patch$;
notify pgrst,'reload schema';
commit;
