-- Read-only. Exact receipt lookups for the donation and the separate C-1061 mail.
-- Run this now; it does NOT require migration 142 and does not move any assets.
select r.mail_id,
    coalesce(r.payload->>'sender_name',r.payload#>>'{raw,fromname}') as sender,
    r.sender_id as kol_player_id,r.result as intake_result,r.payload->>'meat' as received_meat,
    case when c.id is null then 'No closet transfer found' else 'C-'||c.reference_number end as closet_reference,
    c.source,c.state,c.meat as transfer_meat,c.created_at,c.moved_at,
    c.before_state as recorded_before,c.evidence as saved_confirmation_or_error,
    (select string_agg('C-'||u.reference_number,', ') from khub_bot.closet_transfers u
        where c.state='pending' and u.state in ('moving','unknown') and u.item_id is not distinct from c.item_id) as paused_by
from khub_bot.receipts r left join khub_bot.closet_transfers c on c.receipt_id=r.mail_id
where r.mail_id in ('206249968','206248232') order by r.mail_id,c.reference_number;
