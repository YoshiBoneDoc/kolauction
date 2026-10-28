-- Apply after 021 with all workers stopped. Existing passwords/jobs stay valid.
begin;
alter table khub_bot.account_jobs drop constraint account_jobs_check;
alter table khub_bot.account_jobs add constraint account_jobs_password_check
    check (state='done' or (temporary_password is not null and length(temporary_password)>=16));

create or replace function public.bot_prepare_account_mail(p_mail jsonb,p_password text) returns jsonb
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
    if length(coalesce(p_password,''))<16 then raise exception 'Generate a strong temporary password.'; end if;
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

-- CREATE OR REPLACE retains the existing service-only function grants.
notify pgrst,'reload schema';
commit;
