-- Apply after 058, then deploy the matching bot. Failed account jobs continue
-- retrying; each receives at most one player notice and one admin inbox/KMail alert.
-- New registrations may not have a profile yet: system reports have no human
-- reporter. Null-safe retry checks keep system report IDs private/unclaimable.
begin;
alter table khub_bot.bug_reports add column is_system boolean not null default false,
    alter column reporter_id drop not null,
    add constraint bug_reports_system_reporter_check check ((reporter_id is null)=is_system);
create table khub_bot.account_failure_notices (
    mail_id text primary key references khub_bot.account_jobs(mail_id),
    report_id uuid not null unique references khub_bot.bug_reports(id),
    notified_player boolean not null,
    created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.account_failure_notices enable row level security;
revoke all on khub_bot.account_failure_notices from public,anon,authenticated;
grant all on khub_bot.account_failure_notices to service_role;

do $$
declare identity text; definition text;
begin
    foreach identity in array array[
        'public.submit_bug_report(uuid,text)',
        'public.submit_ban_appeal(uuid,text)',
        'public.submit_support_ticket(uuid,text)',
        'public.submit_trade_query(uuid,uuid,text)',
        'public.submit_trade_report(uuid,uuid,text)'
    ] loop
        definition:=pg_get_functiondef(identity::regprocedure);
        if strpos(definition,'r.reporter_id<>actor.id')=0 then
            raise exception 'Unexpected report ownership guard: %',identity;
        end if;
        execute replace(definition,'r.reporter_id<>actor.id','r.reporter_id is distinct from actor.id');
    end loop;
end; $$;

create function public.bot_notify_account_failure(p_mail_id text,p_notify_player boolean default true) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    j khub_bot.account_jobs%rowtype; r khub_bot.bug_reports%rowtype;
    prior khub_bot.account_failure_notices%rowtype;
    player_message text; administrator_message text; body text; delivery uuid; task text;
begin
    if p_mail_id is null or p_mail_id!~'^[1-9][0-9]*$' or p_notify_player is null then
        raise exception 'Choose a valid account request.';
    end if;
    perform pg_advisory_xact_lock(3888760);
    select * into j from khub_bot.account_jobs where mail_id=p_mail_id for update;
    if not found then return jsonb_build_object('status','unrecorded'); end if;
    select * into prior from khub_bot.account_failure_notices where mail_id=j.mail_id;
    if found then return jsonb_build_object('status','already_queued','reference',(
        select 'B-'||b.report_number from khub_bot.bug_reports b where b.id=prior.report_id)); end if;
    -- A lost completion acknowledgment must not send an error after credentials
    -- were already queued. Rejections/bans also have their own existing replies.
    if j.state<>'pending' then return jsonb_build_object('status','not_pending'); end if;
    if khub_bot.account_is_banned(j.kol_player_id,j.username,j.kol_name) then
        return jsonb_build_object('status','restricted');
    end if;
    task:=case j.action when 'register' then 'registration' else 'login recovery' end;
    body:='Automatic account-service alert: '||task||' could not be completed.'
        ||E'\nPlayer: '||left(j.kol_name,128)||' (#'||j.kol_player_id||')'
        ||E'\nOriginal KMail: '||j.mail_id
        ||E'\nRequest saved: '||j.created_at::text
        ||E'\n\nThe request remains pending and will retry automatically. Unrelated auction deliveries continue when their safety checks pass.'
        ||E'\nReview the pending account request and Auth service if this persists. No password or account secret is included in this alert.';
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category,is_system)
        values(gen_random_uuid(),null,'kHub bot',3888760,body,'other',true) returning * into r;
    insert into khub_bot.account_failure_notices(mail_id,report_id,notified_player)
        values(j.mail_id,r.id,p_notify_player);
    administrator_message:='Account service alert B-'||r.report_number||E'\n'
        ||task||' for '||khub_bot.escape_report_kmail(left(j.kol_name,128))||' (#'||j.kol_player_id||')'
        ||E'\nOriginal KMail: '||j.mail_id
        ||E'\nThe request remains pending and will retry automatically.'
        ||E'\n\nAdministrator inbox: /admin/inbox?category=other';
    insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
        values('account-failure-admin:'||j.mail_id,3552305,'notice',administrator_message,administrator_message,'') returning id into delivery;
    insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,delivery);
    if p_notify_player then
        player_message:=case j.action when 'register'
            then E'Beep-boop! I\'m sorry, something went wrong while registering your kHub account.'
            else E'Beep-boop! I\'m sorry, something went wrong while recovering your kHub login.' end
            ||E'\n\nYour request is saved, and I will keep trying automatically. There is no need to send another request. I have notified the administrator.';
        insert into khub_bot.deliveries(dedupe_key,receipt_id,recipient_id,kind,message,display_message,display_footer)
            values('account-failure-player:'||j.mail_id,j.mail_id,j.kol_player_id,'notice',player_message,player_message,'');
    end if;
    return jsonb_build_object('status','queued','reference','B-'||r.report_number);
end; $$;
revoke all on function public.bot_notify_account_failure(text,boolean) from public,anon,authenticated;
grant execute on function public.bot_notify_account_failure(text,boolean) to service_role;
notify pgrst,'reload schema';
commit;
