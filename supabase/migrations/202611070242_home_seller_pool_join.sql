-- After 241. Home still rescanned its materialized seller pool per active lot.
-- Use the same bounded join strategy as 235, retaining NULL/exclusion semantics.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $patch$
declare source text; anchor text;
begin
 source:=pg_get_functiondef('khub_bot.home_cards_core()'::regprocedure);
 anchor:='from khub_bot.visible_auctions() a'||chr(10)||'    where a.status=''active'' and coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp()'||chr(10)||'        and not (select r.restricted from seller_restrictions r where r.seller_id=a.seller_id)';
 if (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1
   or strpos(source,'select distinct a.seller_id')=0 then
   raise exception 'Unexpected Home seller pool; inspect installed definition';
 end if;
 execute replace(source,anchor,
   'from khub_bot.visible_auctions() a left join seller_restrictions r on r.seller_id=a.seller_id'||chr(10)||
   '    where a.status=''active'' and coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp()'||chr(10)||
   '        and not r.restricted');
end $patch$;
notify pgrst,'reload schema';
commit;
