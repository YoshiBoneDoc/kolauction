-- Apply after 047. Site restrictions allow authenticated appeals, never trading.
-- Preserve existing site/Auth bans before allowing restricted sign-in.
-- Private image evidence is bounded to one PNG/JPEG/WebP (2 MiB) per appeal.
begin;
alter table khub_bot.account_bans add column expires_at timestamptz;
create index account_bans_expiry_idx on khub_bot.account_bans(active,expires_at);
create table khub_bot.account_ban_activity (
    id bigint generated always as identity primary key,
    ban_id bigint not null references khub_bot.account_bans(id),
    administrator_id uuid references public.profiles(id),
    previous_state jsonb,
    new_state jsonb not null,
    created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.account_ban_activity enable row level security;
revoke all on khub_bot.account_ban_activity from public,anon,authenticated;
grant all on khub_bot.account_ban_activity to service_role;
grant usage on sequence khub_bot.account_ban_activity_id_seq to service_role;
create function khub_bot.audit_account_ban() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    insert into khub_bot.account_ban_activity(ban_id,administrator_id,previous_state,new_state)
        values(new.id,auth.uid(),case when tg_op='UPDATE' then to_jsonb(old) end,to_jsonb(new));
    return new;
end; $$;
create trigger account_bans_audit after insert or update on khub_bot.account_bans
    for each row execute function khub_bot.audit_account_ban();
-- Bans live in account_bans. Sticky legacy profile flags must not outlast a temporary ban.
drop trigger account_bans_apply on khub_bot.account_bans;
drop trigger profiles_record_ban on public.profiles;
insert into khub_bot.account_bans(kol_player_id,username,reason,expires_at)
    select p.kol_player_id,p.khub_username,'Imported Auth account restriction.',u.banned_until
    from public.profiles p join auth.users u on u.id=p.id where u.banned_until>now();
insert into khub_bot.account_bans(kol_player_id,username,reason)
    select p.kol_player_id,p.khub_username,'Existing account restriction.' from public.profiles p
    where p.is_banned and not exists(select 1 from khub_bot.account_bans b where b.active and
        (b.kol_player_id=p.kol_player_id or lower(btrim(b.username)) in (lower(btrim(p.khub_username)),lower(btrim(p.kol_player_name)))));
update public.profiles set is_banned=false where is_banned;
update auth.users u set banned_until=null where u.banned_until>now() and exists(select 1 from public.profiles p where p.id=u.id);
create or replace function khub_bot.account_is_banned(p_player bigint,p_username text,p_kol_name text) returns boolean
language sql stable set search_path='' as $$
    select exists(select 1 from khub_bot.account_bans b where b.active and (b.expires_at is null or b.expires_at>now()) and (
        b.kol_player_id=p_player or lower(btrim(b.username)) in (lower(btrim(p_username)),lower(btrim(p_kol_name)))))
      or exists(select 1 from public.profiles p join auth.users u on u.id=p.id
        where p.kol_player_id=p_player and (p.is_banned or u.banned_until>now()));
$$;
-- Legacy operator changes are converted to durable site restrictions.
create or replace function khub_bot.record_profile_ban() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if new.is_banned then
        if not exists(select 1 from khub_bot.account_bans b where b.active and (b.expires_at is null or b.expires_at>now())
            and (b.kol_player_id=new.kol_player_id or lower(btrim(b.username)) in (lower(btrim(new.khub_username)),lower(btrim(new.kol_player_name))))) then
            insert into khub_bot.account_bans(kol_player_id,username,reason) values(new.kol_player_id,new.khub_username,'Account restricted by operator.');
        end if;
        new.is_banned:=false;
    end if;
    return new;
end; $$;
create trigger profiles_record_ban before update of is_banned on public.profiles
    for each row execute function khub_bot.record_profile_ban();
-- A native Auth ban normally prevents appeals. Convert future Auth bans atomically
-- to a site ban before Auth blocks password sign-in. Lift via lift_account_restriction.
create function khub_bot.preserve_auth_restriction() returns trigger
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype;
begin
    if new.banned_until>now() then
        select * into p from public.profiles where id=new.id;
        if found then
            insert into khub_bot.account_bans(kol_player_id,username,reason,expires_at)
                values(p.kol_player_id,p.khub_username,'Auth account restriction.',new.banned_until);
            new.banned_until:=null;
        end if;
    end if;
    return new;
end; $$;
create trigger users_preserve_site_restriction before update of banned_until on auth.users
    for each row execute function khub_bot.preserve_auth_restriction();
create function public.read_my_account_access() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p public.profiles%rowtype; is_restricted boolean; permanent boolean; until_time timestamptz;
begin
    select * into p from public.profiles where id=auth.uid();
    if not found then raise exception 'Log in to check your account.' using errcode='42501'; end if;
    is_restricted:=khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name);
    select coalesce(bool_or(b.expires_at is null),false),max(b.expires_at) into permanent,until_time
        from khub_bot.account_bans b where b.active and (b.expires_at is null or b.expires_at>now()) and
        (b.kol_player_id=p.kol_player_id or lower(btrim(b.username)) in (lower(btrim(p.khub_username)),lower(btrim(p.kol_player_name))));
    return jsonb_build_object('id',p.id,'khub_username',p.khub_username,'account_method',p.account_method,
        'is_banned',is_restricted,'ban_expires_at',case when is_restricted and not permanent then until_time end,'server_now',clock_timestamp());
