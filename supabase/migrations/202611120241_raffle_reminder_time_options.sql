-- Apply after 240. Expand raffle reminder timing without changing bookmark choices.
begin;
set local lock_timeout='2s';
alter table khub_bot.raffle_reminders drop constraint raffle_reminders_reminder_minutes_check;
alter table khub_bot.raffle_reminders add constraint raffle_reminders_reminder_minutes_check
 check(reminder_minutes in (5,15,30,60,360,720,1440,4320));
create or replace function public.set_raffle_reminder(p_id uuid,p_minutes integer,p_time_zone text default 'UTC') returns void
language plpgsql security definer set search_path='' as $$
declare viewer uuid:=auth.uid();
begin
 if viewer is null then raise exception 'Sign in to set a reminder.' using errcode='42501'; end if;
 if p_minutes is not null and p_minutes not in (60,360,720,1440,4320) then raise exception 'Invalid reminder time.'; end if;
 if p_time_zone is null or length(p_time_zone)>100 then raise exception 'Invalid time zone.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(viewer::text,3888786));
 if p_minutes is null then delete from khub_bot.raffle_reminders where user_id=viewer and raffle_id=p_id and attempt is null; return; end if;
 if khub_bot.profile_is_restricted(viewer) then raise exception 'Account access restricted.' using errcode='42501'; end if;
 if not exists (select 1 from public.mystery_raffles r where r.id=p_id and r.state='active' and r.ends_at>statement_timestamp()
   and r.ends_at-make_interval(mins=>p_minutes)>statement_timestamp() and r.creator_id<>viewer) then raise exception 'Raffle reminder unavailable.'; end if;
 if (select count(*) from khub_bot.raffle_reminders where user_id=viewer and attempt is null)>=200
 and not exists(select 1 from khub_bot.raffle_reminders where user_id=viewer and raffle_id=p_id) then raise exception 'Reminder limit reached.'; end if;
 insert into khub_bot.raffle_reminders(user_id,raffle_id,reminder_minutes,time_zone) values(viewer,p_id,p_minutes,p_time_zone)
 on conflict(user_id,raffle_id) do update set reminder_minutes=excluded.reminder_minutes,time_zone=excluded.time_zone,
 preference_set_at=case when raffle_reminders.reminder_minutes<>excluded.reminder_minutes then clock_timestamp() else raffle_reminders.preference_set_at end
 where raffle_reminders.attempt is null;
 if not found then raise exception 'This raffle reminder was already attempted.'; end if;
end;$$;
commit;
