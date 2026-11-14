-- After 264. Exclude the owner's Anrath1 account from all ranked categories.
-- Resolve the verified KoL identity once so later name changes preserve exclusion.
-- No financial records, snapshots or personal sidebar totals change.
begin;
set local lock_timeout='2s';
create table khub_bot.leaderboard_exclusions(kol_player_id bigint primary key);
alter table khub_bot.leaderboard_exclusions enable row level security;
revoke all on khub_bot.leaderboard_exclusions from public,anon,authenticated,service_role;
insert into khub_bot.leaderboard_exclusions values(3552305);
insert into khub_bot.leaderboard_exclusions
 select kol_player_id from public.profiles
 where kol_verified_at is not null and lower(kol_player_name)='anrath1'
 on conflict do nothing;
do $patch$
declare definition text; anchor text:='and p.kol_player_id<>3552305';
begin
 if not exists(select 1 from public.profiles p join khub_bot.leaderboard_exclusions e using(kol_player_id)
   where p.kol_verified_at is not null and lower(p.kol_player_name)='anrath1') then
   raise exception 'Verified Anrath1 account not found; verify the KoL identity before applying 265.';
 end if;
 definition:=pg_get_functiondef('public.read_leaderboards_before_personal()'::regprocedure);
 if strpos(definition,anchor)=0 then raise exception 'Unexpected leaderboard reader; inspect before applying 265.'; end if;
 execute replace(definition,anchor,'and not exists(select 1 from khub_bot.leaderboard_exclusions excluded where excluded.kol_player_id=p.kol_player_id)');
end;$patch$;
notify pgrst,'reload schema';
commit;
