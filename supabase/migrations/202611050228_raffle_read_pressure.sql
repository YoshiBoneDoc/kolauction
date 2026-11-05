-- Apply after 227. Read-only optimizations; no changes to financial processing.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create index raffle_purchase_player_history_idx on khub_bot.raffle_purchases(player_id,raffle_id,received_at,receipt_id);

create or replace function public.read_my_account_access() returns jsonb language sql stable security definer set search_path='' as $$
 select khub_bot.account_access_before_raffle_history() || jsonb_build_object(
 'access_version',1,'is_high_rollers_member',khub_bot.is_high_rollers_member(auth.uid()),
 'is_admin',coalesce(khub_bot.is_administrator(auth.uid()),false),
 'can_view_raffles',public.can_view_raffles(),
 'invitation_version',public.read_my_high_rollers_invitation());
$$;

-- New endpoint preserves the old signature for older runtimes. Totals are
-- independent of paging; refund lookups run only for the visible 50 receipts.
create function public.read_my_raffle_ticket_page(p_id uuid,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare player bigint; label_offset integer; result jsonb;
begin
 if not public.can_view_raffles() then raise exception 'Raffle access required' using errcode='42501'; end if;
 select ticket_label_offset into label_offset from khub_bot.raffle_accounts where raffle_id=p_id;
 select kol_player_id into player from public.profiles where id=auth.uid();
 select jsonb_build_object('ticket_count',coalesce(sum(last_ticket-first_ticket+1),0)::text,'purchase_count',count(*)) into result
 from khub_bot.raffle_purchases where raffle_id=p_id and player_id=player;
 return result || jsonb_build_object('purchases',coalesce((select jsonb_agg(jsonb_build_object(
 'receipt_id',p.receipt_id,'meat',p.meat::text,'first_ticket',(p.first_ticket::numeric+label_offset)::text,'last_ticket',(p.last_ticket::numeric+label_offset)::text,'received_at',p.received_at,
 'refund_status',(select case when count(*)=0 then null when bool_or(d.state<>'sent') then 'awaiting_verification' else 'refunded' end
 from khub_bot.deliveries d where d.dedupe_key like 'raffle:'||p.raffle_id||':refund:'||p.receipt_id||':%')) order by p.received_at,p.receipt_id)
 from (select * from khub_bot.raffle_purchases where raffle_id=p_id and player_id=player
 order by received_at,receipt_id limit 50 offset greatest(0,least(coalesce(p_offset,0),1000000))) p),'[]'::jsonb));
end $$;
revoke all on function public.read_my_raffle_ticket_page(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_my_raffle_ticket_page(uuid,integer) to authenticated;
-- Extend only the existing anonymous commitment record with completion status.
create or replace function public.read_public_raffle_commitment(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('raffleId',f.raffle_id,'method','khub-drand-quicknet-sha256-v1',
 'commitmentHash',f.commitment_hash,'committedAt',f.committed_at,'round',f.round,
 'chainHash','52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
 'beaconAvailableAt',to_timestamp(1692803367+(f.round-1)*3),'complete',f.result is not null)
 from khub_bot.raffle_fairness f where f.raffle_id=p_id;
$$;
notify pgrst,'reload schema';
commit;
