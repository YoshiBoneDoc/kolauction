-- After 262; compatible with 263-267. Apply once per database.
-- Repairs discovery maintenance under the DELETE-without-WHERE safeguard.
-- Does not change financial data, ranking rules, grants or refresh cadence.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $patch$
declare
 definition text;
 anchor text := 'delete from khub_bot.leaderboard_totals;';
 replacement text := 'delete from khub_bot.leaderboard_totals where profile_id is not null;';
begin
 definition := pg_get_functiondef('khub_bot.refresh_leaderboards()'::regprocedure);
 if strpos(definition,anchor)=0 then
   raise exception 'Unexpected leaderboard refresh definition; inspect before applying 268.';
 end if;
 -- profile_id is the primary key: the predicate preserves the atomic full
 -- snapshot rebuild while satisfying the database safeguard. Never disable it.
 execute replace(definition,anchor,replacement);
end;
$patch$;
-- Let the normal maintenance path refresh; do not force a rebuild during install.
notify pgrst,'reload schema';
commit;
