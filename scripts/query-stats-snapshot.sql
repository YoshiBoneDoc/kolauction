-- Supabase SQL Editor: run/export ALL of this one JSON cell as CSV or JSON.
-- Read-only; never resets counters, creates tables, or exports SQL/parameters.
with metadata as (
 select now() captured_at, current_database() database_name,
 (select oid::text from pg_database where datname=current_database()) database_id,
 current_setting('server_version') server_version, to_jsonb(i) collection
 from extensions.pg_stat_statements_info i
), statements as (
 select s.*, coalesce(
 substring(s.query from '"public"\."([a-z_][a-z0-9_]*)"[[:space:]]*\('),
 substring(s.query from 'public\.([a-z_][a-z0-9_]*)[[:space:]]*\(')) rpc_name,
 case when s.query ilike '%pg_stat_statements%' then 'instrumentation'
 when s.query ~* '^[[:space:]]*(create|alter|drop|grant|revoke|explain)[[:space:]]' then 'administration'
 when s.query ~* 'pg_available_extensions|pg_proc|pg_namespace|pg_get_functiondef|information_schema' then 'administration'
 when s.query ~* '^[[:space:]]*select[[:space:]]+set_config\(' then 'request_setup' else 'other' end fallback_category
 from extensions.pg_stat_statements s
 where s.dbid=(select oid from pg_database where datname=current_database())
)
select jsonb_build_object('snapshot_version',1,'captured_at',m.captured_at,
 'database_name',m.database_name,'database_id',m.database_id,'server_version',m.server_version,
 'collection',m.collection,'statements',coalesce((select jsonb_agg(jsonb_build_object(
  'query_id',s.queryid::text,'user_id',s.userid::text,'toplevel',s.toplevel,
  'fingerprint',md5(s.query),'rpc',s.rpc_name,
  'category',case when s.fallback_category in ('administration','instrumentation') then s.fallback_category when s.rpc_name is not null then 'application' else s.fallback_category end,
  'calls',s.calls,'total_exec_ms',s.total_exec_time,'total_plan_ms',s.total_plan_time,
  'shared_blks_read',s.shared_blks_read,'shared_blks_hit',s.shared_blks_hit,
  'temp_blks_written',s.temp_blks_written,
  'entry_stats_since',to_jsonb(s)->>'stats_since'
 ) order by s.queryid,s.userid,s.toplevel) from statements s),'[]'::jsonb)) as snapshot
from metadata m;
