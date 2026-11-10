-- Read-only Supabase SQL Editor audit. Does not delete mail or call KoL.
-- Oldest 200 recorded receipts; excludes raw text, credentials and account secrets.
-- 'eligible_now' uses the currently INSTALLED cleanup function (before/after 252).
with candidates as materialized (
 select mail_id,sender_id,received_at,payload->>'sender_name' sender_name,
   payload#>>'{command,type}' command,result
 from khub_bot.receipts where received_at < now()-interval '5 minutes'
 order by received_at,mail_id limit 200
), approval as materialized (
 select public.bot_mail_cleanup(array(select mail_id from candidates)) ids
)
select 'M-'||c.mail_id reference,c.sender_name,c.sender_id,c.received_at,c.command,c.result,
 coalesce(a.ids ? c.mail_id,false) eligible_now,
 (select count(*) from khub_bot.deliveries d where d.receipt_id=c.mail_id
   and not coalesce(khub_bot.buy_batch_delivery_sent(d.id),false)) unfinished_outgoing,
 (select count(*) from khub_bot.closet_transfers t where t.receipt_id=c.mail_id and t.state<>'moved') unfinished_closet,
 exists(select 1 from khub_bot.account_jobs j where j.mail_id=c.mail_id and j.state<>'done') pending_account_job,
 exists(select 1 from khub_bot.mail_policy_reviews v where v.receipt_id=c.mail_id) policy_review
from candidates c cross join approval a order by c.received_at,c.mail_id;
