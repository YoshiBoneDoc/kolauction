-- After 242. Reuse viewer permissions within one Buy-history statement.
-- Preserve all row fields, payment state checks, ordering, limit and grants.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $patch$
declare source text; anchor text;
begin
 source:=pg_get_functiondef('khub_bot.buy_history(uuid)'::regprocedure);
 anchor:='select coalesce(jsonb_agg(row_data';
 if (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1
   or strpos(source,'join public.profiles p on p.id=f.seller_id')=0
   or strpos(source,'limit 100')=0
   or strpos(source,'permissions as materialized')>0 then
   raise exception 'Unexpected Buy history layout; inspect before optimizing';
 end if;
 source:=replace(source,'khub_bot.is_administrator(auth.uid())','permissions.is_admin');
 source:=replace(source,'khub_bot.can_view_usernames()','permissions.names_visible');
 source:=replace(source,'auth.uid()','permissions.viewer_id');
 source:=replace(source,'join public.profiles p on p.id=f.seller_id',
   'join public.profiles p on p.id=f.seller_id cross join permissions');
 source:=replace(source,anchor,
   'with permissions as materialized (select auth.uid() as viewer_id,khub_bot.is_administrator(auth.uid()) as is_admin,khub_bot.can_view_usernames() as names_visible) '||anchor);
 execute source;
end $patch$;
notify pgrst,'reload schema';
commit;
