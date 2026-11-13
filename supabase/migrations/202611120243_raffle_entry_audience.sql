-- Apply after 242, before deploying the raffle creation UI. Existing raffles stay club-only.
begin;
set local lock_timeout='2s';
alter table public.mystery_raffles add column audience text not null default 'mmg'
 check (audience in ('mmg','public'));
grant select(audience) on public.mystery_raffles to authenticated;

-- All verified kHub players may browse raffles, but row policies and scoped RPCs
-- retain the MMG boundary for club-only raffles.
create or replace function public.can_view_raffles() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid()
 and p.kol_verified_at is not null and not khub_bot.profile_is_restricted(p.id));
$$;
create function public.can_view_raffle(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select public.can_view_raffles() and exists(select 1 from public.mystery_raffles r where r.id=p_id
 and (r.audience='public' or khub_bot.is_high_rollers_member(auth.uid()) or khub_bot.is_administrator(auth.uid())));
$$;
revoke all on function public.can_view_raffle(uuid) from public,anon,authenticated,service_role;
grant execute on function public.can_view_raffle(uuid) to anon,authenticated;
create function public.can_view_mmg_raffles() returns boolean
language sql stable security definer set search_path='' as $$
 select khub_bot.is_high_rollers_member(auth.uid()) or coalesce(khub_bot.is_administrator(auth.uid()),false);
$$;
revoke all on function public.can_view_mmg_raffles() from public,anon,authenticated,service_role;
grant execute on function public.can_view_mmg_raffles() to anon,authenticated;
-- The uncorrelated membership checks can be evaluated once per query.
alter policy raffle_preview_read on public.mystery_raffles using(
 (select public.can_view_raffles()) and (audience='public' or (select public.can_view_mmg_raffles())));
alter policy raffle_prize_preview_read on public.mystery_raffle_prizes using(
 exists(select 1 from public.mystery_raffles r where r.id=raffle_id));

-- Keep the request UUID retry behavior. A retry cannot silently change audience.
create function public.publish_mystery_raffle(p_request_id uuid,p_name text,p_ticket_price bigint,p_ends_at timestamptz,p_prizes jsonb,p_audience text) returns uuid
language plpgsql security definer set search_path='' as $$
declare rid uuid; saved_audience text;
begin
 if p_audience is null or p_audience not in ('mmg','public') then raise exception 'Invalid raffle audience.'; end if;
 rid:=public.create_mystery_raffle(p_request_id,p_name,p_ticket_price,p_ends_at,p_prizes);
 select audience into saved_audience from public.mystery_raffles where id=rid and creator_id=auth.uid() for update;
 if saved_audience is distinct from p_audience and exists(select 1 from public.mystery_raffles where id=rid and state<>'preview') then
  raise exception 'Existing raffle has a different audience.';
 end if;
 update public.mystery_raffles set audience=p_audience where id=rid and state='preview';
 if exists(select 1 from public.mystery_raffles where id=rid and state='preview') then perform public.activate_mystery_raffle(rid); end if;
 return rid;
end $$;
revoke all on function public.publish_mystery_raffle(uuid,text,bigint,timestamptz,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.publish_mystery_raffle(uuid,text,bigint,timestamptz,jsonb,text) to authenticated;

-- Purchase acceptance remains in the locked, receipt-deduplicated financial RPC.
-- Replace only the prior MMG membership predicate with per-raffle eligibility.
do $patch$
declare definition text; old_guard text:=$old$and exists(select 1 from khub_bot.high_rollers_members m join public.profiles p on p.kol_player_id=m.player_id
 where m.player_id=sid and m.status='accepted' and not khub_bot.profile_is_restricted(p.id))$old$;
 new_guard text:=$new$and exists(select 1 from public.profiles p where p.kol_player_id=sid and p.kol_verified_at is not null
 and not khub_bot.profile_is_restricted(p.id)
 and (r.audience='public' or khub_bot.is_high_rollers_member(p.id)))$new$;
begin
 definition:=pg_get_functiondef('public.bot_ingest_mail(jsonb)'::regprocedure);
 if (length(definition)-length(replace(definition,old_guard,'')))/length(old_guard)<>1 then
  raise exception 'Unexpected raffle purchase guard; inspect installed intake before applying.';
 end if;
 execute replace(definition,old_guard,new_guard);
 -- A rejected public payment must not receive the club-only rejection wording.
 definition:=pg_get_functiondef('public.bot_ingest_mail(jsonb)'::regprocedure);
 if strpos(definition,$a$when p_mail#>>'{command,type}'='raffle' and not exists($a$)=0 then
  raise exception 'Unexpected raffle rejection wording.';
 end if;
 execute replace(definition,$a$when p_mail#>>'{command,type}'='raffle' and not exists($a$,
  $a$when p_mail#>>'{command,type}'='raffle' and r.audience='mmg' and not exists($a$);
end $patch$;

-- Scope security-definer detail/proof reads by this raffle, not by global access.
do $patch$
declare signature regprocedure; definition text; old_guard text; new_guard text;
begin
 for signature in select unnest(array[
  'public.read_raffle_result(uuid)'::regprocedure,
  'public.read_raffle_fairness_summary(uuid)'::regprocedure,
  'public.read_raffle_fairness_proof(uuid)'::regprocedure,
  'public.read_my_raffle_ticket_page(uuid,integer)'::regprocedure]) loop
  definition:=pg_get_functiondef(signature);
  old_guard:='public.can_view_raffles()';
  if strpos(definition,old_guard)=0 then raise exception 'Unexpected raffle read guard: %',signature; end if;
  new_guard:='public.can_view_raffle(p_id)';
  execute replace(definition,old_guard,new_guard);
 end loop;
end $patch$;
-- Reminder preferences and dispatch follow the same per-raffle audience.
do $patch$
declare definition text; anchor text;
begin
 definition:=pg_get_functiondef('public.set_raffle_reminder(uuid,integer,text)'::regprocedure);
 anchor:='and r.creator_id<>viewer';
 if strpos(definition,anchor)=0 then raise exception 'Unexpected raffle reminder preference guard.'; end if;
 execute replace(definition,anchor,anchor||' and public.can_view_raffle(p_id)');
 definition:=pg_get_functiondef('public.bot_claim_raffle_reminder()'::regprocedure);
 anchor:=$a$and not khub_bot.profile_is_restricted(r.creator_id)$a$;
 if strpos(definition,anchor)=0 then raise exception 'Unexpected raffle reminder claim guard.'; end if;
 execute replace(definition,anchor,anchor||$a$ and (r.audience='public' or khub_bot.is_high_rollers_member(s.user_id))$a$);
 definition:=pg_get_functiondef('public.bot_start_raffle_reminder(uuid)'::regprocedure);
 if strpos(definition,anchor)=0 then raise exception 'Unexpected raffle reminder start guard.'; end if;
 execute replace(definition,anchor,anchor||$a$ and (r.audience='public' or khub_bot.is_high_rollers_member(s.user_id))$a$);
end $patch$;

-- Public entrants retain their own purchase history without gaining club data.
do $patch$
declare definition text; anchor text:='if not khub_bot.is_high_rollers_member(auth.uid()) then';
begin
 definition:=pg_get_functiondef('public.read_my_raffle_history(integer)'::regprocedure);
 if strpos(definition,anchor)=0 then raise exception 'Unexpected personal raffle history guard.'; end if;
 execute replace(definition,anchor,'if not public.can_view_raffles() then');
end $patch$;
notify pgrst,'reload schema';
commit;
