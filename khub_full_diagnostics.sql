-- kHub full diagnostics: one SELECT statement; one JSONB result cell.
-- Run the entire file ONCE in Supabase SQL Editor. No setup or settings changes.
-- Export the result as CSV/JSON, or copy the complete JSONB cell.
-- For interval comparisons, run separately again after ~60 seconds; keep both.
-- Supported baseline: PostgreSQL 14-18; newer optional views are preflighted.
-- No kHub function execution, mutations, locks acquired explicitly, EXPLAIN,
-- raw statement text, function bodies, credentials, payloads, player identities,
-- client addresses, item contents, or financial amounts are exported.
-- UTC is formatted explicitly; no SET TIME ZONE is needed.
-- SQL-only compatibility mechanism: query_to_xml executes ONLY the fixed SELECT
-- strings below after relation/column/permission/preload checks. XMLTABLE decodes
-- the JSON text without XML entity corruption. No objects are created.
-- Missing/denied/incompatible sections return unavailable plus reasons. Application
-- tables with active RLS are skipped rather than returning misleading partial data.
-- Unexpected runtime failures (e.g. a concurrent DROP, revoked builtin privilege,
-- or a statement timeout) can still abort a SELECT; SQL has no exception handler.
-- Read-only is not zero cost: use live during slowdowns; run full sparingly.
-- Never automatically poll the whole full file. Do not infer financial corrections
-- from backlogs. Historical lock holders, timeout counts and pool queues require
-- retained logs/metrics; these snapshots cannot reconstruct them.

