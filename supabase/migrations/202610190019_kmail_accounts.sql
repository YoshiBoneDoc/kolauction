-- Apply after 018 with ALL workers stopped; deploy the matching bot and website.
-- New accounts are created only by Supabase Admin API for a verified KMail job.
-- Existing accounts/history remain intact. No real email or SMTP is needed for new accounts.
begin;
alter table public.profiles add column account_method text not null default 'email'
    check (account_method in ('email','kmail')),
    add column is_banned boolean not null default false;

-- New verified identities use their KoL names. Existing test accounts are left alone.
alter table public.profiles drop constraint profiles_username_length;
alter table public.profiles add constraint profiles_username_length
    check (char_length(khub_username) between 1 and 128);
revoke update (khub_username) on public.profiles from authenticated;

create table khub_bot.account_bans (
    id bigint generated always as identity primary key,
    kol_player_id bigint check (kol_player_id>0),
    username text,
    reason text not null,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    check (kol_player_id is not null or coalesce(length(btrim(username)),0)>0)
);
create table khub_bot.account_jobs (
    mail_id text primary key references khub_bot.receipts(mail_id),
    kol_player_id bigint not null,
    kol_name text not null,
    user_id uuid not null,
    username text not null,
    login_email text not null,
    action text not null check (action in ('register','credentials')),
    state text not null default 'pending' check (state in ('pending','done')),
    temporary_password text,
    created_at timestamptz not null default now(),
    check (state='done' or length(temporary_password)>=24)
);
create unique index account_jobs_pending_player on khub_bot.account_jobs(kol_player_id) where state='pending';
create unique index account_jobs_pending_username on khub_bot.account_jobs(lower(username)) where state='pending' and action='register';
alter table khub_bot.account_bans enable row level security;
alter table khub_bot.account_jobs enable row level security;
revoke all on khub_bot.account_bans,khub_bot.account_jobs from public,anon,authenticated;
grant all on khub_bot.account_bans,khub_bot.account_jobs to service_role;
grant usage on sequence khub_bot.account_bans_id_seq to service_role;

create function khub_bot.account_is_banned(p_player bigint,p_username text,p_kol_name text) returns boolean
language sql stable set search_path='' as $$
    select exists(select 1 from khub_bot.account_bans b where b.active and (
        b.kol_player_id=p_player or lower(btrim(b.username)) in (lower(btrim(p_username)),lower(btrim(p_kol_name)))))
      or exists(select 1 from public.profiles p join auth.users u on u.id=p.id
        where p.kol_player_id=p_player and (p.is_banned or u.banned_until>now()));
$$;

create function khub_bot.apply_account_ban() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if new.active then
        update public.profiles set is_banned=true where kol_player_id=new.kol_player_id
            or lower(khub_username)=lower(btrim(new.username)) or lower(kol_player_name)=lower(btrim(new.username));
    end if;
    return new;
end; $$;
create trigger account_bans_apply after insert or update on khub_bot.account_bans
    for each row execute function khub_bot.apply_account_ban();

create function khub_bot.record_profile_ban() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if new.is_banned and not old.is_banned and not exists(select 1 from khub_bot.account_bans
        where active and (kol_player_id=new.kol_player_id or lower(username)=lower(new.khub_username))) then
        insert into khub_bot.account_bans(kol_player_id,username,reason)
            values(new.kol_player_id,new.khub_username,'Account restricted by operator.');
    end if;
    return new;
end; $$;
create trigger profiles_record_ban after update of is_banned on public.profiles
    for each row execute function khub_bot.record_profile_ban();

create function khub_bot.guard_internal_login_address() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if new.email is distinct from old.email and exists(select 1 from public.profiles where id=old.id and account_method='kmail') then
        raise exception 'The internal kHub login address cannot be changed.';
    end if;
    return new;
end; $$;
create trigger auth_guard_internal_login_address before update of email on auth.users
    for each row execute function khub_bot.guard_internal_login_address();

