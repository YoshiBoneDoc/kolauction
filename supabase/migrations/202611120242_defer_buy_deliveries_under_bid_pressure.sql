-- Apply after 241, before rebuilding the bot. Bid pressure must not delay refunds.
begin;
set local lock_timeout='2s';
-- Preserve all existing claim guards, formatting, ordering and recovery behavior.
-- Only skip Buy item fulfillment when this RPC sets the transaction-local flag.
do $patch$
declare definition text; anchor text := $a$where x.state='pending'$a$;
begin
 definition:=pg_get_functiondef('khub_bot.claim_before_buy_batching(integer)'::regprocedure);
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
   raise exception 'Unexpected guarded delivery claim; inspect installed definition before applying.';
 end if;
 execute replace(definition,anchor,anchor||$a$ and (current_setting('khub.defer_buy_deliveries',true) is distinct from 'on'
                 or x.kind<>'sale_item' or x.dedupe_key not like 'buy-%')$a$);
end $patch$;
create function public.bot_claim_priority_delivery(p_message_version integer,p_batch boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_batch is null then raise exception 'Invalid claim mode.'; end if;
 perform set_config('khub.defer_buy_deliveries','on',true);
 if p_batch then return public.bot_claim_delivery_batch(p_message_version); end if;
 return public.bot_claim_delivery(p_message_version);
end;$$;
revoke all on function public.bot_claim_priority_delivery(integer,boolean) from public,anon,authenticated,service_role;
grant execute on function public.bot_claim_priority_delivery(integer,boolean) to service_role;
alter function public.bot_worker_status() rename to bot_worker_status_before_buy_priority;
create function public.bot_worker_status() returns jsonb language sql security definer set search_path='' as $$
 select public.bot_worker_status_before_buy_priority()||jsonb_build_object('buyPriorityDeferralVersion',1);
$$;
revoke all on function public.bot_worker_status_before_buy_priority(),public.bot_worker_status() from public,anon,authenticated,service_role;
grant execute on function public.bot_worker_status() to service_role;
notify pgrst,'reload schema';
commit;
