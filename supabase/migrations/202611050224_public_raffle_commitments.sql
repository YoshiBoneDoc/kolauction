-- Apply after 223. Publish only the durable commitment metadata, never holdings/totals.
begin;
create function public.read_public_raffle_commitment(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('raffleId',f.raffle_id,'method','khub-drand-quicknet-sha256-v1',
 'commitmentHash',f.commitment_hash,'committedAt',f.committed_at,'round',f.round,
 'chainHash','52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
 'beaconAvailableAt',to_timestamp(1692803367+(f.round-1)*3))
 from khub_bot.raffle_fairness f where f.raffle_id=p_id;
$$;
revoke all on function public.read_public_raffle_commitment(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_public_raffle_commitment(uuid) to anon,authenticated;
notify pgrst,'reload schema';
commit;