end; $$;
revoke all on function public.read_my_account_access() from public,anon,authenticated;
grant execute on function public.read_my_account_access() to authenticated;
-- Username resolution does not grant access: Auth verifies the password, then the
-- website shows only the restricted screen/appeal form and database guards deny trading.
create or replace function public.khub_login_address(p_username text) returns text
language sql stable security definer set search_path='' as $$
    select public.khub_appeal_login_address(p_username);
$$;
create function public.set_account_restriction(p_user_id uuid,p_reason text,p_expires_at timestamptz default null) returns void
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; reason text:=btrim(p_reason);
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_user_id=auth.uid() then raise exception 'You cannot ban your own administrator account.'; end if;
    if reason is null or char_length(reason) not between 3 and 1000 or (p_expires_at is not null and p_expires_at<=now()) then
        raise exception 'Add a reason and a future expiry, or leave expiry empty for a permanent ban.'; end if;
    perform pg_advisory_xact_lock(3888760);
    select * into p from public.profiles where id=p_user_id;
    if not found then raise exception 'Account not found.'; end if;
    update khub_bot.account_bans set active=false where active and (kol_player_id=p.kol_player_id or lower(btrim(username)) in (lower(btrim(p.khub_username)),lower(btrim(p.kol_player_name))));
    insert into khub_bot.account_bans(kol_player_id,username,reason,expires_at) values(p.kol_player_id,p.khub_username,reason,p_expires_at);
