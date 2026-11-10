-- After 250. Private operator lookup only; no financial or transfer changes.
begin;
set local lock_timeout='2s';
alter function public.bot_lookup_delivery(text) rename to lookup_before_recipient_name;
alter function public.lookup_before_recipient_name(text) set schema khub_bot;
revoke all on function khub_bot.lookup_before_recipient_name(text) from public,anon,authenticated,service_role;
create function public.bot_lookup_delivery(p_reference text) returns jsonb
language sql stable security definer set search_path='' as $$
 with delivery as materialized (
   select khub_bot.lookup_before_recipient_name(p_reference) as data
 )
 select case when data is null then null else data || jsonb_build_object('recipient_name',(
   select nullif(btrim(p.kol_player_name),'') from public.profiles p
   where p.kol_player_id=(data->>'recipient_id')::bigint limit 1
 )) end from delivery;
$$;
revoke all on function public.bot_lookup_delivery(text) from public,anon,authenticated;
grant execute on function public.bot_lookup_delivery(text) to service_role;
notify pgrst,'reload schema';
commit;
