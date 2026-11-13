-- Apply after raffle audience migration 202611120243, before deploying the display.
-- Read-only computed field; no accounting, ticket numbering or settlement changes.
begin;
set local lock_timeout='2s';
create function public.total_tickets_sold(public.mystery_raffles) returns text
language sql stable security definer set search_path='' as $$
 select coalesce((select a.ticket_count from khub_bot.raffle_accounts a where a.raffle_id=($1).id),0)::text
 where public.can_view_raffle(($1).id);
$$;
revoke all on function public.total_tickets_sold(public.mystery_raffles) from public,anon,authenticated,service_role;
grant execute on function public.total_tickets_sold(public.mystery_raffles) to authenticated;
notify pgrst,'reload schema';
commit;
