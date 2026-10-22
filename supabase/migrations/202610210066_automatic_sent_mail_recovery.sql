-- Apply after 065, then deploy the matching worker. Unknown sends are never
-- resent automatically. A positive Sent Mail match records success; otherwise
-- isolate the delivery and notify the administrator while other payouts continue.
begin;
-- Automated resolution is allowed only for private system reports; human reports
-- still require an identified administrator/participant to resolve them.
alter table khub_bot.bug_reports drop constraint bug_reports_resolution_kind_check,
    add constraint bug_reports_resolution_kind_check check(resolution_kind in ('administrator','participant_resolved','system_resolved')),
    drop constraint bug_reports_check,
    add constraint bug_reports_check check(
        (status='open' and resolved_at is null and resolved_by is null)
        or (status='resolved' and resolved_at is not null and
            (resolved_by is not null or (is_system and resolution_kind='system_resolved'))));
create table khub_bot.delivery_mailbox_reviews (
    id bigint generated always as identity primary key,
    delivery_id uuid not null references khub_bot.deliveries(id),
    attempt uuid,
    check_status text not null check(check_status in ('not_found','ambiguous','check_failed')),
    candidate_ids jsonb not null default '[]',
    report_id uuid references khub_bot.bug_reports(id) on delete set null,
    created_at timestamptz not null default clock_timestamp(),
    checked_at timestamptz not null default clock_timestamp(),
    resolved_at timestamptz,
    resolution text,
    sent_message_id text
);
create unique index delivery_mailbox_reviews_active on khub_bot.delivery_mailbox_reviews(delivery_id) where resolved_at is null;
alter table khub_bot.delivery_mailbox_reviews enable row level security;
revoke all on khub_bot.delivery_mailbox_reviews from public,anon,authenticated;
grant all on khub_bot.delivery_mailbox_reviews to service_role;
grant usage on sequence khub_bot.delivery_mailbox_reviews_id_seq to service_role;

