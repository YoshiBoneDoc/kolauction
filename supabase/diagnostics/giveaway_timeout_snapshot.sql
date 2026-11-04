-- Run in Supabase SQL Editor and export the single result as JSON or CSV.
-- Read-only: no application RPC execution, EXPLAIN ANALYZE, resets or writes.
-- Capture once now and during any future slowdown. Keep exports private.
select jsonb_build_object(
 'captured_at',clock_timestamp(),
 'database',current_database(),
 'activity',coalesce((select jsonb_agg(jsonb_build_object(
    'pid',pid,'application',application_name,'state',state,
    'wait_type',wait_event_type,'wait_event',wait_event,
    'query_age',clock_timestamp()-query_start,'blocked_by',pg_blocking_pids(pid),
    'query',left(query,3000))) from pg_stat_activity
    where datname=current_database() and pid<>pg_backend_pid() and state<>'idle'),'[]'::jsonb),
 'functions',coalesce((select jsonb_agg(jsonb_build_object(
    'signature',p.oid::regprocedure::text,'settings',p.proconfig,
    'definition',pg_get_functiondef(p.oid)))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','khub_bot') and p.prokind='f'
      and p.proname in ('read_public_home_auctions','read_public_auction_page',
        'read_home_auctions','public_listing_page','visible_auctions',
        'direct_trade_visible','read_auction_card_context','read_auction_bid_history',
        'read_auction_viewer_context','bot_ingest_mail')),'[]'::jsonb),
 'tables',coalesce((select jsonb_agg(jsonb_build_object(
    'schema',schemaname,'table',relname,'estimated_rows',n_live_tup,
    'seq_scans',seq_scan,'seq_rows',seq_tup_read,'index_scans',idx_scan,
    'last_analyze',last_analyze,'last_autoanalyze',last_autoanalyze))
    from pg_stat_user_tables where schemaname in ('public','khub_bot')
    and relname in ('auctions','bids','profiles','receipts','auction_bidder_labels','player_ignores','buy_orders')),'[]'::jsonb),
 'indexes',coalesce((select jsonb_agg(to_jsonb(i)) from pg_indexes i
    where schemaname in ('public','khub_bot') and tablename in
    ('auctions','bids','receipts','auction_bidder_labels','player_ignores','buy_orders')),'[]'::jsonb),
 'statistics_extension', (select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_stat_statements')
) as diagnostic_snapshot;