end; $$;
create function public.lift_account_restriction(p_user_id uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; reason text:=btrim(p_reason);
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if reason is null or char_length(reason) not between 3 and 1000 then raise exception 'Add a reason in 3 to 1,000 characters.'; end if;
    perform pg_advisory_xact_lock(3888760);
    select * into p from public.profiles where id=p_user_id;
    if not found then raise exception 'Account not found.'; end if;
    update khub_bot.account_bans set active=false,reason=reason where active and
        (kol_player_id=p.kol_player_id or lower(btrim(username)) in (lower(btrim(p.khub_username)),lower(btrim(p.kol_player_name))));
end; $$;
revoke all on function public.set_account_restriction(uuid,text,timestamptz),public.lift_account_restriction(uuid,text) from public,anon,authenticated;
grant execute on function public.set_account_restriction(uuid,text,timestamptz),public.lift_account_restriction(uuid,text) to authenticated;
revoke all on function khub_bot.audit_account_ban(),khub_bot.preserve_auth_restriction() from public,anon,authenticated;

create or replace function public.submit_trade_report(p_request_id uuid,p_auction_id uuid,p_body text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    a public.auctions%rowtype; prior khub_bot.trade_reports%rowtype; actor public.profiles%rowtype; r khub_bot.bug_reports%rowtype;
    v_body text:=btrim(coalesce(p_body,''),E' \t\r\n'); stored_body text;
    parts text[]:='{}'; part text:=''; encoded text; message text; delivery uuid; i integer;
begin
    perform khub_bot.require_verified_trader();
    perform pg_advisory_xact_lock(3888760);
    select * into actor from public.profiles where id=auth.uid();
    select * into a from public.auctions where id=p_auction_id for update;
    if actor.id is null or actor.kol_verified_at is null or a.id is null or a.escrow_mode
        or a.finalized_at is null or a.winner_id is null or a.seller_id=a.winner_id
        or actor.id not in (a.seller_id,a.winner_id) then
        raise exception 'Only the seller or winning buyer of a closed direct sale can report a trade.';
    end if;
    if p_request_id is null or char_length(v_body)>2000 then
        raise exception 'Keep the optional explanation within 2,000 characters.';
    end if;
    stored_body:=case when v_body='' then 'No explanation provided.' else v_body end;
    perform pg_advisory_xact_lock(hashtextextended('khub-bug-report:'||actor.id::text,0));
    select * into r from khub_bot.bug_reports where id=p_request_id;
    if found then
        if r.reporter_id<>actor.id or r.body<>stored_body or not exists(select 1 from khub_bot.trade_reports t where t.report_id=r.id and t.auction_id=a.id and t.has_explanation=(v_body<>'')) then
            raise exception 'This report request cannot be reused. Please try a new submission.';
        end if;
        return jsonb_build_object('reference','B-'||r.report_number,'notification',case when v_body='' then 'not_queued' else 'queued' end);
    end if;
    if a.status<>'awaiting_trade' then raise exception 'This trade is not awaiting settlement.'; end if;
    if (actor.id=a.seller_id and a.seller_confirmed_at is not null)
        or (actor.id=a.winner_id and a.buyer_confirmed_at is not null) then
        raise exception 'You already confirmed this trade. Contact an administrator to request a reviewed correction.';
    end if;
    select * into prior from khub_bot.trade_reports where auction_id=a.id and reporter_id=actor.id;
    if found then raise exception 'You already submitted a trade report. Contact an administrator to add information.'; end if;
    if v_body<>'' and exists(select 1 from khub_bot.bug_reports b where b.reporter_id=actor.id and b.created_at>clock_timestamp()-interval '1 minute' and not exists(select 1 from khub_bot.trade_reports t where t.report_id=b.id and not t.has_explanation)) then
        raise exception 'Please wait a minute before sending another report.';
    end if;
    if v_body<>'' and (select count(*) from khub_bot.bug_reports b where b.reporter_id=actor.id and b.created_at>clock_timestamp()-interval '1 hour' and not exists(select 1 from khub_bot.trade_reports t where t.report_id=b.id and not t.has_explanation))>=5 then
        raise exception 'You have sent several reports recently. Please try again later.';
    end if;
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category)
        values(p_request_id,actor.id,actor.khub_username,actor.kol_player_id,stored_body,'trade') returning * into r;
    insert into khub_bot.trade_reports(auction_id,reporter_id,reporter_role,report_id,has_explanation)
        values(a.id,actor.id,case when actor.id=a.seller_id then 'seller' else 'buyer' end,r.id,v_body<>'');

    -- Silent thumbs-downs are inbox records without KMail notifications.
    if v_body='' then
        return jsonb_build_object('reference','B-'||r.report_number,'notification','not_queued');
    end if;

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
        message:='Trade report B-'||r.report_number||' ('||i||'/'||array_length(parts,1)||')'
            ||E'\nAuction #'||a.auction_number||' ('||a.id||')'
            ||E'\nAgreed total: '||khub_bot.format_message_number(a.final_price)||' Meat'
            ||E'\nFrom: '||khub_bot.escape_report_kmail(left(actor.khub_username,60))||' (#'||actor.kol_player_id||')'
            ||E'\n\n'||parts[i]||E'\n\nAdministrator inbox: /admin/inbox?category=trade';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('trade-report:'||r.id||':'||i,3552305,'notice',message,message,'') returning id into delivery;
        insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,delivery);
    end loop;
    return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
end; $$;

