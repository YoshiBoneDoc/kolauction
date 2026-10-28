-- Run in Supabase SQL Editor. Read-only; does not send, retry, or resolve anything.
-- Returns one JSON value. No account credentials or player-message bodies.
-- Historical checks can narrow the failure path, but cannot recover an error
-- discarded by the worker or reconstruct inventory balances at failure time.
begin transaction read only;

with target as (
    select id, auction_id
    from khub_bot.deliveries
    where reference_number = 1523
), related as (
    select d.*
    from khub_bot.deliveries d
    where d.id in (select id from target)
       or d.auction_id in (select auction_id from target)
), recent_manual as (
    select r.*, d.reference_number, d.kind, d.meat, d.item_id,
           d.quantity, d.recipient_id
    from khub_bot.reconciliations r
    join khub_bot.deliveries d on d.id = r.delivery_id
    where (r.created_at >= now() - interval '7 days'
           or r.delivery_id in (select id from target))
      and (d.meat > 0 or d.item_id is not null)
)
select jsonb_build_object(
    'checked_at', now(),
    'related_deliveries', coalesce((
        select jsonb_agg(jsonb_build_object(
            'reference', 'D-' || d.reference_number,
            'kind', d.kind, 'state', d.state,
            'recipient_id', d.recipient_id,
            'meat', d.meat, 'item_id', d.item_id, 'quantity', d.quantity,
            'created_at', d.created_at, 'sent_at', d.sent_at,
            'evidence', d.evidence
        ) order by d.created_at, d.reference_number)
        from related d where d.meat > 0 or d.item_id is not null
    ), '[]'::jsonb),
    'recent_manual_reconciliations', coalesce((
        select jsonb_agg(jsonb_build_object(
            'reference', 'D-' || r.reference_number,
            'resolution', r.resolution, 'evidence', r.evidence,
            'created_at', r.created_at, 'kind', r.kind,
            'recipient_id', r.recipient_id,
            'meat', r.meat, 'item_id', r.item_id, 'quantity', r.quantity
        ) order by r.created_at) from recent_manual r
    ), '[]'::jsonb),
    'target_wrapping_authorizations', coalesce((
        select jsonb_agg(to_jsonb(w) order by w.created_at)
        from khub_bot.gift_safe_wrapping w
        where w.delivery_id in (select id from target)
    ), '[]'::jsonb),
    'target_mailbox_reviews', coalesce((
        select jsonb_agg(jsonb_build_object(
            'attempt', r.attempt, 'check_status', r.check_status,
            'candidate_ids', r.candidate_ids,
            'created_at', r.created_at, 'checked_at', r.checked_at,
            'resolved_at', r.resolved_at, 'resolution', r.resolution
        ) order by r.created_at)
        from khub_bot.delivery_mailbox_reviews r
        where r.delivery_id in (select id from target)
    ), '[]'::jsonb),
    'current_wrapping_protection', (
        select jsonb_build_object(
            'safe_operating_meat', p.safe_operating_meat,
            'operating_reserve', p.operating_reserve,
            'held_meat', p.held->>'meat', 'updated_at', p.updated_at
        ) from khub_bot.gift_asset_protection p where p.id
    )
) as delivery_diagnostics;

commit;
