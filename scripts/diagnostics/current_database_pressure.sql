-- Run ONCE in Supabase SQL Editor. Read-only, no objects or settings changed.
-- Small system-catalog snapshot: no application table scans, raw query text,
-- credentials, player messages, or financial data. Export the one result cell.
with sessions as materialized (
    select a.pid,a.usename,a.backend_type,a.state,a.wait_event_type,a.wait_event,
        clock_timestamp()-a.query_start as query_age,
        clock_timestamp()-a.xact_start as transaction_age,
        pg_blocking_pids(a.pid) as blocking_pids,
        substring(a.query from '(?i)(bot_[a-z0-9_]+|read_[a-z0-9_]+|create_bundle_auction|finalize_expired_auctions)') as rpc_hint
    from pg_catalog.pg_stat_activity a
    where a.datname=current_database() and a.pid<>pg_backend_pid()
), settings as (
    select name,setting,unit,source from pg_catalog.pg_settings
    where name in ('max_connections','shared_buffers','work_mem','maintenance_work_mem',
        'max_parallel_workers_per_gather','statement_timeout','lock_timeout',
        'idle_in_transaction_session_timeout','shared_preload_libraries')
), bot_lock as (
    select pid,mode,granted from pg_catalog.pg_locks
    where locktype='advisory' and classid=0 and objid=3888760 and objsubid=1
)
select jsonb_build_object(
    'captured_at',clock_timestamp(),
    'server_started_at',pg_postmaster_start_time(),
    'settings',coalesce((select jsonb_agg(to_jsonb(s) order by name) from settings s),'[]'),
    'connections',coalesce((select jsonb_agg(to_jsonb(c)) from (
        select usename,state,count(*) as connections from sessions group by usename,state order by count(*) desc
    ) c),'[]'),
    'active_or_waiting',coalesce((select jsonb_agg(to_jsonb(s)) from (
        select * from sessions where state is distinct from 'idle' or wait_event_type='Lock'
        order by transaction_age desc nulls last limit 40
    ) s),'[]'),
    'bot_financial_lock',coalesce((select jsonb_agg(to_jsonb(l)) from bot_lock l),'[]'),
    'database_counters',(select jsonb_build_object('stats_reset',stats_reset,'deadlocks',deadlocks,
        'temp_files',temp_files,'temp_bytes',temp_bytes,'blocks_read',blks_read,'blocks_hit',blks_hit)
        from pg_catalog.pg_stat_database where datname=current_database()),
    'api_role_overrides',coalesce((select jsonb_agg(jsonb_build_object('role',r.rolname,'setting',cfg.setting))
        from pg_catalog.pg_db_role_setting d join pg_catalog.pg_roles r on r.oid=d.setrole
        cross join lateral unnest(d.setconfig) cfg(setting)
        where (d.setdatabase=0 or d.setdatabase=(select oid from pg_catalog.pg_database where datname=current_database()))
        and cfg.setting~'^(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|work_mem|pgrst\.db_pool)='),'[]'),
    'recent_feature_functions',coalesce((select jsonb_agg(jsonb_build_object('name',p.proname,'settings',p.proconfig))
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('bot_worker_status','bot_return_gift','bot_preview_gift_return')),'[]')
) as database_pressure;
