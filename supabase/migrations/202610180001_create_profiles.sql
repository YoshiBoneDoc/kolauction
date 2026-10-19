-- Run once in the Supabase SQL Editor for this project.
-- Passwords and email addresses are managed by Supabase Auth, not this table.
begin;

create table public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    khub_username text not null,
    created_at timestamptz not null default now(),
    constraint profiles_username_length
        check (char_length(khub_username) between 1 and 16),
    constraint profiles_username_trimmed
        check (khub_username = btrim(khub_username))
);

-- Match the application's case-insensitive username uniqueness rule.
create unique index profiles_khub_username_unique
    on public.profiles (lower(khub_username));

alter table public.profiles enable row level security;

-- Set explicit grants even if automatic table exposure is enabled.
revoke all on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (khub_username) on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

create policy profiles_read_own
    on public.profiles for select to authenticated
    using ((select auth.uid()) = id);

create policy profiles_update_own
    on public.profiles for update to authenticated
    using ((select auth.uid()) = id)
    with check ((select auth.uid()) = id);

-- This trusted trigger creates profiles even when email confirmation means
-- the new user does not yet have an authenticated session.
create function public.kolauction_create_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, khub_username)
    values (new.id, btrim(new.raw_user_meta_data ->> 'khub_username'));
    return new;
end;
$$;

revoke all on function public.kolauction_create_profile()
    from public, anon, authenticated;

create trigger kolauction_auth_user_created
    after insert on auth.users
    for each row execute function public.kolauction_create_profile();

commit;
