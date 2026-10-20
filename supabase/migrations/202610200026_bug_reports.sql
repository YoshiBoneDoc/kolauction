-- Apply once after 025, then deploy the matching website.
-- Uses the existing bot's durable zero-asset notice queue; no worker update needed.
-- No existing auction, receipt or delivery is rewritten, retried or marked sent.
begin;

create table khub_bot.administrators (
    user_id uuid primary key references public.profiles(id),
    granted_at timestamptz not null default clock_timestamp(),
    note text not null
);
create table khub_bot.bug_reports (
    id uuid primary key,
    report_number bigint generated always as identity (start with 1001) unique,
    reporter_id uuid not null references public.profiles(id),
    reporter_username text not null,
    reporter_kol_id bigint not null,
    body text not null check (char_length(body) between 10 and 2000),
    status text not null default 'open' check (status in ('open','resolved')),
    created_at timestamptz not null default clock_timestamp(),
    resolved_at timestamptz,
    resolved_by uuid references public.profiles(id),
    check ((status='open' and resolved_at is null and resolved_by is null)
        or (status='resolved' and resolved_at is not null and resolved_by is not null))
);
create index bug_reports_inbox_idx on khub_bot.bug_reports(status,created_at desc,report_number desc);
create index bug_reports_reporter_idx on khub_bot.bug_reports(reporter_id,created_at desc);
create table khub_bot.bug_report_deliveries (
    report_id uuid not null references khub_bot.bug_reports(id),
    delivery_id uuid primary key references khub_bot.deliveries(id)
);
create table khub_bot.bug_report_activity (
    id bigint generated always as identity primary key,
    report_id uuid not null references khub_bot.bug_reports(id),
    administrator_id uuid not null references public.profiles(id),
    status text not null check (status in ('open','resolved')),
    created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.administrators enable row level security;
alter table khub_bot.bug_reports enable row level security;
alter table khub_bot.bug_report_deliveries enable row level security;
alter table khub_bot.bug_report_activity enable row level security;
revoke all on khub_bot.administrators,khub_bot.bug_reports,khub_bot.bug_report_deliveries,
    khub_bot.bug_report_activity from public,anon,authenticated;
grant all on khub_bot.administrators,khub_bot.bug_reports,khub_bot.bug_report_deliveries,
    khub_bot.bug_report_activity to service_role;
grant usage on sequence khub_bot.bug_reports_report_number_seq,khub_bot.bug_report_activity_id_seq to service_role;

-- Authority comes from server-verified KoL ownership/private grants, never a
-- browser-supplied username or user-editable Auth metadata.
create function khub_bot.is_administrator(p_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
    select exists(select 1 from public.profiles p where p.id=p_user
        and p.kol_verified_at is not null and p.kol_player_id is not null
        and not p.is_banned and not khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name)
        and (p.kol_player_id=3552305 or exists(select 1 from khub_bot.administrators a where a.user_id=p.id)));
$$;
create function public.khub_is_administrator() returns boolean
language sql stable security definer set search_path='' as $$
    select khub_bot.is_administrator(auth.uid());
$$;
create function khub_bot.escape_report_kmail(p_text text) returns text
language sql immutable set search_path='' as $$
    select replace(replace(replace(p_text,'&','&amp;'),'<','&lt;'),'>','&gt;');
$$;
revoke all on function khub_bot.is_administrator(uuid),khub_bot.escape_report_kmail(text),
    public.khub_is_administrator() from public,anon,authenticated;
grant execute on function public.khub_is_administrator() to authenticated;

create function public.submit_bug_report(p_request_id uuid,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    actor public.profiles%rowtype; r khub_bot.bug_reports%rowtype;
    v_body text:=btrim(p_body,E' \t\r\n');
    parts text[]:='{}'; part text:=''; encoded text; message text; delivery uuid; i integer;
begin
    actor:=khub_bot.require_verified_trader();
    if p_request_id is null or v_body is null or char_length(v_body) not between 10 and 2000 then
        raise exception 'Please describe the bug in 10 to 2,000 characters.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('khub-bug-report:'||actor.id::text,0));
    select * into r from khub_bot.bug_reports where id=p_request_id;
    if found then
        if r.reporter_id<>actor.id or r.body<>v_body then
            raise exception 'This report request cannot be reused. Please try a new submission.';
        end if;
        return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
    end if;
    if exists(select 1 from khub_bot.bug_reports where reporter_id=actor.id and created_at>clock_timestamp()-interval '1 minute') then
        raise exception 'Please wait a minute before sending another report.';
    end if;
    if (select count(*) from khub_bot.bug_reports where reporter_id=actor.id and created_at>clock_timestamp()-interval '1 hour')>=5 then
        raise exception 'You have sent several reports recently. Please try again later.';
    end if;
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body)
        values(p_request_id,actor.id,actor.khub_username,actor.kol_player_id,v_body) returning * into r;

    -- Escape user text for KoL display. Split before the transport's normal
    -- delivery marker, without cutting HTML entities or truncating the report.
    for i in 1..char_length(v_body) loop
        encoded:=khub_bot.escape_report_kmail(substr(v_body,i,1));
        if char_length(part)+char_length(encoded)>1000 then
            parts:=array_append(parts,part); part:='';
        end if;
        part:=part||encoded;
    end loop;
    parts:=array_append(parts,part);
    for i in 1..array_length(parts,1) loop
        message:='Bug report B-'||r.report_number||' ('||i||'/'||array_length(parts,1)||')'
            ||E'\nFrom: '||khub_bot.escape_report_kmail(left(actor.khub_username,60))||' (#'||actor.kol_player_id||')'
            ||E'\n\n'||parts[i]||E'\n\nAdministrator inbox: /admin/bug-reports';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('bug-report:'||r.id||':'||i,3552305,'notice',message,message,'') returning id into delivery;
        insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,delivery);
    end loop;
    return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
