-- After 234. Avoid rescanning the materialized seller pool for every candidate.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $$declare f record; d text; anchor text; patched integer:=0;begin
 anchor:='select a.* from candidates a'||chr(10)||'    where not coalesce((select r.restricted from seller_restrictions r where r.seller_id=a.seller_id),false)';
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='public' and p.proname='read_filtered_auction_page')
 or (n.nspname='khub_bot' and p.proname='public_listing_page') loop
  d:=pg_get_functiondef(f.oid);
  if strpos(d,anchor)=0 or strpos(d,'select distinct seller_id from candidates')=0 then
   raise exception 'Unexpected browse restriction pool: %',f.oid::regprocedure;
  end if;
  -- DISTINCT seller_id guarantees at most one match. Keep unmatched rows and
  -- every existing exclusion/count/order/projection/authorization predicate.
  execute replace(d,anchor,'select a.* from candidates a left join seller_restrictions r on r.seller_id=a.seller_id'||chr(10)||'    where not coalesce(r.restricted,false)');
  patched:=patched+1;
 end loop;
 if patched<>4 then raise exception 'Expected four browse readers, found %',patched; end if;
end $$;
notify pgrst,'reload schema';
commit;
