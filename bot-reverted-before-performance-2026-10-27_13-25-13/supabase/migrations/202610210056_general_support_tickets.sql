-- Apply after 055. Private general support tickets go to the Other inbox.
-- Reuse reporting rate limits, verified/unrestricted identity checks and escaped,
-- idempotent KMail notices. The server, never the browser, assigns category.
begin;
create table khub_bot.support_tickets (
    report_id uuid primary key references khub_bot.bug_reports(id)
);
alter table khub_bot.support_tickets enable row level security;
revoke all on khub_bot.support_tickets from public,anon,authenticated;
grant all on khub_bot.support_tickets to service_role;
create function public.submit_support_ticket(p_request_id uuid,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    actor public.profiles%rowtype; r khub_bot.bug_reports%rowtype;
    v_body text:=btrim(p_body,E' \t\r\n');
    parts text[]:='{}'; part text:=''; encoded text; message text; delivery uuid; i integer;
begin
    actor:=khub_bot.require_verified_trader();
    if p_request_id is null or v_body is null or char_length(v_body) not between 10 and 2000 then
        raise exception 'Describe what you need help with in 10 to 2,000 characters.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('khub-bug-report:'||actor.id::text,0));
    select * into r from khub_bot.bug_reports where id=p_request_id;
    if found then
        if r.reporter_id<>actor.id or r.body<>v_body or not exists(select 1 from khub_bot.support_tickets t where t.report_id=r.id) then
            raise exception 'This ticket request cannot be reused. Please try a new submission.';
        end if;
        return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
    end if;
    if exists(select 1 from khub_bot.bug_reports where reporter_id=actor.id and created_at>clock_timestamp()-interval '1 minute') then
        raise exception 'Please wait a minute before sending another report.';
    end if;
    if (select count(*) from khub_bot.bug_reports where reporter_id=actor.id and created_at>clock_timestamp()-interval '1 hour')>=5 then
        raise exception 'You have sent several reports recently. Please try again later.';
    end if;
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category)
        values(p_request_id,actor.id,actor.khub_username,actor.kol_player_id,v_body,'other') returning * into r;
    insert into khub_bot.support_tickets(report_id) values(r.id);

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
        message:='Support ticket B-'||r.report_number||' ('||i||'/'||array_length(parts,1)||')'
            ||E'\nFrom: '||khub_bot.escape_report_kmail(left(actor.khub_username,60))||' (#'||actor.kol_player_id||')'
            ||E'\n\n'||parts[i]||E'\n\nAdministrator inbox: /admin/inbox?category=other';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('support-ticket:'||r.id||':'||i,3552305,'notice',message,message,'') returning id into delivery;
        insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,delivery);
    end loop;
    return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
end; $$;
revoke all on function public.submit_support_ticket(uuid,text) from public,anon,authenticated;
grant execute on function public.submit_support_ticket(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
