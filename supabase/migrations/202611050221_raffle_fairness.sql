-- Apply after 220, before deploying the matching bot. Existing active draws remain legacy.
begin;
select pg_advisory_xact_lock(3888760);
alter table khub_bot.raffle_accounts add column fair_required boolean not null default false;
create table khub_bot.raffle_fairness (
 raffle_id uuid primary key references khub_bot.raffle_accounts(raffle_id),
 committed_at timestamptz not null,
 round bigint not null,
 manifest text not null,
 commitment_hash text not null check(commitment_hash ~ '^[0-9a-f]{64}$'),
 beacon jsonb,
 result jsonb
);
alter table khub_bot.raffle_fairness enable row level security;
revoke all on khub_bot.raffle_fairness from public,anon,authenticated,service_role;
create function khub_bot.fair_hash(p_text text) returns text language sql immutable set search_path='' as $$
 select encode(sha256(convert_to(p_text,'UTF8')),'hex');
$$;
create function khub_bot.fair_index(p_seed text,p_domain text,p_bound numeric) returns bigint
language plpgsql immutable set search_path='' as $$
declare space numeric:=power(2::numeric,256); threshold numeric; h text; value numeric; i integer; j integer;
begin
 if p_seed !~ '^[0-9a-f]{64}$' or p_domain not in ('ticket','prize') or p_bound<1 or p_bound>9223372036854775807 or p_bound<>trunc(p_bound) then raise exception 'Invalid fairness input'; end if;
 threshold:=space-mod(space,p_bound);
 for i in 0..127 loop
  h:=khub_bot.fair_hash('khub-drand-quicknet-sha256-v1'||E'\n'||p_seed||E'\n'||p_domain||E'\n'||i);
  value:=0;
  for j in 0..31 loop value:=value*256+get_byte(decode(h,'hex'),j); end loop;
  if value<threshold then return mod(value,p_bound)::bigint; end if;
 end loop;
 raise exception 'Rejection limit reached';
end $$;
-- These records cannot be swapped, rescheduled or overwritten by runtime RPCs.
create function khub_bot.guard_raffle_fairness() returns trigger language plpgsql set search_path='' as $$
begin
 if new.raffle_id is distinct from old.raffle_id or new.committed_at is distinct from old.committed_at
 or new.round is distinct from old.round or new.manifest is distinct from old.manifest
 or new.commitment_hash is distinct from old.commitment_hash
 or (old.result is not null and (new.result is distinct from old.result or new.beacon is distinct from old.beacon)) then
 raise exception 'Fairness commitment is immutable'; end if;
 return new;
