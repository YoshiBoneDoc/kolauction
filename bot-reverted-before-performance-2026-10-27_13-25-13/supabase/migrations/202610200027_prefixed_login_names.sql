-- Apply after 026 and deploy the matching website login changes.
-- Login-only prefix: no profile names, passwords, jobs or queued/uncertain mail are rewritten.
begin;
create or replace function public.khub_login_address(p_username text) returns text
language sql stable security definer set search_path='' as $$
    select u.email from public.profiles p join auth.users u on u.id=p.id
    where p.account_method='kmail'
      and lower(btrim(p_username))=lower('KH_'||p.khub_username)
      and u.email='account-'||p.id||'@login.khub.invalid'
      and not khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name);
$$;

create or replace function public.bot_finish_account_job(p_mail_id text) returns void
language plpgsql security definer set search_path='' as $$
declare j khub_bot.account_jobs%rowtype; p public.profiles%rowtype; u auth.users%rowtype; body text; login text;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into j from khub_bot.account_jobs where mail_id=p_mail_id for update;
    if not found then raise exception 'Account job not found.'; end if;
    if j.state='done' then return; end if;
    if khub_bot.account_is_banned(j.kol_player_id,j.username,j.kol_name) then raise exception 'Account request restricted; operator review required.'; end if;
    select * into p from public.profiles where id=j.user_id;
    select * into u from auth.users where id=j.user_id;
    if p.kol_player_id is distinct from j.kol_player_id or u.email is distinct from j.login_email
       or u.raw_app_meta_data->>'khub_account_job' is distinct from j.mail_id then
        raise exception 'Account provisioning is not confirmed; do not send credentials.';
    end if;
    update public.profiles set kol_player_name=j.kol_name,kol_verified_at=coalesce(kol_verified_at,now())
        where id=j.user_id returning * into p;
    login:='KH_'||p.khub_username;
    body:=case when j.action='register' then E'Welcome to kHub!\n\nYour account is created and your KoL player is already verified.'
        else E'Your kHub login has been reset.\n\nYour previous password no longer works.' end
        ||E'\n\nkHub Username: '||login
        ||case when p.account_method='kmail' then '' else E'\nLegacy email login: '||j.login_email end
        ||E'\nTemporary password: '||j.temporary_password
        ||E'\n\nLog in on the kHub website. You can change this password from Your Account. Never use your KoL password on kHub.'
        ||E'\n\nKeep this message private. CREDENTIALS always generates a new password; it cannot retrieve an old password.';
    perform khub_bot.queue('account-credentials:'||j.mail_id,null,j.mail_id,j.kol_player_id,'notice',0,'[]',body);
    update khub_bot.deliveries set display_message=body where receipt_id=j.mail_id and dedupe_key like 'account-credentials:%';
    update khub_bot.account_jobs set state='done',temporary_password=null where mail_id=j.mail_id;
    update khub_bot.receipts set result='account_ready' where mail_id=j.mail_id;
end; $$;

-- CREATE OR REPLACE preserves the public lookup and service-only finish grants.
notify pgrst,'reload schema';
commit;
