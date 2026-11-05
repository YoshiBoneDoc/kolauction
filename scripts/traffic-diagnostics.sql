-- Run manually in Supabase SQL Editor during slow traffic. Read-only snapshots.
-- No credentials, SQL text, query arguments or player messages in the output.
-- Repeat during the incident; cumulative stats do not reconstruct a past outage.
select clock_timestamp() captured_at, state, wait_event_type, wait_event,
 count(*) sessions, max(clock_timestamp()-xact_start) longest_transaction,
 max(clock_timestamp()-query_start) longest_query
from pg_stat_activity where datname=current_database()
group by state,wait_event_type,wait_event;

select clock_timestamp() captured_at, a.pid, a.wait_event_type, a.wait_event,
 clock_timestamp()-a.xact_start transaction_age,
 clock_timestamp()-a.query_start query_age, pg_blocking_pids(a.pid) blocking_pids
from pg_stat_activity a where datname=current_database()
 and (cardinality(pg_blocking_pids(a.pid))>0 or a.state='active') order by a.xact_start;

select clock_timestamp() captured_at, l.pid, l.granted, l.mode,
 a.state, a.wait_event_type, a.wait_event, clock_timestamp()-a.xact_start transaction_age
from pg_locks l join pg_stat_activity a on a.pid=l.pid
where l.locktype='advisory' and l.objid=3888760 order by l.granted desc,a.xact_start;

-- Installed definitions: compare fingerprints with a known release database.
select p.oid::regprocedure signature, md5(pg_get_functiondef(p.oid)) definition_hash
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
 ('read_my_account_access','read_my_raffle_ticket_page','read_public_raffle_commitment',
 'read_auction_page','read_auction_detail_static','read_auction_bid_history');
