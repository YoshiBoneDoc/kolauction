-- After 252. Apply once, then release the compatible bot for gift-envelope cleanup.
-- Read-only approval only: no ledger/evidence deletion, opening, sends or retries.
begin;
set local lock_timeout='2s';
create function khub_bot.cleanup_obligations_complete(mid text, policy boolean default false)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from khub_bot.deliveries d where d.receipt_id=mid)
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
create function khub_bot.cleanup_raffle_complete(rid uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.mystery_raffles r join khub_bot.raffle_accounts a on a.raffle_id=r.id
   where r.id=rid and r.state='settled' and a.held_meat=0 and a.settlement_queued)
 and not exists(select 1 from khub_bot.raffle_inventory i where i.raffle_id=rid and i.quantity>0)
 and not exists(select 1 from khub_bot.deliveries d where d.dedupe_key like 'raffle:'||rid||':%'
   and not coalesce(khub_bot.buy_batch_delivery_sent(d.id),false));
$$;
-- Terminal outcomes only; do not infer completion from missing outgoing rows.
create function khub_bot.cleanup_receipt_terminal(r khub_bot.receipts) returns boolean
language sql stable set search_path='' as $$
 select r.result not in ('processing','account_pending','previous_donation_review') and case
 when r.result='raffle_tickets' then exists(select 1 from khub_bot.raffle_purchases p where p.receipt_id=r.mail_id and khub_bot.cleanup_raffle_complete(p.raffle_id))
 when r.result='raffle_supply' then exists(select 1 from khub_bot.raffle_deposits p where p.receipt_id=r.mail_id and khub_bot.cleanup_raffle_complete(p.raffle_id))
 else r.result in ('accepted','donation','donation_help','bid_help','account_ready','account_rejected','raffle_advance','raffle_advance_rejected','raffle_refund')
 or exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id and d.kind='refund') end;

$$;
alter function public.bot_mail_cleanup(text[]) rename to cleanup_before_remaining_mail;
alter function public.cleanup_before_remaining_mail(text[]) set schema khub_bot;
revoke all on function khub_bot.cleanup_before_remaining_mail(text[]) from public,anon,authenticated,service_role;
create function public.bot_mail_cleanup(p_mail_ids text[]) returns jsonb
language sql stable security definer set search_path='' as $$
 with candidates as materialized (
 select r.* from khub_bot.receipts r where r.mail_id=any(p_mail_ids)
 and r.payload#>>'{raw,type}'='normal' and not (coalesce(r.payload->'raw','{}') ? 'gift_original')
 ), extra as (
 select r.mail_id from candidates r where (
  (not exists(select 1 from khub_bot.mail_policy_reviews v where v.receipt_id=r.mail_id)
    and khub_bot.cleanup_receipt_terminal(r) and khub_bot.cleanup_obligations_complete(r.mail_id))
  or (r.result='donation' and exists(select 1 from khub_bot.mail_policy_reviews v where v.receipt_id=r.mail_id and v.refund_queued)
    and exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id and d.kind='refund' and d.dedupe_key like 'policy-refund:'||r.mail_id||':%')
    and (select coalesce(sum(d.meat),0) from khub_bot.deliveries d where d.receipt_id=r.mail_id and d.kind='refund')=(r.payload->>'meat')::numeric
    and coalesce((select jsonb_object_agg(x.item_id::text,x.qty) from (
      select d.item_id,sum(d.quantity) qty from khub_bot.deliveries d where d.receipt_id=r.mail_id and d.kind='refund' and d.item_id is not null group by d.item_id
    ) x),'{}'::jsonb)=coalesce((select jsonb_object_agg(x->>'id',(x->>'quantity')::numeric) from jsonb_array_elements(r.payload->'items') x),'{}'::jsonb)
    and khub_bot.cleanup_obligations_complete(r.mail_id,true))
 )
 ), approved as (
 select value mail_id from jsonb_array_elements_text(khub_bot.cleanup_before_remaining_mail(p_mail_ids))
 union select mail_id from extra
 ) select coalesce(jsonb_agg(a.mail_id order by a.mail_id),'[]'::jsonb) from approved a join candidates c on c.mail_id=a.mail_id;
$$;
-- Only actual, freshly observed opened envelopes matching verified payloads.
create function public.bot_gift_mail_cleanup(p_mails jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if jsonb_typeof(p_mails) is distinct from 'array' or jsonb_array_length(p_mails)>24 then raise exception 'Invalid gift cleanup batch';end if;
 return coalesce((select jsonb_agg(distinct r.mail_id) from jsonb_array_elements(p_mails) raw
 join khub_bot.incoming_gifts g on g.mail_id=raw->>'id'
 join khub_bot.receipts r on r.mail_id=g.mail_id and r.payload=g.payload
 where not g.legacy_donation and g.opened_at is not null
 and raw=g.payload#>'{raw,gift_original}'
 and exists(select 1 from khub_bot.gift_verified_contents v where v.mail_id=g.mail_id)
 and not exists(select 1 from khub_bot.gift_mail_reviews v where v.mail_id=g.mail_id and v.resolved_at is null)
 and not exists(select 1 from khub_bot.gift_open_attempts a where a.state='opening' or a.state='isolated' and (a.mail_id is null or a.mail_id=g.mail_id))
 and not exists(select 1 from khub_bot.mail_policy_reviews v where v.receipt_id=g.mail_id)
 and khub_bot.cleanup_receipt_terminal(r) and khub_bot.cleanup_obligations_complete(r.mail_id)), '[]'::jsonb);
end;$$;
alter function public.bot_worker_status() rename to status_before_gift_cleanup;
alter function public.status_before_gift_cleanup() set schema khub_bot;
revoke all on function khub_bot.status_before_gift_cleanup() from public,anon,authenticated,service_role;
create function public.bot_worker_status() returns jsonb language sql security definer set search_path='' as $$
 select khub_bot.status_before_gift_cleanup()||jsonb_build_object('completedGiftCleanupVersion',1);
$$;
revoke all on function khub_bot.cleanup_obligations_complete(text,boolean),khub_bot.cleanup_raffle_complete(uuid),khub_bot.cleanup_receipt_terminal(khub_bot.receipts),public.bot_gift_mail_cleanup(jsonb),public.bot_mail_cleanup(text[]),public.bot_worker_status() from public,anon,authenticated,service_role;
grant execute on function public.bot_gift_mail_cleanup(jsonb),public.bot_mail_cleanup(text[]),public.bot_worker_status() to service_role;
notify pgrst,'reload schema';
commit;
