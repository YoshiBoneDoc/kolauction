-- Admin-managed, plain-text public announcement. No asset or auction changes.
-- Apply after 088. New/re-published messages get a fresh dismissal revision.
begin;
create table khub_bot.site_banner (
    singleton boolean primary key default true check(singleton),
    revision uuid not null default gen_random_uuid(),
    message text not null default '' check(length(message)<=2000),
    active boolean not null default false,
    updated_at timestamptz not null default now(),
    updated_by uuid references public.profiles(id),
    check(not active or length(btrim(message))>0)
);
insert into khub_bot.site_banner(singleton) values(true);
alter table khub_bot.site_banner enable row level security;
revoke all on khub_bot.site_banner from public,anon,authenticated;

create function public.read_site_banner() returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_build_object('revision',revision,'message',message)
    from khub_bot.site_banner where active;
$$;
create function public.read_admin_site_banner() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
    if not khub_bot.is_administrator(auth.uid()) then
        raise exception 'Administrator access required.' using errcode='42501';
    end if;
    return (select to_jsonb(b)-'singleton'-'updated_by' from khub_bot.site_banner b);
end; $$;
create function public.save_site_banner(p_message text,p_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous khub_bot.site_banner%rowtype; clean_message text:=btrim(coalesce(p_message,''));
begin
    if not khub_bot.is_administrator(auth.uid()) then
        raise exception 'Administrator access required.' using errcode='42501';
    end if;
    if p_active is null or length(clean_message)>2000 or (p_active and clean_message='') then
        raise exception 'Enter a message of 1–2000 characters before publishing.';
    end if;
    select * into previous from khub_bot.site_banner where singleton for update;
    update khub_bot.site_banner b set message=clean_message,active=p_active,
        revision=case when p_active and (not previous.active or previous.message<>clean_message)
            then gen_random_uuid() else previous.revision end,
        updated_at=clock_timestamp(),updated_by=auth.uid() where b.singleton;
    return public.read_admin_site_banner();
end; $$;
revoke all on function public.read_site_banner() from public;
revoke all on function public.read_admin_site_banner() from public,anon;
revoke all on function public.save_site_banner(text,boolean) from public,anon;
grant execute on function public.read_site_banner() to anon,authenticated;
grant execute on function public.read_admin_site_banner(),public.save_site_banner(text,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