end $$;
create trigger guard_raffle_fairness before update on khub_bot.raffle_fairness for each row execute function khub_bot.guard_raffle_fairness();
-- Only future activations use this protocol; no retroactive proof claims.
alter function public.activate_mystery_raffle(uuid) rename to activate_before_fairness;
alter function public.activate_before_fairness(uuid) set schema khub_bot;
revoke all on function khub_bot.activate_before_fairness(uuid) from public,anon,authenticated,service_role;
create function public.activate_mystery_raffle(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(3888760);
 perform khub_bot.activate_before_fairness(p_id);
 update khub_bot.raffle_accounts set fair_required=true where raffle_id=p_id;
end $$;
alter function public.bot_raffle_draw_work() rename to draw_work_before_fairness;
alter function public.draw_work_before_fairness() set schema khub_bot;
revoke all on function khub_bot.draw_work_before_fairness() from public,anon,authenticated,service_role;
create function public.bot_raffle_draw_work() returns jsonb language plpgsql security definer set search_path='' as $$
declare work jsonb; entry jsonb; output jsonb:='[]'; a khub_bot.raffle_accounts; f khub_bot.raffle_fairness;
 stamp timestamptz; target bigint; total bigint; pool text; manifest_text text;
begin
 -- Reuse all existing complete-scan, grace, uncertainty and frozen-input barriers.
 work:=khub_bot.draw_work_before_fairness();
 for entry in select value from jsonb_array_elements(work) loop
  select * into a from khub_bot.raffle_accounts where raffle_id=(entry->>'raffleId')::uuid;
  if a.fair_required then
   select * into f from khub_bot.raffle_fairness where raffle_id=a.raffle_id;
   if not found then
    stamp:=clock_timestamp();
    -- First quicknet round at least two minutes after this immutable commitment.
    target:=ceil((extract(epoch from stamp)+120-1692803367)/3)::bigint+1;
    select sum((p->>'ticketCount')::bigint)::bigint into total from jsonb_array_elements(entry->'purchases') p;
    select string_agg(concat_ws(',',p->>'outcome',p->>'itemId',p->>'quantity',p->>'probabilityBps'),E'\n' order by ord)
    into pool from jsonb_array_elements(entry->'prizes') with ordinality x(p,ord);
    manifest_text:='khub-drand-quicknet-sha256-v1'||E'\n'||a.raffle_id||E'\n'||target||E'\n'||total||E'\n'||a.ticket_label_offset||E'\n'||khub_bot.fair_hash(entry::text)||E'\n'||pool;
    insert into khub_bot.raffle_fairness(raffle_id,committed_at,round,manifest,commitment_hash)
    values(a.raffle_id,stamp,target,manifest_text,khub_bot.fair_hash(manifest_text)) returning * into f;
   end if;
   entry:=entry||jsonb_build_object('fairness',jsonb_build_object('method','khub-drand-quicknet-sha256-v1','round',f.round,'manifest',f.manifest,'commitmentHash',f.commitment_hash));
  end if;
  output:=output||jsonb_build_array(entry);
 end loop;
 return output;
end $$;
alter function public.bot_commit_raffle_draw(uuid,jsonb) rename to commit_draw_before_fairness;
alter function public.commit_draw_before_fairness(uuid,jsonb) set schema khub_bot;
revoke all on function khub_bot.commit_draw_before_fairness(uuid,jsonb) from public,anon,authenticated,service_role;
create function public.bot_commit_raffle_draw(p_id uuid,p_result jsonb) returns void language plpgsql security definer set search_path='' as $$
declare a khub_bot.raffle_accounts; f khub_bot.raffle_fairness; seed text; ticket bigint; prize bigint; legacy jsonb;
begin
 perform pg_advisory_xact_lock(3888760);
 select * into a from khub_bot.raffle_accounts where raffle_id=p_id for update;
 if a.draw_result is not null then return; end if;
 if a.fair_required then
  select * into f from khub_bot.raffle_fairness where raffle_id=p_id for update;
  if f.raffle_id is null or p_result->>'method' is distinct from 'khub-drand-quicknet-sha256-v1'
  or p_result#>>'{fairness,commitmentHash}' is distinct from f.commitment_hash
  or p_result#>>'{fairness,beacon,round}' is distinct from f.round::text
  or coalesce(p_result#>>'{fairness,beacon,randomness}','') !~ '^[0-9a-f]{64}$'
  or coalesce(p_result#>>'{fairness,beacon,signature}','') !~ '^[0-9a-f]{96}$'
  or clock_timestamp()<to_timestamp(1692803367+(f.round-1)*3) then raise exception 'Invalid fairness proof'; end if;
  -- BLS signature verification uses the pinned quicknet key in the worker and independent verifier.
  if encode(sha256(decode(p_result#>>'{fairness,beacon,signature}','hex')),'hex') is distinct from p_result#>>'{fairness,beacon,randomness}' then raise exception 'Invalid beacon randomness'; end if;
  seed:=khub_bot.fair_hash('khub-drand-quicknet-sha256-v1'||E'\n'||f.commitment_hash||E'\n'||(p_result#>>'{fairness,beacon,randomness}'));
  ticket:=khub_bot.fair_index(seed,'ticket',a.ticket_count)+1;
  prize:=khub_bot.fair_index(seed,'prize',10000);
  if p_result->>'winningTicket' is distinct from ticket::text or p_result->>'prizeIndex' is distinct from prize::text
  or p_result#>>'{fairness,seed}' is distinct from seed then raise exception 'Draw does not match beacon'; end if;
  legacy:=jsonb_set(p_result,'{method}','"crypto-rejection-ticket-then-prize-v1"');
  perform khub_bot.commit_draw_before_fairness(p_id,legacy);
  update khub_bot.raffle_accounts set draw_result=p_result where raffle_id=p_id;
  update khub_bot.raffle_fairness set beacon=p_result#>'{fairness,beacon}',result=jsonb_build_object('seed',seed,'winningTicket',ticket::text,'prizeIndex',prize::text,'selectedOutcome',p_result->>'selectedOutcome') where raffle_id=p_id;
 else
  perform khub_bot.commit_draw_before_fairness(p_id,p_result);
 end if;
end $$;
-- This summary intentionally excludes ticket totals, receipt hashes, offsets and manifest.
create function public.read_raffle_fairness_summary(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce(public.can_view_raffles(),false) then raise exception 'Raffle access required' using errcode='42501'; end if;
 return (select jsonb_build_object('required',a.fair_required,'state',r.state,'committedAt',f.committed_at,'round',f.round,'commitmentHash',f.commitment_hash,'complete',f.result is not null)
 from khub_bot.raffle_accounts a join public.mystery_raffles r on r.id=a.raffle_id left join khub_bot.raffle_fairness f on f.raffle_id=a.raffle_id where a.raffle_id=p_id);
end $$;
-- Explicit opt-in proof read. Never returned in listing, detail or ticket-history reads.
create function public.read_raffle_fairness_proof(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce(public.can_view_raffles(),false) then raise exception 'Raffle access required' using errcode='42501'; end if;
 return (select jsonb_build_object('method','khub-drand-quicknet-sha256-v1','raffleId',f.raffle_id,'committedAt',f.committed_at,'round',f.round,'manifest',f.manifest,'commitmentHash',f.commitment_hash,'beacon',f.beacon,'result',f.result,
 'displayedWinningTicket',((f.result->>'winningTicket')::numeric+a.ticket_label_offset)::text,
 'prizes',a.draw_input->'prizes') from khub_bot.raffle_fairness f join khub_bot.raffle_accounts a on a.raffle_id=f.raffle_id where f.raffle_id=p_id);
end $$;
revoke all on function khub_bot.fair_hash(text),khub_bot.fair_index(text,text,numeric),khub_bot.guard_raffle_fairness() from public,anon,authenticated,service_role;
revoke all on function public.activate_mystery_raffle(uuid),public.bot_raffle_draw_work(),public.bot_commit_raffle_draw(uuid,jsonb),public.read_raffle_fairness_summary(uuid),public.read_raffle_fairness_proof(uuid) from public,anon,authenticated,service_role;
grant execute on function public.activate_mystery_raffle(uuid),public.read_raffle_fairness_summary(uuid),public.read_raffle_fairness_proof(uuid) to authenticated;
grant execute on function public.bot_raffle_draw_work(),public.bot_commit_raffle_draw(uuid,jsonb) to service_role;
-- Older workers skip version 3 raffle draws while continuing ordinary deliveries.
alter function public.bot_worker_status() rename to worker_status_before_raffle_fairness;
alter function public.worker_status_before_raffle_fairness() set schema khub_bot;
revoke all on function khub_bot.worker_status_before_raffle_fairness() from public,anon,authenticated,service_role;
create function public.bot_worker_status() returns jsonb language sql security definer set search_path='' as $$
 select khub_bot.worker_status_before_raffle_fairness()||jsonb_build_object('raffleBackendVersion',3,'raffleFairnessVersion',1);
$$;
revoke all on function public.bot_worker_status() from public,anon,authenticated;
grant execute on function public.bot_worker_status() to service_role;
notify pgrst,'reload schema';
commit;
