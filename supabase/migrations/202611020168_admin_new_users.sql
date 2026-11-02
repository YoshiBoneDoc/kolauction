-- Administrator-only weekly registration count and bounded member list.
begin;
create index if not exists profiles_registration_idx on public.profiles(created_at desc,id desc);

create or replace function public.read_admin_new_users(p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
    cutoff timestamptz := statement_timestamp() - interval '7 days';
    result jsonb;
begin
    if not khub_bot.is_administrator(auth.uid()) then
        raise exception 'Administrator access required.' using errcode='42501';
    end if;
    if p_page is null or p_page < 1 or p_page > 100000 then
        raise exception 'Invalid page.' using errcode='22023';
    end if;
    select jsonb_build_object(
        'since',cutoff,'generated_at',statement_timestamp(),
        'total',(select count(*)::text from public.profiles where created_at >= cutoff and created_at <= statement_timestamp()),
        'users',(select coalesce(jsonb_agg(to_jsonb(u) order by u.created_at desc,u.id desc),'[]'::jsonb) from (
            select id,khub_username as username,created_at from public.profiles
            where created_at >= cutoff and created_at <= statement_timestamp()
            order by created_at desc,id desc limit 25 offset ((p_page-1)*25)
        ) u)
    ) into result;
    return result;
end; $$;
revoke all on function public.read_admin_new_users(integer) from public,anon,authenticated;
grant execute on function public.read_admin_new_users(integer) to authenticated;
notify pgrst,'reload schema';
commit;
