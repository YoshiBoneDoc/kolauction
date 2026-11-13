-- Apply after 256, before deploying the participant-total display.
-- Aggregate only: repeat purchases by one KoL player count as one participant.
begin;
set local lock_timeout='2s';
create function public.total_raffle_participants(public.mystery_raffles) returns text
language sql stable security definer set search_path='' as $$
 select count(distinct p.player_id)::text from khub_bot.raffle_purchases p
 where p.raffle_id=($1).id
 having public.can_view_raffle(($1).id);
$$;
revoke all on function public.total_raffle_participants(public.mystery_raffles) from public,anon,authenticated,service_role;
grant execute on function public.total_raffle_participants(public.mystery_raffles) to authenticated;
notify pgrst,'reload schema';
commit;
