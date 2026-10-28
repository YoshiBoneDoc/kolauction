-- Apply after 019. Publishing a portrait is an explicit operator decision.
begin;
create table khub_bot.ban_publications (
    id uuid primary key default gen_random_uuid(),
    ban_id bigint not null unique references khub_bot.account_bans(id) on delete cascade,
    kol_player_name text not null check (length(btrim(kol_player_name)) between 1 and 128),
    public_reason text not null check (length(btrim(public_reason)) between 1 and 600),
    banned_at timestamptz not null default now(),
    expires_at timestamptz,
    published_at timestamptz not null default now(),
    check (expires_at is null or expires_at>banned_at)
);
alter table khub_bot.ban_publications enable row level security;
revoke all on khub_bot.ban_publications from public,anon,authenticated;
grant all on khub_bot.ban_publications to service_role;

-- Publish only the fields intended for public viewing. Never return private ban
-- reasons, Auth identifiers, email addresses, receipts or KMail.
create function public.khub_wall_of_shame(p_offset integer default 0,p_limit integer default 24)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if p_offset is null or p_offset<0 or p_offset>100000
       or p_limit is null or p_limit<1 or p_limit>48 then
        raise exception 'Invalid gallery page.';
    end if;
    with published as (
        select p.id,p.kol_player_name,b.kol_player_id,p.public_reason,p.banned_at,p.expires_at
        from khub_bot.ban_publications p join khub_bot.account_bans b on b.id=p.ban_id
        where b.active and b.kol_player_id is not null and p.published_at<=now()
            and (p.expires_at is null or p.expires_at>now())
    ), page as (
        select * from published order by banned_at desc,id limit p_limit offset p_offset
    )
    select jsonb_build_object('total',(select count(*) from published),
        'entries',coalesce((select jsonb_agg(to_jsonb(page) order by banned_at desc,id) from page),'[]'::jsonb)) into result;
    return result;
end; $$;
revoke all on function public.khub_wall_of_shame(integer,integer) from public;
grant execute on function public.khub_wall_of_shame(integer,integer) to anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
