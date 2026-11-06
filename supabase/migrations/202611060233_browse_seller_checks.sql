-- After 232. Reuse restriction results only within one authorized statement.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $patch$
declare f record; d text; anchor text; patched_count integer:=0;
begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='public' and p.proname='read_filtered_auction_page')
 or (n.nspname='khub_bot' and p.proname='public_listing_page') loop
  d:=pg_get_functiondef(f.oid);
  anchor:='khub_bot.profile_is_restricted(a.seller_id)';
  if (length(d)-length(replace(d,anchor,'')))/length(anchor)<>1 or strpos(d,'matching as materialized (')=0
   or strpos(d,'), page as materialized (')=0 then
   raise exception 'Unexpected browse layout: %',f.oid::regprocedure;
  end if;
  -- Preserve every original candidate predicate, including private visibility.
  -- Only the restriction-dependent exclusion moves into matching below.
  d:=replace(d,'matching as materialized (','candidates as materialized (');
  d:=replace(d,anchor,'false');
  d:=replace(d,'), page as materialized (',$sql$), seller_restrictions as materialized (
    select s.seller_id,khub_bot.profile_is_restricted(s.seller_id) as restricted
    from (select distinct seller_id from candidates
      where p_view in ('browse','seller','others')
      and coalesce(p_status,'') not in ('all','ended','on_hold','cancelled','expired','completed')
      and status='active' and coalesce(escrow_buyout_received_at,end_time)>statement_timestamp()) s
), matching as materialized (
    select a.* from candidates a
    where not coalesce((select r.restricted from seller_restrictions r where r.seller_id=a.seller_id),false)
      or not (a.status='active' and coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp())
), page as materialized ($sql$);
  execute d;
  patched_count:=patched_count+1;
 end loop;
 if patched_count<>4 then raise exception 'Expected four browse readers, found %',patched_count; end if;
end $patch$;
notify pgrst,'reload schema';
commit;