create or replace function public.submit_trade_query(p_request_id uuid,p_auction_id uuid,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    a public.auctions%rowtype; actor public.profiles%rowtype; r khub_bot.bug_reports%rowtype;
    v_body text:=btrim(p_body,E' \t\r\n');
    parts text[]:='{}'; part text:=''; encoded text; message text; delivery uuid; i integer;
begin
    perform khub_bot.require_verified_trader();
    select * into actor from public.profiles where id=auth.uid();
    if actor.id is null or actor.kol_player_id is null or actor.kol_verified_at is null then
        raise exception 'Log in with a verified kHub account to submit an appeal.' using errcode='42501';
    end if;
    select * into a from public.auctions where id=p_auction_id;
    if a.id is null or a.escrow_mode or a.finalized_at is null or a.winner_id is null
        or a.status not in ('awaiting_trade','completed') or actor.id not in (a.seller_id,a.winner_id) then
        raise exception 'Only the seller or winner of a closed direct sale can send a trade query.';
    end if;
    if p_request_id is null or v_body is null or char_length(v_body) not between 10 and 2000 then
        raise exception 'Please describe your trade query in 10 to 2,000 characters.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('khub-bug-report:'||actor.id::text,0));
    select * into r from khub_bot.bug_reports where id=p_request_id;
    if found then
        if r.reporter_id<>actor.id or r.body<>v_body or not exists(select 1 from khub_bot.trade_queries q where q.report_id=r.id and q.auction_id=a.id) then
            raise exception 'This report request cannot be reused. Please try a new submission.';
        end if;
        return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
    end if;
    if exists(select 1 from khub_bot.bug_reports where reporter_id=actor.id and created_at>clock_timestamp()-interval '1 minute' and not exists(select 1 from khub_bot.trade_reports t where t.report_id=khub_bot.bug_reports.id and not t.has_explanation)) then
        raise exception 'Please wait a minute before sending another report.';
    end if;
    if (select count(*) from khub_bot.bug_reports where reporter_id=actor.id and created_at>clock_timestamp()-interval '1 hour' and not exists(select 1 from khub_bot.trade_reports t where t.report_id=khub_bot.bug_reports.id and not t.has_explanation))>=5 then
        raise exception 'You have sent several reports recently. Please try again later.';
    end if;
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category)
        values(p_request_id,actor.id,actor.khub_username,actor.kol_player_id,v_body,'trade') returning * into r;
    insert into khub_bot.trade_queries(report_id,auction_id,requester_id) values(r.id,a.id,actor.id);

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
        message:='Trade query B-'||r.report_number||' ('||i||'/'||array_length(parts,1)||')'
            ||E'\nAuction #'||coalesce(a.auction_number::text,a.id::text)
            ||E'\nFrom: '||khub_bot.escape_report_kmail(left(actor.khub_username,60))||' (#'||actor.kol_player_id||')'
            ||E'\n\n'||parts[i]||E'\n\nAdministrator inbox: /admin/inbox?category=trade';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('bug-report:'||r.id||':'||i,3552305,'notice',message,message,'') returning id into delivery;
        insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,delivery);
    end loop;
    return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
end; $$;

