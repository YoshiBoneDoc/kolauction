-- Read-only: determine whether the two original Anrath1 test Kmails reached
-- intake and whether instructional replies were queued/sent. Run in Supabase's
-- SQL editor. No raw message bodies, credentials, or mutations are involved.
select test.mail_id,
    r.mail_id is not null as receipt_recorded,
    r.sender_id,
    r.result,
    r.payload->'command' as normalized_command,
    r.payload->>'meat' as normalized_meat,
    r.payload->'items' as normalized_items,
    (select q.processed from khub_bot.inbox_bid_mail q where q.mail_id=test.mail_id) as staged_processed,
    coalesce((select jsonb_agg(jsonb_build_object(
        'reference','D-'||d.reference_number,'state',d.state,'kind',d.kind,
        'meat',d.meat,'sent_at',d.sent_at
    ) order by d.reference_number) from khub_bot.deliveries d where d.receipt_id=test.mail_id),'[]'::jsonb) as outgoing
from (values ('206196610'),('206196596')) as test(mail_id)
left join khub_bot.receipts r on r.mail_id=test.mail_id
order by test.mail_id;
