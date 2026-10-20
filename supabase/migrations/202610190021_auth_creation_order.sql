-- Apply after 019 (020 is independent), with all workers stopped.
-- Supabase Admin createUser inserts auth.users BEFORE applying app_metadata.
-- The private, service-created reservation binds the exact generated user ID and
-- internal address at INSERT. Public signup cannot select its own user ID.
-- bot_finish_account_job still requires the final server-controlled request stamp
-- before it can queue credentials. Client-editable user_metadata is never trusted.
begin;
create or replace function public.kolauction_create_profile() returns trigger
language plpgsql security definer set search_path='' as $$
declare j khub_bot.account_jobs%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into j from khub_bot.account_jobs where user_id=new.id
        and action='register' and state='pending' for update;
    if not found or new.email is distinct from j.login_email
        or j.login_email is distinct from 'account-'||new.id||'@login.khub.invalid' then
        raise exception 'New accounts must be registered by KMail to kHub.';
    end if;
    -- A stamp already supplied by an Auth implementation must match. A missing
    -- stamp at INSERT is expected; finalization checks it after the API returns.
    if new.raw_app_meta_data->>'khub_account_job' is not null
        and new.raw_app_meta_data->>'khub_account_job' is distinct from j.mail_id then
        raise exception 'Account registration request stamp does not match.';
    end if;
    if khub_bot.account_is_banned(j.kol_player_id,j.username,j.kol_name) then
        raise exception 'Registration is not permitted for this identity.';
    end if;
    insert into public.profiles(id,khub_username,kol_player_id,kol_player_name,kol_verified_at,account_method)
        values(new.id,j.username,j.kol_player_id,j.kol_name,now(),'kmail');
    return new;
end; $$;
revoke all on function public.kolauction_create_profile() from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
