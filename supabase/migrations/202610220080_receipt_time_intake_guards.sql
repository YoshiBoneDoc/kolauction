-- Apply after 079. Keep the Oracle worker stopped until the matching worker
-- bundle has been installed. No existing bids, refunds or payouts are changed.
begin;
select pg_advisory_xact_lock(3888760);
do $$
declare definition text;
    cutoff text := '(p_mail->>''received_at'')::timestamptz>=a.end_time';
    cleanup text := 'where completed_at<clock_timestamp()-interval ''7 days''';
begin
    definition:=pg_get_functiondef('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure);
    if strpos(definition,cutoff)=0 then raise exception 'Apply receipt-time migration 079 first.'; end if;
    -- API timestamps have whole-second resolution. The opening second is valid,
    -- while mail stamped in an earlier second cannot bid before item activation.
    execute replace(definition,cutoff,cutoff || ' or (a.item_escrowed_at is not null and '
        ||'(p_mail->>''received_at'')::timestamptz<date_trunc(''second'',a.item_escrowed_at))');
    definition:=pg_get_functiondef('public.bot_finish_inbox_scan(uuid)'::regprocedure);
    if strpos(definition,cleanup)=0 then raise exception 'Unexpected receipt-time scan cleanup.'; end if;
    -- Abandoned scan tokens hold no assets or queued payloads. Pending bid mail
    -- stays in the independent durable queue until processed successfully.
    execute replace(definition,cleanup,'where started_at<clock_timestamp()-interval ''7 days''');
end; $$;
notify pgrst,'reload schema';
commit;
