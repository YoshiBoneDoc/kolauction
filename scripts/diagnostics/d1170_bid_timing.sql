-- Read-only investigation. Run in Supabase SQL Editor as the database owner.
-- D-1170 / KMail 206062864, as supplied by the player. No mail is sent.
with target as (
    select d.reference_number,d.receipt_id,d.created_at rejected_at,d.sent_at refund_sent_at,d.meat refund_meat,
        r.sender_id,r.received_at,r.created_at recorded_at,r.result,r.payload
    from khub_bot.deliveries d join khub_bot.receipts r on r.mail_id=d.receipt_id
    where d.reference_number=1170
), identified as (
    select t.*,a.id auction_id,a.auction_number,a.item,a.end_time,a.finalized_at,a.instant_purchased_at,a.status,a.final_price
    from target t left join public.auctions a on
        case when (t.payload->'command') ? 'auction_number'
            then t.payload#>>'{command,auction_number}'=a.auction_number::text
            else lower(t.payload#>>'{command,auction_id}')=a.id::text end
)
select jsonb_pretty(jsonb_build_object(
    'reference','D-'||t.reference_number,'kmail_id',t.receipt_id,
    'command',t.payload->'command','meat_submitted',t.payload->'meat',
    'mail_received_at',t.received_at,'receipt_recorded_at',t.recorded_at,
    'rejection_recorded_at',t.rejected_at,'rejection_reason',t.result,
    'refund_meat',t.refund_meat,'refund_sent_at',t.refund_sent_at,
    'auction_number',t.auction_number,'item',t.item,'end_time',t.end_time,
    'finalized_at',t.finalized_at,'instant_purchased_at',t.instant_purchased_at,'status_now',t.status,
    'final_price',t.final_price,
    'mail_received_seconds_before_deadline',extract(epoch from t.end_time-t.received_at),
    'rejection_seconds_after_deadline',extract(epoch from t.rejected_at-t.end_time),
    'accepted_bids',(select coalesce(jsonb_agg(jsonb_build_object('amount',b.amount,'recorded_at',b.created_at)
        order by b.created_at,b.id),'[]'::jsonb) from public.bids b where b.auction_id=t.auction_id)
)) as timing_report from identified t;
