-- After 251. Add cleanup coverage; never delete financial receipts or ledger rows.
-- Apply once. Existing worker cleanup automatically uses the updated approval RPC.
begin;
set local lock_timeout='2s';
alter function public.bot_mail_cleanup(text[]) rename to cleanup_before_completed_intake;
alter function public.cleanup_before_completed_intake(text[]) set schema khub_bot;
revoke all on function khub_bot.cleanup_before_completed_intake(text[]) from public,anon,authenticated,service_role;
create function public.bot_mail_cleanup(p_mail_ids text[]) returns jsonb
language sql stable security definer set search_path='' as $$
 with candidates as materialized (
   select r.* from khub_bot.receipts r where r.mail_id=any(p_mail_ids)
     and r.payload#>>'{raw,type}'='normal'
     and not (coalesce(r.payload->'raw','{}') ? 'gift_original')
     and not exists(select 1 from khub_bot.mail_policy_reviews v where v.receipt_id=r.mail_id)
     and not exists(select 1 from khub_bot.account_jobs j where j.mail_id=r.mail_id and j.state<>'done')
     and not exists(select 1 from khub_bot.inbox_bid_mail m where m.mail_id=r.mail_id and not m.processed)
     and r.result not in ('processing','account_pending','previous_donation_review')
 ), extra as (
   select r.mail_id from candidates r
   where (
     (r.payload#>>'{command,type}' in ('fund','fill') and r.result='accepted')
     or (r.payload#>>'{command,type}' in ('register','credentials') and r.result='account_rejected'
       and exists(select 1 from khub_bot.account_jobs j where j.mail_id=r.mail_id and j.state='done'))
     or (r.payload#>>'{command,type}' in ('verify','list','bid','buy','fund','fill','bid_help','unknown')
       and exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id and d.kind='refund'))
   )
   -- Require recorded outgoing evidence, not absence of pending rows alone.
   and exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id)
   and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id
     and not coalesce(khub_bot.buy_batch_delivery_sent(d.id),false))
   and not exists(select 1 from khub_bot.deliveries d join khub_bot.delivery_preparation_reviews h on h.delivery_id=d.id
     where d.receipt_id=r.mail_id and h.released_at is null)
   and not exists(select 1 from khub_bot.closet_transfers c where c.receipt_id=r.mail_id and c.state<>'moved')
 ), approved as (
   select value as mail_id from jsonb_array_elements_text(khub_bot.cleanup_before_completed_intake(p_mail_ids))
   union select mail_id from extra
 ) select coalesce(jsonb_agg(mail_id order by mail_id),'[]'::jsonb) from approved;
$$;
revoke all on function public.bot_mail_cleanup(text[]) from public,anon,authenticated;
grant execute on function public.bot_mail_cleanup(text[]) to service_role;
notify pgrst,'reload schema';
commit;
