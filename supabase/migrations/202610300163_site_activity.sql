-- Admin-only aggregate presence. Apply in the Supabase SQL Editor.
begin;

create table public.site_activity (
    visitor_id uuid primary key,
    user_id uuid,
    last_seen timestamptz not null default now()
);
create index site_activity_last_seen_idx on public.site_activity(last_seen);
alter table public.site_activity enable row level security;
revoke all on public.site_activity from public, anon, authenticated;

create or replace function public.khub_record_site_activity(p_visitor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
    if p_visitor_id is null then
        raise exception 'Visitor ID required';
    end if;
    insert into public.site_activity(visitor_id, user_id, last_seen)
    values (p_visitor_id, auth.uid(), now())
    on conflict (visitor_id) do update
    set user_id = excluded.user_id, last_seen = excluded.last_seen;
    -- Keep only recent presence, rather than retaining a browsing history.
    delete from public.site_activity where last_seen < now() - interval '5 minutes';
end;
$$;

create or replace function public.khub_site_activity_counts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
    if not coalesce(public.khub_is_administrator(), false) then
        raise exception 'Administrator access required' using errcode = '42501';
    end if;
    select jsonb_build_object(
        'viewers', count(distinct coalesce(user_id, visitor_id)),
        'logged_in', count(distinct user_id)
    ) into result
    from public.site_activity
    where last_seen >= now() - interval '2 minutes';
    return result;
end;
$$;

revoke all on function public.khub_record_site_activity(uuid) from public;
revoke all on function public.khub_site_activity_counts() from public, anon;
grant execute on function public.khub_record_site_activity(uuid) to anon, authenticated;
grant execute on function public.khub_site_activity_counts() to authenticated;

commit;
