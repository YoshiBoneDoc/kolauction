-- Apply after 239 before deploying the raffle reminder UI and bot.
begin;
set local lock_timeout='2s';
create table khub_bot.raffle_reminders (
 user_id uuid not null references public.profiles(id) on delete cascade,
 raffle_id uuid not null references public.mystery_raffles(id) on delete cascade,
 reminder_minutes integer not null check(reminder_minutes in (5,15,30,60,360,720,1440)),
 preference_set_at timestamptz not null default clock_timestamp(),
 time_zone text not null default 'UTC',
 attempt uuid, recipient_id bigint, send_started boolean not null default false,
 outcome text check(outcome in ('unknown','sent')),
 primary key(user_id,raffle_id)
);
alter table khub_bot.raffle_reminders enable row level security;
revoke all on khub_bot.raffle_reminders from public,anon,authenticated,service_role;
create index raffle_reminders_pending on khub_bot.raffle_reminders(raffle_id) where attempt is null;
create function public.read_raffle_reminder(p_id uuid) returns integer language sql stable security definer set search_path='' as $$
 select reminder_minutes from khub_bot.raffle_reminders where user_id=auth.uid() and raffle_id=p_id;
$$;
create function public.set_raffle_reminder(p_id uuid,p_minutes integer,p_time_zone text default 'UTC') returns void
language plpgsql security definer set search_path='' as $$
declare viewer uuid:=auth.uid();
begin
 if viewer is null then raise exception 'Sign in to set a reminder.' using errcode='42501'; end if;
 if p_minutes is not null and p_minutes not in (5,15,30,60,360,720,1440) then raise exception 'Invalid reminder time.'; end if;
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
create function public.bot_claim_raffle_reminder() returns jsonb language plpgsql security definer set search_path='' as $$
declare rec record; token uuid:=gen_random_uuid();
begin
 select s.user_id,s.raffle_id,s.time_zone,r.raffle_number,r.name,r.ends_at,p.kol_player_id into rec
 from khub_bot.raffle_reminders s join public.mystery_raffles r on r.id=s.raffle_id join public.profiles p on p.id=s.user_id
 where s.attempt is null and r.state='active' and r.ends_at>statement_timestamp()
 and r.ends_at-make_interval(mins=>s.reminder_minutes)>s.preference_set_at
 and r.ends_at-make_interval(mins=>s.reminder_minutes) between statement_timestamp()-interval '5 minutes' and statement_timestamp()
 and p.kol_player_id>0 and p.kol_verified_at is not null and not khub_bot.profile_is_restricted(s.user_id)
 and not khub_bot.profile_is_restricted(r.creator_id)
 order by r.ends_at,s.raffle_id limit 1 for update of s skip locked;
 if not found then return null; end if;
 update khub_bot.raffle_reminders set attempt=token,recipient_id=rec.kol_player_id,outcome='unknown' where user_id=rec.user_id and raffle_id=rec.raffle_id;
 return jsonb_build_object('id',token,'raffle_id',rec.raffle_id,'raffle_number',rec.raffle_number,'name',rec.name,
 'end_time',rec.ends_at,'recipient_id',rec.kol_player_id,'time_zone',rec.time_zone);
end;$$;
create function public.bot_start_raffle_reminder(p_attempt uuid) returns timestamptz language plpgsql security definer set search_path='' as $$
declare deadline timestamptz;
begin
 update khub_bot.raffle_reminders s set send_started=true from public.mystery_raffles r,public.profiles p
 where s.attempt=p_attempt and not s.send_started and r.id=s.raffle_id and r.state='active' and r.ends_at>statement_timestamp()
 and p.id=s.user_id and p.kol_player_id=s.recipient_id and p.kol_verified_at is not null
 and not khub_bot.profile_is_restricted(s.user_id) and not khub_bot.profile_is_restricted(r.creator_id)
 and r.ends_at-make_interval(mins=>s.reminder_minutes)>s.preference_set_at
 and r.ends_at-make_interval(mins=>s.reminder_minutes) between statement_timestamp()-interval '5 minutes' and statement_timestamp()
 returning r.ends_at into deadline;
 return deadline;
end;$$;
create function public.bot_ack_raffle_reminder(p_attempt uuid) returns void language sql security definer set search_path='' as $$
 update khub_bot.raffle_reminders set outcome='sent' where attempt=p_attempt;
$$;
revoke all on function public.read_raffle_reminder(uuid),public.set_raffle_reminder(uuid,integer,text),public.bot_claim_raffle_reminder(),public.bot_start_raffle_reminder(uuid),public.bot_ack_raffle_reminder(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_raffle_reminder(uuid),public.set_raffle_reminder(uuid,integer,text) to authenticated;
grant execute on function public.bot_claim_raffle_reminder(),public.bot_start_raffle_reminder(uuid),public.bot_ack_raffle_reminder(uuid) to service_role;
alter function public.bot_worker_status() rename to bot_worker_status_before_raffle_reminders;
create function public.bot_worker_status() returns jsonb language sql security definer set search_path='' as $$
 select public.bot_worker_status_before_raffle_reminders()||jsonb_build_object('raffleRemindersVersion',1);
$$;
revoke all on function public.bot_worker_status_before_raffle_reminders(),public.bot_worker_status() from public,anon,authenticated,service_role;
grant execute on function public.bot_worker_status() to service_role;
notify pgrst,'reload schema';
commit;