create or replace function public.submit_bug_report(p_request_id uuid,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    actor public.profiles%rowtype; r khub_bot.bug_reports%rowtype;
    v_body text:=btrim(p_body,E' \t\r\n');
    parts text[]:='{}'; part text:=''; encoded text; message text; delivery uuid; i integer;
begin
    perform khub_bot.require_verified_trader();
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

create or replace function public.khub_wall_of_shame(p_offset integer default 0,p_limit integer default 24)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if p_offset is null or p_offset<0 or p_offset>100000
       or p_limit is null or p_limit<1 or p_limit>48 then
        raise exception 'Invalid gallery page.';
    end if;
    with published as (
        select p.id,case when khub_bot.can_view_usernames() then p.kol_player_name else 'Banned player' end as kol_player_name,
            case when khub_bot.can_view_usernames() then b.kol_player_id end as kol_player_id,
            case when khub_bot.can_view_usernames() then p.public_reason else 'Log in with an unrestricted account to view this reviewed ban.' end as public_reason,p.banned_at,p.expires_at
        from khub_bot.ban_publications p join khub_bot.account_bans b on b.id=p.ban_id
        where b.active and (b.expires_at is null or b.expires_at>now()) and b.kol_player_id is not null and p.published_at<=now()
            and (p.expires_at is null or p.expires_at>now())
    ), page as (
        select * from published order by banned_at desc,id limit p_limit offset p_offset
    )
    select jsonb_build_object('usernames_visible',khub_bot.can_view_usernames(),'total',(select count(*) from published),
        'entries',coalesce((select jsonb_agg(to_jsonb(page) order by banned_at desc,id) from page),'[]'::jsonb)) into result;
    return result;
end; $$;

create table khub_bot.appeal_evidence (
    report_id uuid primary key references khub_bot.bug_reports(id),
    reporter_id uuid not null references public.profiles(id),
    mime_type text not null check (mime_type in ('image/png','image/jpeg','image/webp')),
    content bytea not null check (octet_length(content) between 1 and 2097152),
    created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.appeal_evidence enable row level security;
revoke all on khub_bot.appeal_evidence from public,anon,authenticated;
grant all on khub_bot.appeal_evidence to service_role;
create function public.submit_ban_appeal_with_evidence(p_request_id uuid,p_body text,p_image_base64 text default null,p_mime_type text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; image_bytes bytea; prior khub_bot.appeal_evidence%rowtype;
begin
    if auth.uid() is null then raise exception 'Log in to submit an appeal.' using errcode='42501'; end if;
    if p_image_base64 is not null then
        if char_length(p_image_base64)>2796204 or p_mime_type is null or p_mime_type not in ('image/png','image/jpeg','image/webp') then
            raise exception 'Attach a PNG, JPEG or WebP image up to 2 MB.'; end if;
        begin image_bytes:=decode(p_image_base64,'base64'); exception when others then raise exception 'The image could not be read.'; end;
        if octet_length(image_bytes) not between 1 and 2097152 or not (
            (p_mime_type='image/png' and substring(image_bytes from 1 for 8)=decode('89504e470d0a1a0a','hex')) or
            (p_mime_type='image/jpeg' and substring(image_bytes from 1 for 3)=decode('ffd8ff','hex')) or
            (p_mime_type='image/webp' and substring(image_bytes from 1 for 4)=decode('52494646','hex') and substring(image_bytes from 9 for 4)=decode('57454250','hex'))
        ) then raise exception 'Attach a valid PNG, JPEG or WebP image up to 2 MB.'; end if;
    elsif p_mime_type is not null then raise exception 'Attach an image before choosing its type.';
    end if;
    result:=public.submit_ban_appeal(p_request_id,p_body);
    select * into prior from khub_bot.appeal_evidence where report_id=p_request_id for update;
    if found then
        if prior.reporter_id<>auth.uid() or image_bytes is null or prior.content<>image_bytes or prior.mime_type<>p_mime_type then
            raise exception 'This appeal request cannot be reused with different evidence.'; end if;
    elsif image_bytes is not null then
        insert into khub_bot.appeal_evidence(report_id,reporter_id,mime_type,content) values(p_request_id,auth.uid(),p_mime_type,image_bytes);
    end if;
    return result;
end; $$;
create function public.read_appeal_evidence(p_report_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare evidence khub_bot.appeal_evidence%rowtype;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    select * into evidence from khub_bot.appeal_evidence where report_id=p_report_id;
    if not found then return null; end if;
    return jsonb_build_object('mime_type',evidence.mime_type,'base64',replace(encode(evidence.content,'base64'),E'\n',''));
end; $$;
revoke all on function public.submit_ban_appeal_with_evidence(uuid,text,text,text),public.read_appeal_evidence(uuid) from public,anon,authenticated;
grant execute on function public.submit_ban_appeal_with_evidence(uuid,text,text,text),public.read_appeal_evidence(uuid) to authenticated;

create or replace function public.read_support_threads(p_category text default 'all',p_status text default 'open',p_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_category is null or p_category not in ('all','bug','trade','appeal','other') then
        raise exception 'Choose a valid inbox category.';
    end if;
    if p_status is null or p_status not in ('open','resolved','self_resolved','all') or p_page is null or p_page not between 1 and 1000000 then
        raise exception 'Choose a valid inbox page and status.';
    end if;
    -- Group before filtering/pagination: a trade's history stays together even
    -- when its messages have different categories or resolution states.
    with messages as materialized (
        select r.*,greatest(r.created_at,t.withdrawn_at) as last_activity_at,coalesce(t.auction_id,q.auction_id) as auction_id,
            coalesce(t.auction_id,q.auction_id,r.id) as thread_id,
            (t.auction_id is not null or q.auction_id is not null) as is_trade
        from khub_bot.bug_reports r
        left join khub_bot.trade_reports t on t.report_id=r.id
        left join khub_bot.trade_queries q on q.report_id=r.id
    ), grouped as (
        select thread_id,is_trade,max(last_activity_at) as updated_at,max(report_number) as latest_number,
            bool_or(status='open') as is_open,
            bool_and(status='resolved' and resolution_kind is not distinct from 'participant_resolved') as self_resolved,
            bool_or(p_category='all' or category=p_category) as category_matches
        from messages group by thread_id,is_trade
    ), matching as materialized (
        select * from grouped where category_matches and (p_status='all'
            or (p_status='open' and is_open) or (p_status='resolved' and not is_open)
            or (p_status='self_resolved' and self_resolved))
    ), page as (
        select * from matching order by updated_at desc,latest_number desc limit 20 offset (p_page-1)*20
    )
    select jsonb_build_object('total',(select count(*) from matching),'threads',coalesce((
        select jsonb_agg(jsonb_build_object(
            'id',g.thread_id,'is_trade',g.is_trade,'updated_at',g.updated_at,
            'status',case when g.is_open then 'open' else 'resolved' end,
            'resolution_kind',case when g.self_resolved then 'participant_resolved' when not g.is_open then 'administrator' end,
            'auction',case when a.id is not null then jsonb_build_object(
                'id',a.id,'number',a.auction_number,'item',a.item,'quantity',a.quantity,'image',a.image,
                'price',a.final_price,'escrow',a.escrow_mode,'status',a.status,
                'seller',jsonb_build_object('name',coalesce(s.khub_username,a.seller_username),'player_id',s.kol_player_id,'confirmed_at',a.seller_confirmed_at,'resolved_at',a.seller_resolved_at),
                'buyer',jsonb_build_object('name',coalesce(b.khub_username,a.winner_username),'player_id',b.kol_player_id,'confirmed_at',a.buyer_confirmed_at,'resolved_at',a.buyer_resolved_at)
            ) end,
            'messages',(select jsonb_agg(jsonb_build_object(
                'id',r.id,'reference','B-'||r.report_number,'category',r.category,'body',r.body,
                'has_evidence',exists(select 1 from khub_bot.appeal_evidence e where e.report_id=r.id),
                'status',r.status,'resolution_kind',r.resolution_kind,'created_at',r.created_at,
                'reporter_username',r.reporter_username,'reporter_kol_id',r.reporter_kol_id,
                'reporter_role',coalesce(t.reporter_role,case when r.reporter_id=a.seller_id then 'seller' when r.reporter_id=a.winner_id then 'buyer' end),
                'message_type',case when t.report_id is not null then 'trade_rating' when q.report_id is not null then 'trade_query' else 'general' end,
                'negative_counted',t.counts_negative,'feedback_withdrawn',t.withdrawn_at is not null,
                'withdrawn_at',t.withdrawn_at,
                'withdrawal_confirmed_complete',coalesce(t.withdrawn_at is not null and
                    case t.reporter_role when 'seller' then a.seller_resolved_at else a.buyer_resolved_at end=t.withdrawn_at,false),
                'target_username',case t.reporter_role when 'buyer' then coalesce(s.khub_username,a.seller_username) when 'seller' then coalesce(b.khub_username,a.winner_username) end,
                'rating_reviews',(select coalesce(jsonb_agg(jsonb_build_object(
                    'counted',v.counted,'reason',v.reason,'created_at',v.created_at,'reviewer',p.khub_username
                ) order by v.id),'[]'::jsonb) from khub_bot.trade_rating_reviews v
                    left join public.profiles p on p.id=v.administrator_id where v.report_id=r.id)
            ) order by r.created_at,r.report_number) from messages r
                left join khub_bot.trade_reports t on t.report_id=r.id
                left join khub_bot.trade_queries q on q.report_id=r.id
                where r.thread_id=g.thread_id and r.is_trade=g.is_trade)
        ) order by g.updated_at desc,g.latest_number desc)
        from page g left join public.auctions a on g.is_trade and a.id=g.thread_id
        left join public.profiles s on s.id=a.seller_id
        left join public.profiles b on b.id=a.winner_id
    ),'[]'::jsonb)) into result;
    return result;
end; $$;

notify pgrst,'reload schema';
commit;
