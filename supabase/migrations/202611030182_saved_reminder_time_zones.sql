-- Apply after 181, before deploying website and bot updates.
-- Existing bookmarks use UTC until their preferences are saved from a browser.
begin;
set local lock_timeout='2s';
alter table khub_bot.saved_auctions add column time_zone text not null default 'UTC';
create function public.set_saved_auction(p_id uuid,p_saved boolean,p_minutes integer,p_time_zone text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_time_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_time_zone) then
   raise exception 'Invalid time zone.';end if;
 -- Retain the existing ownership, limits and reminder scheduling checks.
 perform public.set_saved_auction(p_id,p_saved,p_minutes);
 update khub_bot.saved_auctions set time_zone=p_time_zone where user_id=auth.uid() and auction_id=p_id;
end;$$;
revoke all on function public.set_saved_auction(uuid,boolean,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.set_saved_auction(uuid,boolean,integer,text) to authenticated;
do $$declare d text;
begin
 d:=pg_get_functiondef('public.bot_claim_saved_reminder()'::regprocedure);
 if strpos(d,'''recipient_id'',r.kol_player_id')=0 then raise exception 'Unexpected saved reminder projection';end if;
 execute replace(d,'''recipient_id'',r.kol_player_id','''recipient_id'',r.kol_player_id,''time_zone'',r.time_zone');
end;$$;
notify pgrst,'reload schema';
commit;
