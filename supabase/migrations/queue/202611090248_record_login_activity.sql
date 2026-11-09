-- Apply after 247/246. Requires standard Supabase auth.sessions and auth.mfa_amr_claims.
-- No audit-log storage, backfill, bot restart or browser login callback required.
-- Captures committed password-authenticated sessions, matching this site's sign-in method.
-- This trigger participates in Auth transactions: verify a login after application.
begin;
create table khub_bot.login_recording(id boolean primary key default true check(id),started_at timestamptz not null);
insert into khub_bot.login_recording values(true,clock_timestamp());
create table khub_bot.login_events(
 session_id uuid primary key,
 account_id uuid not null,
 logged_in_at timestamptz not null
);
-- No session FK: logging out or Auth session cleanup must not erase history.
create index login_events_time_idx on khub_bot.login_events(logged_in_at) include(account_id);
alter table khub_bot.login_events enable row level security;
alter table khub_bot.login_recording enable row level security;
revoke all on table khub_bot.login_events from public;
revoke all on table khub_bot.login_events from anon;
revoke all on table khub_bot.login_events from authenticated;
revoke all on table khub_bot.login_recording from public;
revoke all on table khub_bot.login_recording from anon;
revoke all on table khub_bot.login_recording from authenticated;
create function khub_bot.record_password_login() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into khub_bot.login_events(session_id,account_id,logged_in_at)
 select new.session_id,s.user_id,statement_timestamp() from auth.sessions s where s.id=new.session_id
 on conflict(session_id) do nothing;
 -- Small indexed cleanup batches; no full-table deletion or global maintenance lock.
 delete from khub_bot.login_events where session_id in (
   select session_id from khub_bot.login_events
   where logged_in_at<statement_timestamp()-interval '744 hours'
   order by logged_in_at limit 100 for update skip locked
 );
 return new;
end;$$;
revoke all on function khub_bot.record_password_login() from public;
revoke all on function khub_bot.record_password_login() from anon;
revoke all on function khub_bot.record_password_login() from authenticated;
create trigger khub_record_password_login after insert on auth.mfa_amr_claims
 for each row when (new.authentication_method='password') execute function khub_bot.record_password_login();
create or replace function public.read_admin_new_users(p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
    cutoff timestamptz := statement_timestamp() - interval '168 hours';
    result jsonb;
    counts jsonb;
    activity jsonb;
begin
    if not khub_bot.is_administrator(auth.uid()) then
        raise exception 'Administrator access required.' using errcode='42501';
    end if;
    if p_page is null or p_page < 1 or p_page > 100000 then
        raise exception 'Invalid page.' using errcode='22023';
    end if;
    select jsonb_build_object(
        'status','recording','recording_since',(select started_at from khub_bot.login_recording where id),
        'unique_users',jsonb_build_array(count(*) filter(where n24>0)::text,count(*) filter(where n7>0)::text,count(*)::text),
        'total_logins',jsonb_build_array(coalesce(sum(n24),0)::text,coalesce(sum(n7),0)::text,coalesce(sum(n30),0)::text)
    ) into activity from (
        select account_id,
            count(*) filter(where logged_in_at>=statement_timestamp()-interval '24 hours') n24,
            count(*) filter(where logged_in_at>=statement_timestamp()-interval '168 hours') n7,
            count(*) n30
        from khub_bot.login_events
        where logged_in_at>=statement_timestamp()-interval '720 hours' and logged_in_at<=statement_timestamp()
        group by account_id
    ) accounts;
    -- One indexed, time-bounded pass for all registration intervals.
    select jsonb_build_array(
        count(*) filter (where created_at >= statement_timestamp() - interval '24 hours')::text,
        count(*) filter (where created_at >= cutoff)::text,
        count(*)::text
    ) into counts
    from public.profiles
    where created_at >= statement_timestamp() - interval '720 hours'
      and created_at <= statement_timestamp();
    select jsonb_build_object(
        'since',cutoff,'generated_at',statement_timestamp(),
        'total',counts->>1,
        'registration_counts',counts,
        'login_activity',activity,
        'users',(select coalesce(jsonb_agg(to_jsonb(u) order by u.created_at desc,u.id desc),'[]'::jsonb) from (
            select id,khub_username as username,created_at from public.profiles
            where created_at >= cutoff and created_at <= statement_timestamp()
            order by created_at desc,id desc limit 25 offset ((p_page-1)*25)
        ) u)
    ) into result;
    return result;
end; $$;
revoke all on function public.read_admin_new_users(integer) from public;
revoke all on function public.read_admin_new_users(integer) from anon;
revoke all on function public.read_admin_new_users(integer) from authenticated;
grant execute on function public.read_admin_new_users(integer) to authenticated;
notify pgrst,'reload schema';
commit;
