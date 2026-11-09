-- After 248. Site visits replace login analytics; no browser cadence changes.
-- Run in Supabase SQL Editor as database owner. No bot restart.
begin;
create table khub_bot.visit_recording(id boolean primary key check(id),started_at timestamptz not null);
insert into khub_bot.visit_recording values(true,clock_timestamp());
create table khub_bot.site_visits(
 id uuid primary key default gen_random_uuid(), identity_key text not null,
 account_id uuid, started_at timestamptz not null,last_seen timestamptz not null
);
create index site_visits_identity_idx on khub_bot.site_visits(identity_key,last_seen desc);
create index site_visits_time_idx on khub_bot.site_visits(last_seen);
alter table khub_bot.site_visits enable row level security;
alter table khub_bot.visit_recording enable row level security;
revoke all on table khub_bot.site_visits from public;
revoke all on table khub_bot.site_visits from anon;
revoke all on table khub_bot.site_visits from authenticated;
revoke all on table khub_bot.visit_recording from public;
revoke all on table khub_bot.visit_recording from anon;
revoke all on table khub_bot.visit_recording from authenticated;
create or replace function public.khub_record_site_activity(p_visitor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); ident text; previous khub_bot.site_visits%rowtype; observed timestamptz;
begin
 if p_visitor_id is null then raise exception 'Visitor ID required'; end if;
 ident:=case when actor is null then 'guest:'||p_visitor_id::text else 'account:'||actor::text end;
 -- Serialize only this identity; signed-in visits coalesce across tabs/devices.
 perform pg_advisory_xact_lock(hashtextextended(ident,3888788));
 observed:=clock_timestamp();
 insert into public.site_activity(visitor_id,user_id,last_seen) values(p_visitor_id,actor,observed)
 on conflict(visitor_id) do update set user_id=excluded.user_id,last_seen=excluded.last_seen;
 select * into previous from khub_bot.site_visits where identity_key=ident order by last_seen desc limit 1;
 if not found or previous.last_seen<=observed-interval '30 minutes' then
   insert into khub_bot.site_visits(identity_key,account_id,started_at,last_seen) values(ident,actor,observed,observed);
 else
   update khub_bot.site_visits set last_seen=observed where id=previous.id;
 end if;
 delete from khub_bot.site_visits where id in (
   select id from khub_bot.site_visits where last_seen<observed-interval '744 hours'
   order by last_seen limit 50 for update skip locked
 );
end;$$;
revoke all on function public.khub_record_site_activity(uuid) from public;
grant execute on function public.khub_record_site_activity(uuid) to anon;
grant execute on function public.khub_record_site_activity(uuid) to authenticated;
-- The old tally is retained, but no further Auth-path writes are needed.
-- Supabase owns Auth tables. Retire our function without ALTER TABLE privileges.
create or replace function khub_bot.record_password_login() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 return new;
end;$$;
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
        'status','recording','recording_since',(select started_at from khub_bot.visit_recording where id),
        'unique_users',jsonb_build_array(count(distinct account_id) filter(where last_seen>=statement_timestamp()-interval '24 hours')::text,count(distinct account_id) filter(where last_seen>=statement_timestamp()-interval '168 hours')::text,count(distinct account_id)::text),
        'total_visits',jsonb_build_array(count(*) filter(where account_id is not null and started_at>=statement_timestamp()-interval '24 hours')::text,count(*) filter(where account_id is not null and started_at>=statement_timestamp()-interval '168 hours')::text,count(*) filter(where account_id is not null and started_at>=statement_timestamp()-interval '720 hours')::text),
        'guest_visitors',jsonb_build_array(count(distinct identity_key) filter(where account_id is null and last_seen>=statement_timestamp()-interval '24 hours')::text,count(distinct identity_key) filter(where account_id is null and last_seen>=statement_timestamp()-interval '168 hours')::text,count(distinct identity_key) filter(where account_id is null)::text),
        'guest_visits',jsonb_build_array(count(*) filter(where account_id is null and started_at>=statement_timestamp()-interval '24 hours')::text,count(*) filter(where account_id is null and started_at>=statement_timestamp()-interval '168 hours')::text,count(*) filter(where account_id is null and started_at>=statement_timestamp()-interval '720 hours')::text)
    ) into activity from khub_bot.site_visits
    where last_seen>=statement_timestamp()-interval '720 hours' and last_seen<=statement_timestamp();
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
        'site_activity',activity,
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