-- Existing manual commands also close isolation records. Manual not-sent returns
-- the same obligation to pending; it does not bypass inventory or duplicate checks.
alter function public.bot_reconcile_delivery(uuid,boolean,text) set schema khub_bot;
alter function khub_bot.bot_reconcile_delivery(uuid,boolean,text) rename to reconcile_before_mailbox_recovery;
create function public.bot_reconcile_delivery(p_id uuid,p_sent boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
begin
    if p_sent is null then raise exception 'Choose sent or not-sent.'; end if;
    perform khub_bot.reconcile_before_mailbox_recovery(p_id,p_sent,p_evidence);
    update khub_bot.bug_reports set status='resolved',resolution_kind='system_resolved',resolved_at=clock_timestamp(),resolved_by=null,
        body=left(body,1500)||E'\n\nDelivery resolution: '||left(p_evidence,400)
        where id in (select report_id from khub_bot.delivery_mailbox_reviews where delivery_id=p_id and resolved_at is null) and status='open';
    update khub_bot.delivery_mailbox_reviews set resolved_at=clock_timestamp(),resolution=case when p_sent then 'sent' else 'not-sent' end
        where delivery_id=p_id and resolved_at is null;
end; $$;

create function public.bot_mailbox_check_deliveries() returns jsonb
language sql stable security definer set search_path='' as $$
    select coalesce(jsonb_agg(khub_bot.delivery_details(d)||jsonb_build_object(
        'expected_message',case when d.display_message is null then d.message||E'\n[kHub delivery '||d.id||']'
            else d.display_message||E'\n\nReference: D-'||d.reference_number||case when coalesce(d.display_footer,'')<>'' then E'\n'||d.display_footer else '' end end)
        order by d.created_at,d.id),'[]'::jsonb)
    from khub_bot.deliveries d where d.state in ('sending','unknown');
$$;

create function public.bot_record_mailbox_check(p_id uuid,p_attempt uuid,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; h khub_bot.delivery_mailbox_reviews%rowtype;
    r khub_bot.bug_reports%rowtype; body text; alert uuid; outcome text:=p_result->>'status'; ids jsonb:=p_result->'candidate_ids'; evidence text;
begin
    if outcome is null or outcome not in ('verified','not_found','ambiguous','check_failed')
        or jsonb_typeof(ids) is distinct from 'array' or jsonb_array_length(ids)>20
        or exists(select 1 from jsonb_array_elements_text(ids) x where x!~'^[1-9][0-9]{0,18}$') then
        raise exception 'Invalid mailbox verification result.';
    end if;
    if outcome='verified' and (coalesce(p_result->>'message_id','')!~'^[1-9][0-9]{0,18}$'
        or coalesce(p_result->>'message_hash','')!~'^[a-f0-9]{64}$'
        or ids<>jsonb_build_array(p_result->>'message_id')) then raise exception 'Invalid sent-message evidence.'; end if;
    perform pg_advisory_xact_lock(3888760);
    select * into d from khub_bot.deliveries where id=p_id for update;
    if not found then raise exception 'Delivery not found.'; end if;
    if d.state='sent' then return jsonb_build_object('status','already_sent'); end if;
    if d.state not in ('sending','unknown') or d.attempt is distinct from p_attempt then
        raise exception 'Delivery attempt changed. Recheck the current ledger.';
    end if;
    if outcome='verified' then
        evidence:='Verified KoL Sent Mail ID '||(p_result->>'message_id')||'; exact saved message and recipient match; text SHA256 '||(p_result->>'message_hash');
        perform public.bot_reconcile_delivery(d.id,true,evidence);
        update khub_bot.delivery_mailbox_reviews set sent_message_id=p_result->>'message_id' where delivery_id=d.id and resolution='sent';
        return jsonb_build_object('status','sent','message_id',p_result->>'message_id');
    end if;
    -- Remains unknown, never pending: claims cannot resend it. Record only safe
    -- identifiers, not raw mailbox pages or exception text.
    update khub_bot.deliveries set state='unknown' where id=d.id and state='sending';
    select * into h from khub_bot.delivery_mailbox_reviews where delivery_id=d.id and resolved_at is null;
    if found then
        update khub_bot.delivery_mailbox_reviews set checked_at=clock_timestamp(),check_status=outcome,candidate_ids=ids where id=h.id;
        return jsonb_build_object('status','isolated');
    end if;
    insert into khub_bot.delivery_mailbox_reviews(delivery_id,attempt,check_status,candidate_ids)
        values(d.id,d.attempt,outcome,ids) returning * into h;
    body:='Delivery D-'||d.reference_number||' needs a manual Sent Mail check.'
        ||E'\nDelivery UUID: '||d.id||E'\nRecipient: #'||d.recipient_id
        ||E'\nOriginal received KMail ID: '||coalesce(d.receipt_id,'Not linked to a received message')
        ||E'\nCandidate sent KMail IDs: '||case when jsonb_array_length(ids)>0 then ids::text else 'No confirmed matching sent-message ID is available' end
        ||E'\nMailbox check: '||outcome
        ||E'\n\nIt may already have been sent. This delivery is set aside and will NOT be resent automatically. Other funded deliveries continue. Its auction remains unsettled until resolved. Closet transfers are paused to preserve disputed assets.'
        ||E'\nUse the delivery reference or UUID to record sent/not-sent after checking KoL. A missing sent copy alone is not proof it failed.';
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category,is_system)
        values(gen_random_uuid(),null,'kHub bot',3888760,body,'other',true) returning * into r;
    update khub_bot.delivery_mailbox_reviews set report_id=r.id where id=h.id;
    -- Do not create an infinite chain of alerts when the alert itself times out.
    if d.dedupe_key not like 'mailbox-review-admin:%' and d.dedupe_key not like 'manual-review:%' then
        body:='Manual delivery check B-'||r.report_number||E'\n'||body||E'\nAdministrator inbox: /admin/inbox?category=other';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('mailbox-review-admin:'||h.id,3552305,'notice',body,body,'') returning id into alert;
        insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,alert);
    end if;
    return jsonb_build_object('status','isolated');
