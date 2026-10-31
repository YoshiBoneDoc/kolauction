-- Apply after 202610300163_site_activity.sql to enable admin activity dropdowns.
begin;

create or replace function public.khub_site_activity_counts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
    if not coalesce(public.khub_is_administrator(), false) then
        raise exception 'Administrator access required' using errcode = '42501';
    end if;
    with active as (
        select distinct user_id, case when user_id is null then visitor_id end as guest_id
        from public.site_activity
        where last_seen >= now() - interval '2 minutes'
    ), signed_in as (
        select a.user_id as id, coalesce(p.khub_username, 'Unknown account') as username
        from active a
        left join public.profiles p on p.id = a.user_id
        where a.user_id is not null
    )
    select jsonb_build_object(
        'viewers', (select count(*) from active),
        'logged_in', (select count(*) from signed_in),
        'guests', (select count(*) from active where user_id is null),
        'users', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'username', username)
            order by lower(username), id) from signed_in), '[]'::jsonb)
    ) into result;
    return result;
end;
$$;

revoke all on function public.khub_site_activity_counts() from public, anon;
grant execute on function public.khub_site_activity_counts() to authenticated;

commit;
