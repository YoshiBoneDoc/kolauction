-- After 262. Exclude teres minor (#3552305) before ranking/top-ten selection.
-- Identity-based exclusion survives name changes. No accounting/snapshot changes.
begin;
set local lock_timeout='2s';
do $patch$
declare definition text; anchor text:='where t.%1$I>0 and p.kol_verified_at is not null';
begin
 definition:=pg_get_functiondef('public.read_leaderboards()'::regprocedure);
 if strpos(definition,anchor)=0 then raise exception 'Unexpected leaderboard reader; inspect before applying 263.'; end if;
 execute replace(definition,anchor,anchor||' and p.kol_player_id<>3552305');
end;$patch$;
notify pgrst,'reload schema';
commit;
