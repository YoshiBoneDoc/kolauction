-- After 263. Private caller-only totals from the same display snapshot.
-- Preserves all ranking exclusions and authorization checks. No extra aggregation.
begin;
set local lock_timeout='2s';
alter function public.read_leaderboards() rename to read_leaderboards_before_personal;
revoke all on function public.read_leaderboards_before_personal() from public,anon,authenticated,service_role;
create function public.read_leaderboards() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 -- Run the existing authorization guard before accessing any personal data.
 result:=public.read_leaderboards_before_personal();
 return result||jsonb_build_object('personal',coalesce((
   select jsonb_build_object('volume',t.volume::text,'trades',t.trades::text,'donors',t.donated::text)
   from khub_bot.leaderboard_totals t where t.profile_id=auth.uid()
 ),jsonb_build_object('volume','0','trades','0','donors','0')));
end;$$;
revoke all on function public.read_leaderboards() from public,anon,authenticated,service_role;
grant execute on function public.read_leaderboards() to authenticated;
notify pgrst,'reload schema';
commit;
