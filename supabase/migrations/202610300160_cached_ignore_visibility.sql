-- Apply after 159, before deploying the cache-routing update.
begin;
-- Resolve both directions once per statement, including targets registered later.
create function khub_bot.ignored_sellers() returns uuid[]
language sql stable security definer set search_path='' as $$
 select coalesce(array_agg(distinct target.id),'{}'::uuid[]) from (
 select p.id from public.player_ignores i join public.profiles p on p.kol_player_id=i.kol_player_id
 where i.user_id=auth.uid() and p.id<>auth.uid()
 union
 select i.user_id from public.player_ignores i
 where i.kol_player_id=(select kol_player_id from public.profiles where id=auth.uid()) and i.user_id<>auth.uid()
 ) target;
$$;
create function public.read_ignore_relationships() returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (
 exists(select 1 from public.player_ignores where user_id=auth.uid()) or
 exists(select 1 from public.player_ignores where kol_player_id=(select kol_player_id from public.profiles where id=auth.uid())));
$$;
-- Inlineable: outer ID/search/status predicates can use auction indexes.
-- The private UUID array is an InitPlan, not a profile/ignore join per auction.
create or replace function khub_bot.visible_auctions() returns setof public.auctions
language sql stable security invoker as $$
 select a.* from public.auctions a
 where a.escrow_mode or not (a.seller_id=any((select khub_bot.ignored_sellers())::uuid[]));
$$;
revoke all on function khub_bot.ignored_sellers(),public.read_ignore_relationships() from public,anon,authenticated,service_role;
grant execute on function public.read_ignore_relationships() to authenticated;
notify pgrst,'reload schema';
commit;
