-- After 249. Read-only scheduling hint; no financial definitions or locks change.
-- Apply once, then release the bot separately. No website release needed.
begin;
set local lock_timeout='2s';
alter function public.bot_cycle_plan() rename to cycle_plan_before_bid_priority;
alter function public.cycle_plan_before_bid_priority() set schema khub_bot;
revoke all on function khub_bot.cycle_plan_before_bid_priority() from public,anon,authenticated,service_role;
create function public.bot_cycle_plan() returns jsonb language sql stable security definer set search_path='' as $$
 select khub_bot.cycle_plan_before_bid_priority() || jsonb_build_object('closing_bid_pressure',exists(
   select 1 from public.auctions a
   where a.status='active' and a.end_time between statement_timestamp()-interval '30 seconds' and statement_timestamp()+interval '90 seconds'
   and (select count(*) from (select 1 from public.bids b where b.auction_id=a.id
       and b.created_at>=statement_timestamp()-interval '60 seconds' limit 3) recent)>=3
 ));
$$;
revoke all on function public.bot_cycle_plan() from public,anon,authenticated;
grant execute on function public.bot_cycle_plan() to service_role;
notify pgrst,'reload schema';
commit;
