-- kHub live diagnostics: one SELECT statement; one JSONB result cell.
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
    'report','khub_live_diagnostics',
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
) AS khub_live_diagnostics
FROM capture CROSS JOIN section_report;
