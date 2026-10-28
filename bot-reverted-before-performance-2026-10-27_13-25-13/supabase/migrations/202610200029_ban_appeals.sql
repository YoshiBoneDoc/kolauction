-- Apply after 028. Appeals do not lift bans or grant trading/admin access.
begin;
create function public.khub_appeal_login_address(p_username text) returns text
language sql stable security definer set search_path='' as $$
    select u.email from public.profiles p join auth.users u on u.id=p.id
    where p.account_method='kmail'
      and lower(btrim(p_username))=lower('KH_'||p.khub_username)
      and u.email='account-'||p.id||'@login.khub.invalid'
      and p.kol_verified_at is not null;
$$;

create function public.submit_ban_appeal(p_request_id uuid,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    actor public.profiles%rowtype; r khub_bot.bug_reports%rowtype;
    v_body text:=btrim(p_body,E' \t\r\n');
    parts text[]:='{}'; part text:=''; encoded text; message text; delivery uuid; i integer;
begin
    select * into actor from public.profiles where id=auth.uid();
    if actor.id is null or actor.kol_player_id is null or actor.kol_verified_at is null then
        raise exception 'Log in with a verified kHub account to submit an appeal.' using errcode='42501';
    end if;
    if p_request_id is null or v_body is null or char_length(v_body) not between 10 and 2000 then
        raise exception 'Please describe your appeal in 10 to 2,000 characters.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('khub-bug-report:'||actor.id::text,0));
    select * into r from khub_bot.bug_reports where id=p_request_id;
    if found then
        if r.reporter_id<>actor.id or r.body<>v_body or r.category<>'appeal' then
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
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category)
        values(p_request_id,actor.id,actor.khub_username,actor.kol_player_id,v_body,'appeal') returning * into r;

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
        message:='Ban appeal B-'||r.report_number||' ('||i||'/'||array_length(parts,1)||')'
            ||E'\nFrom: '||khub_bot.escape_report_kmail(left(actor.khub_username,60))||' (#'||actor.kol_player_id||')'
            ||E'\n\n'||parts[i]||E'\n\nAdministrator inbox: /admin/inbox?category=appeal';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('bug-report:'||r.id||':'||i,3552305,'notice',message,message,'') returning id into delivery;
        insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,delivery);
    end loop;
    return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
end; $$;

revoke all on function public.khub_appeal_login_address(text),public.submit_ban_appeal(uuid,text)
    from public,anon,authenticated;
grant execute on function public.khub_appeal_login_address(text) to anon,authenticated;
grant execute on function public.submit_ban_appeal(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