end; $$;

create function public.read_bug_report_inbox(p_status text default 'open',p_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_status is null or p_status not in ('open','resolved','all') or p_page is null or p_page not between 1 and 1000000 then
        raise exception 'Choose a valid inbox page and status.';
    end if;
    with matching as materialized (
        select * from khub_bot.bug_reports where p_status='all' or status=p_status
    ), page as (
        select * from matching order by created_at desc,report_number desc limit 20 offset (p_page-1)*20
    )
    select jsonb_build_object('total',(select count(*) from matching),'reports',
        coalesce((select jsonb_agg(jsonb_build_object(
            'id',r.id,'reference','B-'||r.report_number,'body',r.body,'status',r.status,'created_at',r.created_at,
            'reporter_username',r.reporter_username,'reporter_kol_id',r.reporter_kol_id,
            'resolved_at',r.resolved_at,
            'notification',case
                when not exists(select 1 from khub_bot.bug_report_deliveries l where l.report_id=r.id) then 'not_queued'
                when exists(select 1 from khub_bot.bug_report_deliveries l join khub_bot.deliveries d on d.id=l.delivery_id
                    where l.report_id=r.id and d.state='unknown') then 'needs_review'
                when exists(select 1 from khub_bot.bug_report_deliveries l join khub_bot.deliveries d on d.id=l.delivery_id
                    where l.report_id=r.id and d.state='sending') then 'sending'
                when not exists(select 1 from khub_bot.bug_report_deliveries l join khub_bot.deliveries d on d.id=l.delivery_id
                    where l.report_id=r.id and d.state<>'sent') then 'sent'
                else 'queued' end
        ) order by r.created_at desc,r.report_number desc) from page r),'[]'::jsonb)) into result;
    return result;
end; $$;

create function public.set_bug_report_status(p_report_id uuid,p_status text) returns void
language plpgsql security definer set search_path='' as $$
declare r khub_bot.bug_reports%rowtype;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_status is null or p_status not in ('open','resolved') then raise exception 'Choose a valid report status.'; end if;
    select * into r from khub_bot.bug_reports where id=p_report_id for update;
    if not found then raise exception 'Report not found.'; end if;
    if r.status=p_status then return; end if;
    update khub_bot.bug_reports set status=p_status,
        resolved_at=case when p_status='resolved' then clock_timestamp() end,
        resolved_by=case when p_status='resolved' then auth.uid() end where id=p_report_id;
    insert into khub_bot.bug_report_activity(report_id,administrator_id,status) values(p_report_id,auth.uid(),p_status);
end; $$;
revoke all on function public.submit_bug_report(uuid,text),public.read_bug_report_inbox(text,integer),
    public.set_bug_report_status(uuid,text) from public,anon,authenticated;
grant execute on function public.submit_bug_report(uuid,text),public.read_bug_report_inbox(text,integer),
    public.set_bug_report_status(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