-- The reserved job and server-controlled app_metadata authorize account creation.
-- Client-editable user_metadata alone cannot authorize or link a new account.
create or replace function public.kolauction_create_profile() returns trigger
language plpgsql security definer set search_path='' as $$
declare j khub_bot.account_jobs%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into j from khub_bot.account_jobs where user_id=new.id and action='register' and state='pending' for update;
    if not found or new.raw_app_meta_data->>'khub_account_job' is distinct from j.mail_id
        or new.email is distinct from j.login_email then
        raise exception 'New accounts must be registered by KMail to kHub.';
    end if;
    if khub_bot.account_is_banned(j.kol_player_id,j.username,j.kol_name) then raise exception 'Registration is not permitted for this identity.'; end if;
    insert into public.profiles(id,khub_username,kol_player_id,kol_player_name,kol_verified_at,account_method)
        values(new.id,j.username,j.kol_player_id,j.kol_name,now(),'kmail');
    return new;
end; $$;

-- Protect a reserved username from concurrent profile edits and prevent use of
-- banned names. Only trusted verification fields can establish a display name.
create function khub_bot.guard_account_username() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    new.khub_username:=case when new.kol_player_id is not null and new.kol_verified_at is not null
        and nullif(btrim(new.kol_player_name),'') is not null then btrim(new.kol_player_name)
        else '[Unverified '||new.id||']' end;
    if khub_bot.account_is_banned(new.kol_player_id,new.khub_username,new.kol_player_name) then
        raise exception 'This account or username is restricted.';
    end if;
    if exists(select 1 from khub_bot.account_jobs j where j.state='pending' and j.action='register'
        and lower(j.username)=lower(new.khub_username) and j.user_id<>new.id) then
        raise exception 'That username is reserved by a pending registration.';
    end if;
    return new;
end; $$;
create trigger profiles_guard_account_username before insert or update of khub_username,kol_player_id,kol_player_name,kol_verified_at on public.profiles
    for each row execute function khub_bot.guard_account_username();

-- Only generated internal addresses may be resolved by a public username lookup.
-- Never disclose an existing user's real email through this endpoint.
create function public.khub_login_address(p_username text) returns text
language sql stable security definer set search_path='' as $$
    select u.email from public.profiles p join auth.users u on u.id=p.id
    where p.account_method='kmail' and lower(p.khub_username)=lower(btrim(p_username))
      and u.email='account-'||p.id||'@login.khub.invalid'
      and not khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name);
$$;

create function khub_bot.account_reply(p_mail jsonb,p_body text,p_result text) returns void
language plpgsql set search_path='' as $$
declare mid text:=p_mail->>'id';
begin
    insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result)
        values(mid,(p_mail->>'sender_id')::bigint,(p_mail->>'received_at')::timestamptz,p_mail,p_result);
    perform khub_bot.queue('account-reply:'||mid,null,mid,(p_mail->>'sender_id')::bigint,
        case when (p_mail->>'meat')::bigint>0 or jsonb_array_length(p_mail->'items')>0 then 'refund' else 'notice' end,
        (p_mail->>'meat')::bigint,p_mail->'items',p_body);
    update khub_bot.deliveries set display_message=p_body where receipt_id=mid and dedupe_key like 'account-reply:%';
end; $$;