WITH
capture AS MATERIALIZED (
    SELECT clock_timestamp() AS started_at
),
capabilities AS MATERIALIZED (
    SELECT
        (SELECT n.nspname FROM pg_catalog.pg_extension e
         JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
         WHERE e.extname='pg_stat_statements') AS pgss_schema,
        COALESCE((SELECT position('pg_stat_statements' IN setting)>0
                  FROM pg_catalog.pg_settings
                  WHERE name='shared_preload_libraries'),false) AS pgss_preloaded,
        has_function_privilege(
            'pg_catalog.query_to_xml(text,boolean,boolean,text)','EXECUTE'
        ) AS can_collect_xml
),
definitions(section,purpose,scope,row_limit,sql_text,requirements,requires_pgss) AS (
    VALUES
    ('01_environment',
     'Server version, visibility, and optional diagnostics capabilities.',
     'current',
     1,
     $diagnostic$
SELECT current_setting('server_version') AS server_version,
       current_setting('server_version_num')::int AS server_version_num,
       current_user AS effective_role, session_user AS login_role,
       to_char((pg_postmaster_start_time()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS server_started_at_utc,
       pg_has_role(current_user,'pg_read_all_stats','USAGE') AS has_read_all_stats,
       to_regclass('pg_catalog.pg_stat_io') IS NOT NULL AS has_io_view,
       to_regclass('pg_catalog.pg_stat_checkpointer') IS NOT NULL AS has_checkpointer_view,
       (SELECT extversion FROM pg_extension WHERE extname='pg_stat_statements') AS pgss_version
$diagnostic$,
     '[]'::jsonb,
     false),
    ('02_settings',
     'Visible timeout, connection, memory and monitoring settings; SQL Editor settings can differ from API settings.',
     'configuration',
     40,
     $diagnostic$
SELECT name,setting,unit,source FROM pg_catalog.pg_settings
WHERE name IN ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout',
'idle_session_timeout','transaction_timeout','max_connections','superuser_reserved_connections',
'reserved_connections','shared_buffers','work_mem','maintenance_work_mem','effective_cache_size',
'max_parallel_workers','max_parallel_workers_per_gather','track_activities','track_counts',
'track_functions','track_io_timing','compute_query_id','track_activity_query_size',
'pg_stat_statements.track','pg_stat_statements.track_planning','pg_stat_statements.max')
ORDER BY name
$diagnostic$,
     '[]'::jsonb,
     false),
    ('03_api_overrides',
     'Database/role timeout and exposed PostgREST pool overrides; external pool settings are not necessarily visible here.',
     'configuration',
     100,
     $diagnostic$
SELECT COALESCE(d.datname,'(all databases)') AS database_scope,
       COALESCE(r.rolname,'(all roles)') AS role_scope,cfg.setting
FROM pg_catalog.pg_db_role_setting s
LEFT JOIN pg_catalog.pg_database d ON d.oid=s.setdatabase
LEFT JOIN pg_catalog.pg_roles r ON r.oid=s.setrole
CROSS JOIN LATERAL unnest(s.setconfig) cfg(setting)
WHERE (s.setdatabase=0 OR d.datname=current_database())
AND cfg.setting ~ '^(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|idle_session_timeout|transaction_timeout|pgrst\.db_pool|pgrst\.db_pool_acquisition_timeout|pgrst\.db_pool_max_lifetime)='
ORDER BY database_scope,role_scope,cfg.setting
$diagnostic$,
     '[]'::jsonb,
     false),
    ('04_active_sessions',
     'Current work and waits; statement age is not lock wait duration. Raw SQL, arguments, application names and client addresses are excluded.',
     'current',
     150,
     $diagnostic$
SELECT pid,usename,md5(application_name) AS application_fingerprint,backend_type,state,
       wait_event_type,wait_event,
       clock_timestamp()-query_start AS statement_age,
       clock_timestamp()-xact_start AS transaction_age,
       pg_blocking_pids(pid) AS blocking_pids,
       to_jsonb(a)->>'query_id' AS query_id,
       substring(query FROM '(?i)(finalize_expired_auctions|bot_[a-z0-9_]+|read_[a-z0-9_]+|reserve_buy_quantity|cancel_buy_reservation|place_bid|purchase_auction|cancel_auction)') AS rpc_hint,
       md5(query) AS statement_fingerprint
FROM pg_catalog.pg_stat_activity a
WHERE datname=current_database() AND pid<>pg_backend_pid()
AND (state IS DISTINCT FROM 'idle' OR wait_event_type='Lock')
ORDER BY xact_start NULLS LAST,query_start
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_activity", "columns": ["pid", "datname", "usename", "application_name", "backend_type", "state", "wait_event_type", "wait_event", "query_start", "xact_start", "query", "backend_xmin", "backend_xid", "state_change"]}]'::jsonb,
     false),
    ('05_blocking_edges',
     'Each row is a waiting PID to reported blocker; follow blockers_of_blocker for chains. PID zero may indicate a prepared transaction.',
     'current',
     150,
     $diagnostic$
SELECT w.pid AS waiting_pid,w.usename AS waiting_role,
       w.wait_event_type,w.wait_event,
       clock_timestamp()-w.query_start AS waiting_statement_age,
       blocker.pid AS reported_blocker_pid,b.usename AS blocking_role,
       b.state AS blocking_state,clock_timestamp()-b.xact_start AS blocking_transaction_age,
       b.wait_event_type AS blocker_wait_type,b.wait_event AS blocker_wait_event,
       CASE WHEN b.pid IS NOT NULL THEN pg_blocking_pids(b.pid) END AS blockers_of_blocker,
       to_jsonb(w)->>'query_id' AS waiting_query_id,
       to_jsonb(b)->>'query_id' AS blocking_query_id
FROM pg_catalog.pg_stat_activity w
CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) blocker(pid)
LEFT JOIN pg_catalog.pg_stat_activity b ON b.pid=blocker.pid
WHERE w.datname=current_database() AND w.pid<>pg_backend_pid()
ORDER BY b.xact_start NULLS LAST,w.query_start
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_activity", "columns": ["pid", "datname", "usename", "application_name", "backend_type", "state", "wait_event_type", "wait_event", "query_start", "xact_start", "query", "backend_xmin", "backend_xid", "state_change"]}]'::jsonb,
     false),
    ('06_advisory_locks',
     'Granted and waiting advisory locks. Key 3888760 is the shared financial lock. Lock wait start is optional; transaction age is not holding duration.',
     'current',
     150,
     $diagnostic$
SELECT l.pid,l.classid,l.objid,l.objsubid,l.mode,l.granted,
       (l.classid=0 AND l.objid=3888760 AND l.objsubid=1) AS is_khub_financial_lock,
       to_char((NULLIF(to_jsonb(l)->>'waitstart','')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS wait_started_at_utc,
       CASE WHEN NOT l.granted THEN clock_timestamp()-NULLIF(to_jsonb(l)->>'waitstart','')::timestamptz END AS lock_wait_age,
       a.usename,a.state,a.wait_event_type,a.wait_event,
       clock_timestamp()-a.xact_start AS transaction_age,
       to_jsonb(a)->>'query_id' AS query_id,
       CASE WHEN a.pid IS NOT NULL THEN pg_blocking_pids(a.pid) END AS blocking_pids
FROM pg_catalog.pg_locks l LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid=l.pid
WHERE l.locktype='advisory'
AND l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
ORDER BY is_khub_financial_lock DESC,l.granted DESC,l.pid
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_activity", "columns": ["pid", "datname", "usename", "application_name", "backend_type", "state", "wait_event_type", "wait_event", "query_start", "xact_start", "query", "backend_xmin", "backend_xid", "state_change"]}, {"schema": "pg_catalog", "relation": "pg_locks", "columns": ["pid", "database", "locktype", "classid", "objid", "objsubid", "mode", "granted", "relation", "transactionid", "virtualxid"]}]'::jsonb,
     false),
    ('07_other_lock_waits',
     'Non-advisory waits, including transaction-ID waits commonly associated with row contention.',
     'current',
     150,
     $diagnostic$
SELECT l.pid,l.locktype,l.mode,l.relation::regclass::text AS relation_name,
       l.transactionid::text,l.virtualxid,
       to_char((NULLIF(to_jsonb(l)->>'waitstart','')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS wait_started_at_utc,
       clock_timestamp()-NULLIF(to_jsonb(l)->>'waitstart','')::timestamptz AS lock_wait_age,
       a.usename,a.state,a.wait_event_type,a.wait_event,pg_blocking_pids(l.pid) AS blocking_pids
FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid=l.pid
WHERE NOT l.granted AND l.locktype<>'advisory'
AND a.datname=current_database() AND a.pid<>pg_backend_pid()
ORDER BY NULLIF(to_jsonb(l)->>'waitstart','')::timestamptz NULLS LAST
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_activity", "columns": ["pid", "datname", "usename", "application_name", "backend_type", "state", "wait_event_type", "wait_event", "query_start", "xact_start", "query", "backend_xmin", "backend_xid", "state_change"]}, {"schema": "pg_catalog", "relation": "pg_locks", "columns": ["pid", "database", "locktype", "classid", "objid", "objsubid", "mode", "granted", "relation", "transactionid", "virtualxid"]}]'::jsonb,
     false),
    ('08_connection_capacity',
     'Cluster-wide backend counts and approximate ordinary connection headroom; not external pool or HTTP queue occupancy.',
     'current',
     1,
     $diagnostic$
WITH limits AS (
 SELECT max(setting::int) FILTER (WHERE name='max_connections') AS maximum,
        max(setting::int) FILTER (WHERE name='superuser_reserved_connections') AS superuser_reserved,
        COALESCE(max(setting::int) FILTER (WHERE name='reserved_connections'),0) AS role_reserved
 FROM pg_catalog.pg_settings WHERE name IN ('max_connections','superuser_reserved_connections','reserved_connections')
), sessions AS (
 SELECT count(*) FILTER (WHERE backend_type='client backend') AS client_backends,
 count(*) FILTER (WHERE backend_type='client backend' AND state='active') AS active_client_backends,
 count(*) FILTER (WHERE backend_type='client backend' AND state LIKE 'idle in transaction%') AS idle_in_transaction
 FROM pg_catalog.pg_stat_activity
)
SELECT limits.*,sessions.*,maximum-superuser_reserved-role_reserved-client_backends AS approximate_ordinary_headroom
FROM limits CROSS JOIN sessions
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_activity", "columns": ["pid", "datname", "usename", "application_name", "backend_type", "state", "wait_event_type", "wait_event", "query_start", "xact_start", "query", "backend_xmin", "backend_xid", "state_change"]}]'::jsonb,
     false),
    ('09_connections_by_group',
     'Counts by database, role, application fingerprint and wait; idle pooled connections alone are not evidence of saturation.',
     'current',
     150,
     $diagnostic$
SELECT a.datname,a.usename,md5(a.application_name) AS application_fingerprint,
       a.backend_type,a.state,a.wait_event_type,a.wait_event,r.rolconnlimit,
       count(*) AS sessions,max(clock_timestamp()-a.xact_start) AS oldest_transaction_age
FROM pg_catalog.pg_stat_activity a LEFT JOIN pg_catalog.pg_roles r ON r.rolname=a.usename
GROUP BY a.datname,a.usename,a.application_name,a.backend_type,a.state,a.wait_event_type,a.wait_event,r.rolconnlimit
ORDER BY sessions DESC
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_activity", "columns": ["pid", "datname", "usename", "application_name", "backend_type", "state", "wait_event_type", "wait_event", "query_start", "xact_start", "query", "backend_xmin", "backend_xid", "state_change"]}]'::jsonb,
     false),
    ('10_long_transactions',
     'Transactions older than 30 seconds; old idle transactions can retain locks and snapshots.',
     'current',
     100,
     $diagnostic$
SELECT pid,usename,state,clock_timestamp()-xact_start AS transaction_age,
       clock_timestamp()-state_change AS time_in_current_state,wait_event_type,wait_event,
       backend_xid::text,backend_xmin::text,age(backend_xmin) AS xmin_age_in_transactions,
       pg_blocking_pids(pid) AS blocking_pids,to_jsonb(a)->>'query_id' AS query_id,
       to_char((xact_start) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS transaction_started_at_utc
FROM pg_catalog.pg_stat_activity a
WHERE datname=current_database() AND pid<>pg_backend_pid()
AND xact_start<clock_timestamp()-interval '30 seconds'
ORDER BY xact_start
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_activity", "columns": ["pid", "datname", "usename", "application_name", "backend_type", "state", "wait_event_type", "wait_event", "query_start", "xact_start", "query", "backend_xmin", "backend_xid", "state_change"]}]'::jsonb,
     false),
    ('11_database_statistics',
     'Cumulative counters; repeat exports for deltas. Rollbacks are not a count of 57014 errors.',
     'cumulative',
     1,
     $diagnostic$
SELECT datname,numbackends,xact_commit,xact_rollback,deadlocks,conflicts,
       blks_read,blks_hit,blk_read_time,blk_write_time,temp_files,temp_bytes,
       to_char((stats_reset) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stats_reset_utc
FROM pg_catalog.pg_stat_database WHERE datname=current_database()
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_database", "columns": ["datname", "numbackends", "xact_commit", "xact_rollback", "deadlocks", "conflicts", "blks_read", "blks_hit", "blk_read_time", "blk_write_time", "temp_files", "temp_bytes", "stats_reset"]}]'::jsonb,
     false),
    ('12_statement_statistics_info',
     'Reset and eviction metadata; missing extension or preload is reported without querying the view.',
     'cumulative',
     1,
     $diagnostic$
SELECT to_jsonb(s)-'stats_reset' AS counters,
       to_char((NULLIF(to_jsonb(s)->>'stats_reset','')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stats_reset_utc
FROM __PGSS_INFO__ s
$diagnostic$,
     '[{"schema": "@pgss", "relation": "pg_stat_statements_info", "columns": []}]'::jsonb,
     true),
    ('13_statement_performance',
     'One scan of pg_stat_statements: top mean, max, cumulative time and frequency, plus up to 200 kHub RPC statements. Query text is never exported; rankings are labeled.',
     'cumulative',
     360,
     $diagnostic$
WITH source AS MATERIALIZED (
 SELECT s.userid,s.dbid,s.queryid::text AS queryid,to_jsonb(s)->>'toplevel' AS top_level,
        substring(s.query FROM '(?i)(finalize_expired_auctions|bot_[a-z0-9_]+|read_[a-z0-9_]+|reserve_buy_quantity|cancel_buy_reservation|place_bid|purchase_auction|cancel_auction)') AS rpc_hint,
        md5(s.query) AS normalized_statement_fingerprint,
        s.calls,s.total_exec_time,s.mean_exec_time,s.max_exec_time,s.stddev_exec_time,
        s.rows,s.shared_blks_hit,s.shared_blks_read,s.temp_blks_read,s.temp_blks_written
 FROM __PGSS__ s
 WHERE s.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
 AND s.calls>0 AND COALESCE(s.query,'') !~* '(pg_stat_statements|pg_stat_activity|pg_proc)'
), ranked AS (
 SELECT source.*,
 row_number() OVER (ORDER BY mean_exec_time DESC,queryid,userid,top_level) AS mean_rank,
 row_number() OVER (ORDER BY max_exec_time DESC,queryid,userid,top_level) AS max_rank,
 row_number() OVER (ORDER BY total_exec_time DESC,queryid,userid,top_level) AS total_rank,
 row_number() OVER (ORDER BY calls DESC,queryid,userid,top_level) AS calls_rank,
 CASE WHEN rpc_hint IS NOT NULL THEN row_number() OVER (PARTITION BY (rpc_hint IS NOT NULL) ORDER BY calls DESC,queryid,userid,top_level) END AS rpc_calls_rank
 FROM source
)
SELECT * FROM ranked
WHERE mean_rank<=40 OR max_rank<=40 OR total_rank<=40 OR calls_rank<=40 OR rpc_calls_rank<=200
ORDER BY total_exec_time DESC,queryid,userid,top_level
$diagnostic$,
     '[{"schema": "@pgss", "relation": "pg_stat_statements", "columns": ["userid", "dbid", "queryid", "query", "calls", "total_exec_time", "mean_exec_time", "max_exec_time", "stddev_exec_time", "rows", "shared_blks_hit", "shared_blks_read", "temp_blks_read", "temp_blks_written"]}]'::jsonb,
     true),
    ('14_function_statistics',
     'Already-collected function calls and timings. Empty can mean tracking disabled or SQL inlining; total times overlap nested calls.',
     'cumulative',
     150,
     $diagnostic$
SELECT s.schemaname,s.funcname,pg_get_function_identity_arguments(s.funcid) AS arguments,
       s.calls,s.total_time,s.self_time,s.total_time/NULLIF(s.calls,0) AS mean_total_ms
FROM pg_catalog.pg_stat_user_functions s
WHERE s.schemaname IN ('public','khub_bot') ORDER BY s.total_time DESC
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_user_functions", "columns": ["schemaname", "funcname", "funcid", "calls", "total_time", "self_time"]}]'::jsonb,
     false),
    ('15_table_sizes_and_scans',
     'Metadata estimates, scan counters and maintenance dates; sequential scans on small tables may be appropriate.',
     'cumulative',
     200,
     $diagnostic$
SELECT s.schemaname,s.relname,
       (SELECT pg_database_size(current_database())) AS database_size_bytes,
       pg_relation_size(s.relid) AS heap_bytes,pg_indexes_size(s.relid) AS index_bytes,
       pg_total_relation_size(s.relid) AS total_bytes_including_toast,
       s.n_live_tup AS estimated_live_rows,s.n_dead_tup AS estimated_dead_rows,
       s.seq_scan,s.seq_tup_read,s.idx_scan,s.n_mod_since_analyze,
       to_char((s.last_analyze) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_analyze_utc,
       to_char((s.last_autoanalyze) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_autoanalyze_utc,
       to_char((s.last_vacuum) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_vacuum_utc,
       to_char((s.last_autovacuum) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_autovacuum_utc
FROM pg_catalog.pg_stat_user_tables s
WHERE s.schemaname IN ('public','khub_bot')
ORDER BY pg_total_relation_size(s.relid) DESC,s.relid
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_user_tables", "columns": ["schemaname", "relname", "relid", "n_live_tup", "n_dead_tup", "seq_scan", "seq_tup_read", "idx_scan", "n_mod_since_analyze", "last_analyze", "last_autoanalyze", "last_vacuum", "last_autovacuum"]}]'::jsonb,
     false),
    ('16_index_inventory_and_usage',
     'Deployed key/include columns, validity, sizes and counters. Expression/predicate SQL is excluded to avoid exporting literals.',
     'cumulative',
     400,
     $diagnostic$
SELECT s.schemaname,s.relname AS table_name,s.indexrelname AS index_name,
       am.amname AS access_method,i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique_index,
       (i.indpred IS NOT NULL) AS partial_index,md5(pg_get_expr(i.indpred,i.indrelid)) AS predicate_fingerprint,
       (SELECT jsonb_agg(jsonb_build_object('position',k.position,'column',COALESCE(a.attname,'(expression)'),
        'included',k.position>i.indnkeyatts) ORDER BY k.position)
        FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum) AS columns,
       pg_relation_size(s.indexrelid) AS index_bytes,s.idx_scan,s.idx_tup_read,s.idx_tup_fetch
FROM pg_catalog.pg_stat_user_indexes s
JOIN pg_catalog.pg_index i ON i.indexrelid=s.indexrelid
JOIN pg_catalog.pg_class c ON c.oid=s.indexrelid
JOIN pg_catalog.pg_am am ON am.oid=c.relam
WHERE s.schemaname IN ('public','khub_bot')
ORDER BY s.schemaname,s.relname,s.indexrelname
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_user_indexes", "columns": ["schemaname", "relname", "indexrelname", "indexrelid", "idx_scan", "idx_tup_read", "idx_tup_fetch"]}, {"schema": "pg_catalog", "relation": "pg_index", "columns": ["indnkeyatts"]}]'::jsonb,
     false),
    ('17_foreign_key_index_candidates',
     'Single-column foreign keys lacking a valid nonpartial leading-column index. Heuristic only; not an index recommendation.',
     'configuration',
     200,
     $diagnostic$
SELECT n.nspname AS schema_name,t.relname AS table_name,c.conname AS foreign_key,
       a.attname AS referencing_column,c.confrelid::regclass::text AS referenced_table
FROM pg_catalog.pg_constraint c
JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
WHERE c.contype='f' AND n.nspname IN ('public','khub_bot') AND cardinality(c.conkey)=1
AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid=c.conrelid
 AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indkey[0]=c.conkey[1])
ORDER BY schema_name,table_name,referencing_column
$diagnostic$,
     '[]'::jsonb,
     false),
    ('18_financial_function_inventory',
     'Definitions are not executed or exported. Direct lock flags miss indirect acquisition through wrappers; fingerprints help identify deployed versions.',
     'configuration',
     300,
     $diagnostic$
SELECT n.nspname AS schema_name,p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS arguments,l.lanname AS language,
       p.prosecdef AS security_definer,p.provolatile AS volatility,
       ARRAY(SELECT v FROM unnest(p.proconfig) v
             WHERE v ~ '^(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout)=') AS timeout_overrides,
       p.prosrc ~ 'pg_advisory_xact_lock' AS directly_mentions_advisory_lock,
       p.prosrc ~ '3888760' AS directly_mentions_khub_key,
       p.prosrc ~ 'khub_bot[.]|public[.]' AS references_schema_qualified_helpers,
       md5(p.prosrc) AS source_fingerprint
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
JOIN pg_catalog.pg_language l ON l.oid=p.prolang
WHERE p.prokind='f' AND n.nspname IN ('public','khub_bot')
AND p.proname ~* '(finalize|ingest|tick|inspect|delivery|finish_listing|finish_buy_order|maintain_buy_orders|liabilit|refund|reserve_buy|cancel_buy|expire_buy|queue)'
ORDER BY schema_name,function_name,arguments
$diagnostic$,
     '[]'::jsonb,
     false),
    ('19_financial_triggers',
     'Trigger-to-function relationships on auction and financial tables; trigger bodies and arguments are excluded.',
     'configuration',
     200,
     $diagnostic$
SELECT n.nspname AS schema_name,c.relname AS table_name,t.tgname AS trigger_name,
       t.tgenabled AS enabled,pn.nspname AS function_schema,p.proname AS function_name,
       md5(p.prosrc) AS function_source_fingerprint
FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
WHERE NOT t.tgisinternal AND n.nspname IN ('public','khub_bot')
ORDER BY schema_name,table_name,trigger_name
$diagnostic$,
     '[]'::jsonb,
     false),
    ('20_delivery_backlog',
     'Application-table aggregate: record age is since creation, not time in current state. Unknown/sending records are not resend instructions.',
     'current',
     100,
     $diagnostic$
SELECT state,kind,count(*) AS delivery_count,
       to_char((min(created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS oldest_created_at_utc,
       to_char((max(created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS newest_created_at_utc,
       clock_timestamp()-min(created_at) AS oldest_record_age
FROM khub_bot.deliveries GROUP BY state,kind ORDER BY state,kind
$diagnostic$,
     '[{"schema": "khub_bot", "relation": "deliveries", "columns": ["state", "kind", "created_at"]}]'::jsonb,
     false),
    ('21_settlement_backlog',
     'Settling auctions and delivery states; receipt gates, batching and holds may explain outstanding work. No player IDs, messages or amounts are returned.',
     'current',
     100,
     $diagnostic$
SELECT a.auction_number,a.auction_kind,a.status,a.settlement_outcome,
       to_char((a.finalized_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finalized_at_utc,
       clock_timestamp()-a.finalized_at AS age_since_finalization,
       count(d.id) AS delivery_records,
       count(d.id) FILTER (WHERE d.state='pending') AS pending,
       count(d.id) FILTER (WHERE d.state='sending') AS sending,
       count(d.id) FILTER (WHERE d.state='unknown') AS unknown,
       count(d.id) FILTER (WHERE d.state='sent') AS sent
FROM public.auctions a LEFT JOIN khub_bot.deliveries d ON d.auction_id=a.id
WHERE a.status='settling'
GROUP BY a.id,a.auction_number,a.auction_kind,a.status,a.settlement_outcome,a.finalized_at
ORDER BY a.finalized_at NULLS LAST,a.auction_number
$diagnostic$,
     '[{"schema": "public", "relation": "auctions", "columns": ["id", "auction_number", "auction_kind", "status", "settlement_outcome", "finalized_at"]}, {"schema": "khub_bot", "relation": "deliveries", "columns": ["id", "auction_id", "state"]}]'::jsonb,
     false),
    ('22_buy_order_maintenance',
     'Counts of orders, refund finalization, and remaining-balance presence; no individual or aggregate balances are exported.',
     'current',
     100,
     $diagnostic$
SELECT a.status,o.refund_finalized,o.close_reason,count(*) AS order_count,
       count(*) FILTER (WHERE o.balance_meat>0) AS orders_with_remaining_balance,
       to_char((min(a.end_time)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS earliest_auction_end_utc
FROM khub_bot.buy_orders o JOIN public.auctions a ON a.id=o.auction_id
GROUP BY a.status,o.refund_finalized,o.close_reason ORDER BY a.status,o.refund_finalized,o.close_reason
$diagnostic$,
     '[{"schema": "public", "relation": "auctions", "columns": ["id", "status", "end_time"]}, {"schema": "khub_bot", "relation": "buy_orders", "columns": ["auction_id", "refund_finalized", "close_reason", "balance_meat"]}]'::jsonb,
     false),
    ('23_reservation_backlog',
     'Active reservations past their deadline; a short maintenance-cycle delay can be normal.',
     'current',
     20,
     $diagnostic$
SELECT state,count(*) AS reservation_count,
       count(*) FILTER (WHERE state='active' AND expires_at<=clock_timestamp()) AS active_past_expiration,
       to_char((min(expires_at) FILTER (WHERE state='active')) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS earliest_active_expiration_utc
FROM khub_bot.buy_reservations GROUP BY state ORDER BY state
$diagnostic$,
     '[{"schema": "khub_bot", "relation": "buy_reservations", "columns": ["state", "expires_at"]}]'::jsonb,
     false),
    ('24_inbox_backlog',
     'Staged mail counts only. Receipt time is not staging time; payloads and mail/player IDs are excluded.',
     'current',
     10,
     $diagnostic$
SELECT processed,count(*) AS staged_messages,
       to_char((min(received_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS earliest_receipt_time_utc,
       to_char((max(received_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS latest_receipt_time_utc
FROM khub_bot.inbox_bid_mail GROUP BY processed ORDER BY processed
$diagnostic$,
     '[{"schema": "khub_bot", "relation": "inbox_bid_mail", "columns": ["processed", "received_at"]}]'::jsonb,
     false),
    ('25_recent_inbox_scans',
     'Recent scan timings include bot and external KoL work, not only SQL execution. Interrupted old scans are not proof of ongoing blockage.',
     'recent_records',
     50,
     $diagnostic$
SELECT to_char((started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at_utc,to_char((staged_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS staged_at_utc,
       to_char((completed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at_utc,
       CASE WHEN completed_at IS NOT NULL THEN completed_at-started_at END AS completed_scan_duration,
       CASE WHEN completed_at IS NULL THEN clock_timestamp()-started_at END AS unfinished_scan_age
FROM khub_bot.inbox_scans ORDER BY started_at DESC
$diagnostic$,
     '[{"schema": "khub_bot", "relation": "inbox_scans", "columns": ["started_at", "staged_at", "completed_at"]}]'::jsonb,
     false),
    ('26_closet_transfer_backlog',
     'Transfer state counts only; no items, amounts, evidence or player data.',
     'current',
     20,
     $diagnostic$
SELECT state,count(*) AS transfer_count,to_char((min(created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS oldest_created_at_utc
FROM khub_bot.closet_transfers GROUP BY state ORDER BY state
$diagnostic$,
     '[{"schema": "khub_bot", "relation": "closet_transfers", "columns": ["state", "created_at"]}]'::jsonb,
     false),
    ('27_vacuum_progress',
     'Current vacuum activity; presence alone does not establish causation.',
     'current',
     100,
     $diagnostic$
SELECT pid,datname,relid::regclass::text AS relation_name,phase,
       heap_blks_total,heap_blks_scanned,heap_blks_vacuumed
FROM pg_catalog.pg_stat_progress_vacuum WHERE datname=current_database() ORDER BY pid
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_progress_vacuum", "columns": ["pid", "datname", "relid", "phase", "heap_blks_total", "heap_blks_scanned", "heap_blks_vacuumed"]}]'::jsonb,
     false),
    ('28_io_statistics',
     'PostgreSQL 16+ cumulative instance I/O counters; not CPU, RAM or provisioned IOPS metrics.',
     'cumulative',
     100,
     $diagnostic$
SELECT to_jsonb(s)-'stats_reset' AS counters,
       to_char((NULLIF(to_jsonb(s)->>'stats_reset','')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stats_reset_utc
FROM pg_catalog.pg_stat_io s
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_io", "columns": []}]'::jsonb,
     false),
    ('29_background_writer',
     'Cumulative background-writer counters; older PostgreSQL also includes checkpoint statistics here.',
     'cumulative',
     100,
     $diagnostic$
SELECT to_jsonb(s)-'stats_reset' AS counters,
       to_char((NULLIF(to_jsonb(s)->>'stats_reset','')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stats_reset_utc
FROM pg_catalog.pg_stat_bgwriter s
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_bgwriter", "columns": []}]'::jsonb,
     false),
    ('30_checkpointer',
     'PostgreSQL 17+ cumulative checkpoint counters; unavailable on older versions is normal.',
     'cumulative',
     100,
     $diagnostic$
SELECT to_jsonb(s)-'stats_reset' AS counters,
       to_char((NULLIF(to_jsonb(s)->>'stats_reset','')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stats_reset_utc
FROM pg_catalog.pg_stat_checkpointer s
$diagnostic$,
     '[{"schema": "pg_catalog", "relation": "pg_stat_checkpointer", "columns": []}]'::jsonb,
     false)
),
preflight AS MATERIALIZED (
    SELECT d.*,c.pgss_schema,c.can_collect_xml,
           COALESCE((
               SELECT jsonb_agg(issue ORDER BY object_name)
               FROM (
                   SELECT format('%I.%I',r.schema_name,r.relation_name) AS object_name,
                          CASE
                            WHEN r.relation_oid IS NULL THEN
                                'missing relation: '||format('%I.%I',r.schema_name,r.relation_name)
                            WHEN NOT has_schema_privilege(cl.relnamespace,'USAGE')
                              OR NOT has_table_privilege(r.relation_oid,'SELECT') THEN
                                'SELECT/schema permission unavailable: '||format('%I.%I',r.schema_name,r.relation_name)
                            WHEN EXISTS (
                                SELECT 1 FROM jsonb_array_elements_text(r.columns_needed) need(column_name)
                                WHERE NOT EXISTS (
                                    SELECT 1 FROM pg_catalog.pg_attribute a
                                    WHERE a.attrelid=r.relation_oid AND a.attname=need.column_name
                                      AND a.attnum>0 AND NOT a.attisdropped
                                )
                            ) THEN 'required columns unavailable: '||format('%I.%I',r.schema_name,r.relation_name)
                            WHEN r.schema_name IN ('public','khub_bot')
                                 AND row_security_active(r.relation_oid) THEN
                                'active RLS may hide application rows: '||format('%I.%I',r.schema_name,r.relation_name)
                          END AS issue
                   FROM (
                       SELECT resolved.*,
                              (SELECT obj.oid FROM pg_catalog.pg_class obj
                               JOIN pg_catalog.pg_namespace ns ON ns.oid=obj.relnamespace
                               WHERE ns.nspname=resolved.schema_name
                                 AND obj.relname=resolved.relation_name) AS relation_oid
                       FROM (
                           SELECT CASE WHEN spec->>'schema'='@pgss'
                                       THEN COALESCE(c.pgss_schema,'__unavailable_extension__')
                                       ELSE spec->>'schema' END AS schema_name,
                                  spec->>'relation' AS relation_name,
                                  spec->'columns' AS columns_needed
                           FROM jsonb_array_elements(d.requirements) spec
                       ) resolved
                   ) r
                   LEFT JOIN pg_catalog.pg_class cl ON cl.oid=r.relation_oid
               ) checks
               WHERE issue IS NOT NULL
           ),'[]'::jsonb)
           || CASE WHEN d.requires_pgss AND NOT c.pgss_preloaded
                   THEN jsonb_build_array('pg_stat_statements is not visibly preloaded')
                   ELSE '[]'::jsonb END
           || CASE WHEN NOT c.can_collect_xml
                   THEN jsonb_build_array('query_to_xml EXECUTE permission unavailable')
                   ELSE '[]'::jsonb END AS unavailable_reasons
    FROM definitions d CROSS JOIN capabilities c CROSS JOIN capture
),
collected AS MATERIALIZED (
    SELECT p.*,
           CASE WHEN jsonb_array_length(unavailable_reasons)=0 THEN (
               SELECT x.payload::jsonb
               FROM XMLTABLE(
                   '/table/row'
                   PASSING pg_catalog.query_to_xml(
                       format(
                           'SELECT jsonb_build_object(''rows'',COALESCE(jsonb_agg(numbered.row_data ORDER BY numbered.ordinal) FILTER (WHERE numbered.ordinal<=%s),''[]''::jsonb),''truncated'',count(*)>%s)::text AS payload FROM (SELECT to_jsonb(d) AS row_data,row_number() OVER () AS ordinal FROM (%s LIMIT %s) d) numbered',
                           row_limit,row_limit,
                           replace(replace(sql_text,
                               '__PGSS_INFO__',format('%I.pg_stat_statements_info',COALESCE(pgss_schema,'__unavailable_extension__'))),
                               '__PGSS__',format('%I.pg_stat_statements',COALESCE(pgss_schema,'__unavailable_extension__'))),
                           row_limit+1
                       ),true,false,''
                   )
                   COLUMNS payload text PATH 'payload'
               ) x
           ) END AS data
    FROM preflight p
),
section_report AS MATERIALIZED (
    SELECT jsonb_object_agg(section,jsonb_build_object(
            'purpose',purpose,
            'scope',scope,
            'status',CASE WHEN jsonb_array_length(unavailable_reasons)>0
                          THEN 'unavailable' ELSE 'available' END,
            'unavailable_reasons',unavailable_reasons,
            'row_limit',row_limit,
            'returned_rows',CASE WHEN data IS NOT NULL THEN jsonb_array_length(data->'rows') END,
            'truncated',data->'truncated',
            'data',data->'rows'
        ) ORDER BY section) AS sections
    FROM collected
)
SELECT jsonb_build_object(
    'report','khub_full_diagnostics',
    'format_version',1,
    'collection_started_at_utc',to_char((capture.started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'collection_finished_at_utc',to_char((clock_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'financial_advisory_lock_key',3888760,
    'notes',jsonb_build_array(
        'Current views are transient; no lock or wait history is reconstructed.',
        'Cumulative counters are not incident-time measurements; compare separate exports and reset metadata.',
        'Statement execution statistics can omit failed/time-out executions; absent rows do not clear an RPC.',
        'Restricted activity visibility can hide details even when a section is available.',
        'External pool queues, HTTP 5xx counts, Cloudflare metrics, CPU/RAM and disk capacity require logs/metrics.',
        'Fingerprints replace raw SQL and function bodies; nested function times can overlap.',
        'Sections span the collection window, not an atomic snapshot; truncation is labeled per section.',
        'No fixes or financial actions should be inferred from this report alone.'
    ),
    'sections',section_report.sections
) AS khub_full_diagnostics
FROM capture CROSS JOIN section_report;
