-- Phase 3. Apply once AFTER 116, with the bot gracefully stopped; then update
-- the bot bundle. No receipts, transfers, balances or financial locks are removed.
begin;
select pg_advisory_xact_lock(3888760);

-- Equality on receipt/auction, followed by state checks, is used by cleanup,
-- settlement, failure isolation and reconciliation. Keep the pending queue index.
create index deliveries_receipt_state_idx on khub_bot.deliveries(receipt_id,state) where receipt_id is not null;
create index deliveries_auction_state_idx on khub_bot.deliveries(auction_id,state) where auction_id is not null;
create index inbox_scans_retention_idx on khub_bot.inbox_scans(started_at);
create index inbox_bid_mail_retention_idx on khub_bot.inbox_bid_mail(received_at) where processed;

-- Preserve 080's started_at policy, including abandoned scan tokens. Pending
-- staged mail is independent and is NEVER pruned. A fixed cutoff makes both
-- predicates indexable; keep the existing cadence and global lock unchanged.
do $$
declare definition text;
    scan_delete text := 'delete from khub_bot.inbox_scans where started_at<clock_timestamp()-interval ''7 days'';';
    mail_delete text := 'delete from khub_bot.inbox_bid_mail where processed and received_at<clock_timestamp()-interval ''7 days'';';
begin
    definition:=pg_get_functiondef('khub_bot.scan_before_buy_reservations(uuid)'::regprocedure);
    if strpos(definition,scan_delete)=0 or strpos(definition,mail_delete)=0
        or strpos(definition,'declare scan ')=0 then
        raise exception 'Unexpected scan cleanup definition; review before applying Phase 3.';
    end if;
    definition:=replace(definition,'declare scan ','declare retention_cutoff timestamptz; scan ');
    definition:=replace(definition,scan_delete,
        'retention_cutoff:=clock_timestamp()-interval ''7 days'';'
        ||E'\n    delete from khub_bot.inbox_scans where started_at<retention_cutoff;');
    definition:=replace(definition,mail_delete,
        'delete from khub_bot.inbox_bid_mail where processed and received_at<retention_cutoff;');
    execute definition;
end; $$;

-- Read-only replay classification. A receipt is evidence that intake committed,
-- NOT that its deliveries/refunds have completed. Normal dispatch/recovery and
-- bot_mail_cleanup still decide what to send or delete. Exact payload equality
-- is essential: changed mail must reach the existing authoritative validation.
-- Account jobs and legacy donation reviews keep their existing retry paths.
create function public.bot_handled_mail(p_mails jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
    if jsonb_typeof(p_mails) is distinct from 'array' then
        raise exception 'Invalid replay manifest.';
    end if;
    if jsonb_array_length(p_mails)>10000 then raise exception 'Replay manifest too large.'; end if;
    return coalesce((select jsonb_agg(distinct r.mail_id)
        from jsonb_array_elements(p_mails) m
        join khub_bot.receipts r on r.mail_id=m->>'id' and r.payload=m
        where r.result not in ('processing','account_pending')
          and m#>>'{command,type}' not in ('register','credentials')
          and m#>>'{raw,type}'='normal'
          and (not (m->'raw' ? 'gift_original') or exists(
              select 1 from khub_bot.incoming_gifts g where g.mail_id=r.mail_id and g.payload=m and not g.legacy_donation))
          and not exists(select 1 from khub_bot.inbox_bid_mail b
              where b.mail_id=r.mail_id and (not b.processed or b.payload is distinct from m))
          and not exists(select 1 from khub_bot.account_jobs j where j.mail_id=r.mail_id and j.state='pending')
          and not exists(select 1 from khub_bot.mail_policy_reviews v where v.receipt_id=r.mail_id)
    ),'[]'::jsonb);
end; $$;
revoke all on function public.bot_handled_mail(jsonb) from public,anon,authenticated;
grant execute on function public.bot_handled_mail(jsonb) to service_role;

alter function public.bot_inspect() rename to inspect_before_intake_performance;
alter function public.inspect_before_intake_performance() set schema khub_bot;
revoke all on function khub_bot.inspect_before_intake_performance() from public,anon,authenticated,service_role;
create function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
    select khub_bot.inspect_before_intake_performance()||jsonb_build_object('mailReplayOptimizationVersion',1);
$$;
revoke all on function public.bot_inspect() from public,anon,authenticated;
grant execute on function public.bot_inspect() to service_role;
notify pgrst,'reload schema';
commit;
