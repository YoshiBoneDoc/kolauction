-- After 253. Permit settled raffle source mail without an individual reply.
-- All existing settlement, delivery, review and intake guards remain mandatory.
begin;
set local lock_timeout='2s';
create or replace function khub_bot.cleanup_obligations_complete(mid text, policy boolean default false)
returns boolean language sql stable set search_path='' as $$
 select (exists(select 1 from khub_bot.deliveries d where d.receipt_id=mid)
 or exists(select 1 from khub_bot.receipts r where r.mail_id=mid and (
   r.result='raffle_tickets' and exists(select 1 from khub_bot.raffle_purchases p where p.receipt_id=mid and khub_bot.cleanup_raffle_complete(p.raffle_id))
   or r.result='raffle_supply' and exists(select 1 from khub_bot.raffle_deposits p where p.receipt_id=mid and khub_bot.cleanup_raffle_complete(p.raffle_id))
 )))
 and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=mid and not (
   coalesce(khub_bot.buy_batch_delivery_sent(d.id),false)
   or policy and d.state='cancelled' and d.kind='notice' and d.meat=0 and d.quantity=0 and d.dedupe_key like 'donation-thanks:'||mid||':%'))
 and not exists(select 1 from khub_bot.closet_transfers c where c.receipt_id=mid and not (
   c.state='moved' or policy and c.state='cancelled' and c.source='donation'))
 and not exists(select 1 from khub_bot.deliveries d join khub_bot.delivery_preparation_reviews h on h.delivery_id=d.id where d.receipt_id=mid and h.released_at is null)
 and not exists(select 1 from khub_bot.account_jobs j where j.mail_id=mid and j.state<>'done')
 and not exists(select 1 from khub_bot.inbox_bid_mail b where b.mail_id=mid and not b.processed)
 and not exists(select 1 from khub_bot.raffle_intake_holds i where i.mail_id=mid);
$$;
commit;
