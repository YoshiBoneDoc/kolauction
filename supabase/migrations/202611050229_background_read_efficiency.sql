-- After 228. Read-only projection changes; financial functions/locks untouched.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
-- Derive the summary from the installed pending reader's matching CTE, preserving
-- all current eligibility, restriction, report and feedback rules. Avoid both
-- full row materialization and the expensive per-card projection for a count.
do $patch$
declare source text; boundary integer; body text;
begin
 select prosrc into source from pg_proc where oid='public.read_pending_trades(integer)'::regprocedure;
 boundary:=strpos(source,'), page as (');
 if boundary=0 or strpos(source,'with matching as materialized (')=0 then raise exception 'Unexpected pending trade reader'; end if;
 body:=replace(substring(source for boundary),'select a.* from public.auctions a','select a.id from public.auctions a') ||
 ' select jsonb_build_object(''privacy_version'',1,''total'',(select count(*) from matching));';
 execute 'create function public.read_pending_trade_summary() returns jsonb language sql stable security definer set search_path='''' as '||quote_literal(body);

end $patch$;
revoke all on function public.read_pending_trade_summary() from public,anon,authenticated,service_role;
grant execute on function public.read_pending_trade_summary() to authenticated;
-- Heartbeats are now 90 seconds apart. Presence remains an approximate recent
-- viewing indicator, with room for jitter; names remain administrator-only.
do $patch$
declare source text;
begin
 source:=pg_get_functiondef('public.khub_site_activity_counts()'::regprocedure);
 if strpos(source,'interval ''2 minutes''')=0 then raise exception 'Unexpected activity window'; end if;
 execute replace(source,'interval ''2 minutes''','interval ''3 minutes''');
end $patch$;
notify pgrst,'reload schema';
commit;
