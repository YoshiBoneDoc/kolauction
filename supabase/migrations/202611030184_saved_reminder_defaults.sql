-- Apply after 183, before deploying the website. No bot runtime changes.
begin;
set local lock_timeout='2s';
create table khub_bot.saved_auction_preferences (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 reminder_minutes integer not null default 0 check(reminder_minutes in(0,5,15,30,60,360,720,1440))
);
alter table khub_bot.saved_auction_preferences enable row level security;
revoke all on khub_bot.saved_auction_preferences from public,anon,authenticated,service_role;

alter function public.read_saved_auctions(uuid) rename to read_saved_auctions_before_defaults;
create function public.read_saved_auctions(p_id uuid default null) returns jsonb
language sql stable security definer set search_path='' as $$
 select public.read_saved_auctions_before_defaults(p_id)||jsonb_build_object('default_reminder_minutes',
 coalesce((select reminder_minutes from khub_bot.saved_auction_preferences where user_id=auth.uid()),0));
$$;
revoke all on function public.read_saved_auctions_before_defaults(uuid),public.read_saved_auctions(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_saved_auctions(uuid) to authenticated;

create or replace function public.set_saved_auction(p_id uuid,p_saved boolean,p_minutes integer,p_time_zone text) returns void
language plpgsql security definer set search_path='' as $$
declare minutes integer;
begin
 if auth.uid() is null then raise exception 'Sign in to save auctions.' using errcode='42501';end if;
 if p_time_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_time_zone) then raise exception 'Invalid time zone.';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,3888785));
 minutes:=coalesce(p_minutes,
   (select reminder_minutes from khub_bot.saved_auctions where user_id=auth.uid() and auction_id=p_id and saved),
   (select reminder_minutes from khub_bot.saved_auction_preferences where user_id=auth.uid()),0);
 perform public.set_saved_auction(p_id,p_saved,minutes);
 update khub_bot.saved_auctions set time_zone=p_time_zone where user_id=auth.uid() and auction_id=p_id;
end;$$;

create function public.set_saved_reminder_default(p_minutes integer,p_apply_all boolean default false,p_time_zone text default 'UTC') returns void
language plpgsql security definer set search_path='' as $$
declare viewer uuid:=auth.uid();
begin
 if viewer is null or khub_bot.profile_is_restricted(viewer) then raise exception 'Sign in with an unrestricted account.' using errcode='42501';end if;
 if p_minutes is null or p_minutes not in(0,5,15,30,60,360,720,1440) or p_apply_all is null then raise exception 'Invalid reminder preference.';end if;
 if p_time_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_time_zone) then raise exception 'Invalid time zone.';end if;
 perform pg_advisory_xact_lock(hashtextextended(viewer::text,3888785));
 insert into khub_bot.saved_auction_preferences(user_id,reminder_minutes) values(viewer,p_minutes)
 on conflict(user_id) do update set reminder_minutes=excluded.reminder_minutes;
 if p_apply_all then
   update khub_bot.saved_auctions s set reminder_minutes=p_minutes,time_zone=p_time_zone,
   preference_set_at=case when s.reminder_minutes<>p_minutes then clock_timestamp() else s.preference_set_at end
   from public.auctions a where s.user_id=viewer and s.saved and a.id=s.auction_id
   and (khub_bot.saved_auction_concluded_at(a) is null or khub_bot.saved_auction_concluded_at(a)>statement_timestamp()-interval '72 hours');
 end if;
 -- Never reset attempt, send_started or outcome, even for Apply to all.
end;$$;
revoke all on function public.set_saved_reminder_default(integer,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.set_saved_reminder_default(integer,boolean,text) to authenticated;
notify pgrst,'reload schema';
commit;
