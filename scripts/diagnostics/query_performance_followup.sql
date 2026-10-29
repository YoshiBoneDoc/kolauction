-- Run once after 24–48 hours of representative traffic. Read-only: no resets,
-- application query execution, schema changes, or raw query text in the output.
-- Supabase normally installs pg_stat_statements in extensions or public. If
-- yours is elsewhere, add its schema to the local search_path below.
begin read only;
set local search_path=pg_catalog,extensions,public;
select queryid::text as query_id,calls,
    round(total_exec_time::numeric,2) as total_exec_ms,
    round(mean_exec_time::numeric,2) as mean_exec_ms,
    round(max_exec_time::numeric,2) as max_exec_ms,
    rows as rows_processed,shared_blks_read as shared_blocks_read,
    shared_blks_hit as shared_blocks_hit,temp_blks_written as temp_blocks_written
from pg_stat_statements
where dbid=(select oid from pg_database where datname=current_database())
order by total_exec_time desc
limit 25;
commit;