create function public.bot_prepare_account_mail(p_mail jsonb,p_password text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare mid text:=p_mail->>'id'; sid bigint; cmd text:=p_mail#>>'{command,type}'; uname text;
    prior khub_bot.receipts%rowtype; j khub_bot.account_jobs%rowtype; p public.profiles%rowtype;
    uid uuid; address text; why text;
begin
    perform pg_advisory_xact_lock(3888760);
    if cmd is null or cmd not in ('register','credentials') or mid is null or mid !~ '^[1-9][0-9]*$'
       or p_mail#>>'{raw,type}' is distinct from 'normal'
       or p_mail#>>'{raw,id}' is distinct from mid
       or p_mail#>>'{raw,fromid}' is distinct from p_mail->>'sender_id'
       or p_mail#>>'{raw,fromname}' is distinct from p_mail->>'sender_name' then
        raise exception 'Invalid KMail account identity.';
    end if;
    sid:=(p_mail->>'sender_id')::bigint;
    if sid<=0 or sid=3888760 then raise exception 'Invalid KMail account sender.'; end if;
    select * into prior from khub_bot.receipts where mail_id=mid;
    if found then
        if prior.payload<>p_mail then raise exception 'KMail payload changed; inspect before retrying.'; end if;
        select * into j from khub_bot.account_jobs where mail_id=mid;
        return case when j.state='pending' then to_jsonb(j) else jsonb_build_object('state','done') end;
    end if;
    if coalesce((p_mail->>'meat')::bigint,-1)<0 or jsonb_typeof(p_mail->'items') is distinct from 'array' then
        raise exception 'Invalid account request attachments.';
    end if;
    select * into p from public.profiles where kol_player_id=sid;
    uname:=btrim(p_mail->>'sender_name');
    if (p_mail->>'meat')::bigint>0 or jsonb_array_length(p_mail->'items')>0 then
        why:='Registration and recovery must contain no Meat or items. Your attachments are returned. Send REGISTER or CREDENTIALS in a new, empty KMail.';
    elsif p_mail->'command' ? 'username' or coalesce((p_mail#>>'{command,invalid_format}')::boolean,false) then
        why:='Send REGISTER by itself, without a username. Your kHub username comes from your verified KoL character name.';
    elsif khub_bot.account_is_banned(sid,coalesce(p.khub_username,uname),p_mail->>'sender_name')
        or khub_bot.account_is_banned(sid,uname,p_mail->>'sender_name') then
        why:='This KoL account or username is restricted from registering or recovering access. Please contact teres minor (#3552305).';
    elsif cmd='register' and p.id is not null then
        why:='This KoL player already has a kHub account. Send CREDENTIALS from this same KoL account to receive your username and a new temporary password.';
    elsif exists(select 1 from khub_bot.account_jobs where kol_player_id=sid and state='pending')
       or exists(select 1 from khub_bot.deliveries where recipient_id=sid and dedupe_key like 'account-credentials:%' and state<>'sent') then
        why:='An account request is already being processed. Please wait for its reply; do not send another request.';
    elsif exists(select 1 from khub_bot.account_jobs where kol_player_id=sid and created_at>now()-interval '5 minutes') then
        why:='Please wait five minutes between account requests. Check your recent kHub KMail for your login details.';
    elsif cmd='credentials' and p.id is null then
        why:='No kHub account is linked to this KoL player. Send REGISTER to create one. If you already have an older email account, log in and link it first, or contact support; do not create a duplicate.';
    elsif cmd='register' and (uname is null or length(uname) not between 1 and 128 or uname ~ '[[:cntrl:]]') then
        why:='Your KoL name could not be used. Please contact teres minor (#3552305); do not send a different name.';
    elsif cmd='register' and (exists(select 1 from public.profiles where lower(khub_username)=lower(uname))
        or exists(select 1 from khub_bot.account_jobs where state='pending' and lower(username)=lower(uname))) then
        why:='This verified KoL name conflicts with an existing or pending account. Please contact teres minor (#3552305).';
    end if;
    if why is not null then
        perform khub_bot.account_reply(p_mail,why,'account_rejected');
        return jsonb_build_object('state','done');
    end if;
    if length(coalesce(p_password,''))<24 then raise exception 'Generate a strong temporary password.'; end if;
    uid:=coalesce(p.id,gen_random_uuid());
    if cmd='credentials' then
        select email into address from auth.users where id=p.id;
    else address:='account-'||uid||'@login.khub.invalid'; end if;
    if address is null then raise exception 'Account login identity missing; manual support required.'; end if;
    insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result)
        values(mid,sid,(p_mail->>'received_at')::timestamptz,p_mail,'account_pending');
    insert into khub_bot.account_jobs(mail_id,kol_player_id,kol_name,user_id,username,login_email,action,temporary_password)
        values(mid,sid,p_mail->>'sender_name',uid,uname,address,cmd,p_password) returning * into j;
    return to_jsonb(j);
end; $$;

-- Bans also apply to existing sessions; hiding a UI control alone is insufficient.
create function khub_bot.guard_banned_actor() returns trigger
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype;
begin
    if auth.uid() is not null then
        select * into p from public.profiles where id=auth.uid();
        if p.is_banned or khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name) then
            raise exception 'This kHub account is restricted.';
        end if;
    end if;
    return new;
end; $$;
create trigger auctions_guard_banned_actor before insert or update on public.auctions
    for each row execute function khub_bot.guard_banned_actor();
create trigger bids_guard_banned_actor before insert or update on public.bids
    for each row execute function khub_bot.guard_banned_actor();

alter function public.bot_ingest_mail(jsonb) set schema khub_bot;
alter function khub_bot.bot_ingest_mail(jsonb) rename to ingest_before_accounts;
create function public.bot_ingest_mail(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype;
begin
    -- Replays keep the original payload comparison and outcome.
    if exists(select 1 from khub_bot.receipts where mail_id=p_mail->>'id') then
        return khub_bot.ingest_before_accounts(p_mail);
    end if;
    select * into p from public.profiles where kol_player_id=(p_mail->>'sender_id')::bigint;
    if khub_bot.account_is_banned((p_mail->>'sender_id')::bigint,p.khub_username,p_mail->>'sender_name') then
        perform pg_advisory_xact_lock(3888760);
        perform khub_bot.account_reply(p_mail,'Your kHub account is restricted. Your attached assets are returned. Contact support for review.','account_rejected');
        return 'Account restricted.';
    end if;
    return khub_bot.ingest_before_accounts(p_mail);
end; $$;

-- Validate identity/bans immediately before each Admin API attempt, including
-- retries. Password provisioning is idempotent using the same job ID/secret.
create function public.bot_check_account_job(p_mail_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j khub_bot.account_jobs%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into j from khub_bot.account_jobs where mail_id=p_mail_id;
    if not found then raise exception 'Account job not found.'; end if;
    if j.state='pending' and khub_bot.account_is_banned(j.kol_player_id,j.username,j.kol_name) then
        perform khub_bot.queue('account-reply:'||j.mail_id,null,j.mail_id,j.kol_player_id,'notice',0,'[]','Account request restricted. Contact teres minor (#3552305) for review.');
        update khub_bot.deliveries set display_message=message where receipt_id=j.mail_id and dedupe_key like 'account-reply:%';
        update khub_bot.receipts set result='account_rejected' where mail_id=j.mail_id;
        update khub_bot.account_jobs set state='done',temporary_password=null where mail_id=j.mail_id returning * into j;
    end if;
    return to_jsonb(j);
end; $$;

create function public.bot_finish_account_job(p_mail_id text) returns void
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
    login:=case when p.account_method='kmail' then p.khub_username else j.login_email end;
    body:=case when j.action='register' then E'Welcome to kHub!\n\nYour account is created and your KoL player is already verified.'
        else E'Your kHub login has been reset.\n\nYour previous password no longer works.' end
        ||E'\n\nUsername: '||p.khub_username||E'\nLog in with: '||login||E'\nTemporary password: '||j.temporary_password
        ||E'\n\nLog in on the kHub website. You can change this password from Your Account. Never use your KoL password on kHub.'
        ||E'\n\nKeep this message private. CREDENTIALS always generates a new password; it cannot retrieve an old password.';
    perform khub_bot.queue('account-credentials:'||j.mail_id,null,j.mail_id,j.kol_player_id,'notice',0,'[]',body);
    update khub_bot.deliveries set display_message=body where receipt_id=j.mail_id and dedupe_key like 'account-credentials:%';
    update khub_bot.account_jobs set state='done',temporary_password=null where mail_id=j.mail_id;
    update khub_bot.receipts set result='account_ready' where mail_id=j.mail_id;
end; $$;

-- Keep the exact body while a send is uncertain, but remove the generated secret
-- from the database after a positive acknowledgment/manual sent reconciliation.
-- The saved KoL sent copy, delivery reference and response hash remain evidence.
create function khub_bot.scrub_sent_credentials() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if new.state='sent' and new.dedupe_key like 'account-credentials:%' then
        update khub_bot.deliveries set message='Credential reply delivered; temporary password removed.',
            display_message='Credential reply delivered; temporary password removed.' where id=new.id;
    end if;
    return new;
end; $$;
create trigger deliveries_scrub_credentials after update of state on khub_bot.deliveries
    for each row execute function khub_bot.scrub_sent_credentials();

-- Retain existing cleanup rules, adding successful account mail only after reply delivery.
create function public.bot_pending_account_requests() returns jsonb
language sql stable security definer set search_path='' as $$
    select coalesce(jsonb_agg(r.payload order by j.created_at,j.mail_id),'[]'::jsonb)
    from khub_bot.account_jobs j join khub_bot.receipts r on r.mail_id=j.mail_id where j.state='pending';
$$;

alter function public.bot_mail_cleanup(text[]) set schema khub_bot;
alter function khub_bot.bot_mail_cleanup(text[]) rename to cleanup_before_accounts;
create function public.bot_mail_cleanup(p_mail_ids text[]) returns jsonb
language sql security definer set search_path='' as $$
    select khub_bot.cleanup_before_accounts(p_mail_ids)||coalesce((
        select jsonb_agg(r.mail_id order by r.mail_id) from khub_bot.receipts r
        where r.mail_id=any(p_mail_ids) and r.result='account_ready'
          and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id and d.state<>'sent')
    ),'[]'::jsonb);
$$;

-- Never print a temporary password through the routine inspection report.
alter function public.bot_inspect() set schema khub_bot;
alter function khub_bot.bot_inspect() rename to inspect_before_accounts;
create function public.bot_inspect() returns jsonb
language sql security definer set search_path='' as $$
    select jsonb_set(khub_bot.inspect_before_accounts(),'{attention}',coalesce((
        select jsonb_agg(case when d.dedupe_key like 'account-credentials:%'
            then khub_bot.delivery_details(d)-'message'-'display_message'-'display_footer'
            else khub_bot.delivery_details(d) end)
        from khub_bot.deliveries d where d.state in ('sending','unknown')
    ),'[]'::jsonb))||jsonb_build_object('accountRequestsPending',(select count(*) from khub_bot.account_jobs where state='pending'),
        'accountAttention',(select coalesce(jsonb_agg(jsonb_build_object('mail_id',mail_id,'kol_player_id',kol_player_id,'username',username,'action',action)),'[]'::jsonb)
            from khub_bot.account_jobs where state='pending'));
$$;
alter function public.bot_lookup_delivery(text) set schema khub_bot;
alter function khub_bot.bot_lookup_delivery(text) rename to lookup_before_accounts;
create function public.bot_lookup_delivery(p_reference text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d jsonb;
begin
    d:=khub_bot.lookup_before_accounts(p_reference);
    if d->>'dedupe_key' like 'account-credentials:%' then
        return d-'message'-'display_message'-'display_footer';
    end if;
    return d;
end; $$;
revoke all on function khub_bot.account_is_banned(bigint,text,text),khub_bot.apply_account_ban(),khub_bot.record_profile_ban(),
    khub_bot.guard_internal_login_address(),khub_bot.guard_account_username(),
    khub_bot.scrub_sent_credentials(),
    khub_bot.guard_banned_actor(),khub_bot.ingest_before_accounts(jsonb),khub_bot.lookup_before_accounts(text),
    khub_bot.account_reply(jsonb,text,text),khub_bot.cleanup_before_accounts(text[]),khub_bot.inspect_before_accounts()
    from public,anon,authenticated;
revoke all on function public.bot_prepare_account_mail(jsonb,text),public.bot_check_account_job(text),
    public.bot_finish_account_job(text),public.bot_pending_account_requests(),public.bot_mail_cleanup(text[]),public.bot_inspect(),public.bot_ingest_mail(jsonb),public.bot_lookup_delivery(text) from public,anon,authenticated;
grant execute on function public.bot_prepare_account_mail(jsonb,text),public.bot_check_account_job(text),
    public.bot_finish_account_job(text),public.bot_pending_account_requests(),public.bot_mail_cleanup(text[]),public.bot_inspect(),public.bot_ingest_mail(jsonb),public.bot_lookup_delivery(text) to service_role;
revoke all on function public.khub_login_address(text) from public,anon,authenticated;
grant execute on function public.khub_login_address(text) to anon,authenticated;
revoke all on function public.registration_conflicts(text,text) from anon,authenticated;
notify pgrst,'reload schema';
commit;