end; $$;

-- Full liabilities retain every unresolved obligation, including possibly-sent
-- deliveries. Dispatch checks separately cover all definitely-unsent obligations.
-- Nothing is forgiven or closeted while a send remains uncertain.
create function public.bot_dispatch_liabilities() returns jsonb
language sql stable security definer set search_path='' as $$
    with full_balance as (select public.bot_liabilities() b), isolated as (
        select d.* from khub_bot.deliveries d join khub_bot.delivery_mailbox_reviews h on h.delivery_id=d.id
        where h.resolved_at is null and d.state='unknown'
    ), items as (
        select x.key,greatest(0,x.value::numeric-coalesce((select sum(i.quantity) from isolated i where i.item_id::text=x.key),0))::text quantity
        from full_balance f cross join lateral jsonb_each_text(f.b->'items') x
    ) select jsonb_build_object('meat',greatest(0,(f.b->>'meat')::numeric-coalesce((select sum(meat) from isolated),0))::text,
        'items',coalesce((select jsonb_object_agg(key,quantity) from items),'{}'::jsonb)) from full_balance f;
$$;

do $$ declare definition text; anchor text:=$anchor$exists(select 1 from khub_bot.deliveries where state in ('sending','unknown'))$anchor$;
begin
    definition:=pg_get_functiondef('public.bot_claim_delivery(integer)'::regprocedure);
    if strpos(definition,anchor)=0 then raise exception 'Unexpected delivery claim implementation.'; end if;
    execute replace(definition,anchor,$patch$exists(select 1 from khub_bot.deliveries uncertain_delivery where uncertain_delivery.state in ('sending','unknown')
        and not exists(select 1 from khub_bot.delivery_mailbox_reviews isolation where isolation.delivery_id=uncertain_delivery.id and isolation.resolved_at is null and uncertain_delivery.state='unknown'))$patch$);
end; $$;
alter function public.bot_inspect() set schema khub_bot;
alter function khub_bot.bot_inspect() rename to inspect_before_mailbox_recovery;
create function public.bot_inspect() returns jsonb
language sql stable security definer set search_path='' as $$
    select khub_bot.inspect_before_mailbox_recovery()||jsonb_build_object(
        'mailboxRecoveryEnabled',true,
        'isolatedDeliveryAttention',coalesce((select jsonb_agg(jsonb_build_object(
            'id',d.id,'delivery_reference','D-'||d.reference_number,'recipient_id',d.recipient_id,
            'state',d.state,'reason',h.check_status,'candidate_message_ids',h.candidate_ids,
            'support_reference','B-'||r.report_number
        ) order by h.created_at,h.id) from khub_bot.delivery_mailbox_reviews h
            join khub_bot.deliveries d on d.id=h.delivery_id left join khub_bot.bug_reports r on r.id=h.report_id
            where h.resolved_at is null and d.state='unknown'),'[]'::jsonb));
$$;
revoke all on function khub_bot.reconcile_before_mailbox_recovery(uuid,boolean,text),khub_bot.inspect_before_mailbox_recovery() from public,anon,authenticated,service_role;
revoke all on function public.bot_reconcile_delivery(uuid,boolean,text),public.bot_mailbox_check_deliveries(),public.bot_record_mailbox_check(uuid,uuid,jsonb),public.bot_dispatch_liabilities(),public.bot_inspect() from public,anon,authenticated;
grant execute on function public.bot_reconcile_delivery(uuid,boolean,text),public.bot_mailbox_check_deliveries(),public.bot_record_mailbox_check(uuid,uuid,jsonb),public.bot_dispatch_liabilities(),public.bot_inspect() to service_role;
notify pgrst,'reload schema';
commit;
