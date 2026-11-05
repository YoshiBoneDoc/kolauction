-- Website only. Administrator search across all registered users, not just new members.
begin;
create function public.search_admin_users(p_query text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare q text := btrim(p_query); result jsonb;
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then
  raise exception 'Administrator access required.' using errcode='42501';
 end if;
 if q is null or char_length(q) not between 1 and 80 then
  raise exception 'Enter a player name or player ID (up to 80 characters).' using errcode='22023';
 end if;
 select coalesce(jsonb_agg(to_jsonb(u) order by u.username nulls last,u.id),'[]'::jsonb) into result from (
  select p.id,p.khub_username as username,p.kol_player_name,p.kol_player_id
  from public.profiles p
  where (q ~ '^#?[0-9]+$' and p.kol_player_id::text=ltrim(q,'#'))
     or strpos(lower(p.khub_username),lower(q))>0
     or strpos(lower(p.kol_player_name),lower(q))>0
  order by p.khub_username nulls last,p.id limit 26
 ) u;
 return jsonb_build_object('users',result);
end $$;
revoke all on function public.search_admin_users(text) from public,anon,authenticated;
grant execute on function public.search_admin_users(text) to authenticated;
notify pgrst,'reload schema';
commit;
