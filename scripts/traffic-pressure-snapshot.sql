-- Read-only SQL Editor capture DURING a slowdown. Export the single JSON cell.
-- No SQL text, parameters, player identities or credentials are returned.
-- Run separately from query-stats-snapshot.sql; do not reset counters.
with activity as materialized (
 select pid,state,wait_event_type,wait_event,backend_type,
   extract(epoch from clock_timestamp()-query_start) as query_age_seconds,
   extract(epoch from clock_timestamp()-xact_start) as transaction_age_seconds,
   pg_blocking_pids(pid) as blockers,
   coalesce(substring(query from '"public"\."([a-z_][a-z0-9_]*)"[[:space:]]*\('),
            substring(query from 'public\.([a-z_][a-z0-9_]*)[[:space:]]*\(')) as rpc
 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
), financial_lock as (
 select pid,granted,mode from pg_locks
 where locktype='advisory' and database=(select oid from pg_database where datname=current_database())
 and classid=0 and objid=3888760 and objsubid=1
)
select jsonb_build_object(
 'captured_at',clock_timestamp(),
 'settings',(select jsonb_object_agg(name,setting) from pg_settings where name in
   ('max_connections','shared_buffers','work_mem','jit','jit_above_cost','statement_timeout','lock_timeout','track_io_timing')),
 'database',(select to_jsonb(d)-'datid'-'datname' from pg_stat_database d where datname=current_database()),
 'activity_groups',coalesce((select jsonb_agg(to_jsonb(g)) from (
   select backend_type,state,wait_event_type,wait_event,count(*) as sessions,
     max(query_age_seconds) filter(where state='active') as oldest_active_seconds,
     max(transaction_age_seconds) as oldest_transaction_seconds
   from activity group by backend_type,state,wait_event_type,wait_event) g),'[]'::jsonb),
 'blocked',coalesce((select jsonb_agg(to_jsonb(b)) from (
   select pid,rpc,state,wait_event_type,wait_event,query_age_seconds,transaction_age_seconds,blockers
   from activity where cardinality(blockers)>0 order by query_age_seconds desc limit 40) b),'[]'::jsonb),
 'financial_lock',coalesce((select jsonb_agg(to_jsonb(l)) from (
   select f.*,a.rpc,a.state,a.query_age_seconds,a.transaction_age_seconds
   from financial_lock f left join activity a using(pid)) l),'[]'::jsonb)
) as pressure_snapshot;
