-- After 265. Private, bounded search with ranks computed before name filtering.
begin;
set local lock_timeout='2s';
create function public.search_leaderboards(p_category text,p_search text,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' set statement_timeout='2500ms' as $$
declare actor uuid:=auth.uid(); column_name text; result jsonb;
begin
 if actor is null or khub_bot.profile_is_restricted(actor) then raise exception 'Sign in with an unrestricted account.' using errcode='42501'; end if;
 if p_category is null or p_category not in ('volume','trades','donors') or p_search is null or length(btrim(p_search)) not between 1 and 120
 or p_offset is null or p_offset not between 0 and 10000 then raise exception 'Invalid leaderboard search.'; end if;
 if not exists(select 1 from khub_bot.leaderboard_state) then raise exception 'Leaderboards are being prepared.'; end if;
 column_name:=case p_category when 'donors' then 'donated' else p_category end;
 execute format($query$
 with ranked as materialized (
   select p.id,coalesce(nullif(p.kol_player_name,''),p.khub_username) name,t.%1$I value,
     row_number() over(order by t.%1$I desc,t.profile_id) rank
   from khub_bot.leaderboard_totals t join public.profiles p on p.id=t.profile_id
   where t.%1$I>0 and p.kol_verified_at is not null and not khub_bot.profile_is_restricted(p.id)
   and not exists(select 1 from khub_bot.leaderboard_exclusions e where e.kol_player_id=p.kol_player_id)
   and not exists(select 1 from public.player_ignores i join public.profiles viewer on viewer.id=$1
     where (i.user_id=$1 and i.kol_player_id=p.kol_player_id) or (i.user_id=p.id and i.kol_player_id=viewer.kol_player_id))
 ), matches as materialized (
   select * from ranked where strpos(lower(name),lower(btrim($2)))>0 order by rank limit 21 offset $3
 ) select jsonb_build_object('rows',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'value',value::text,'rank',rank) order by rank)
 from (select * from matches order by rank limit 20) page),'[]'::jsonb),'more',(select count(*)>20 from matches))
 $query$,column_name) into result using actor,p_search,p_offset;
 return result;
end;$$;
revoke all on function public.search_leaderboards(text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.search_leaderboards(text,text,integer) to authenticated;
notify pgrst,'reload schema';
commit;
