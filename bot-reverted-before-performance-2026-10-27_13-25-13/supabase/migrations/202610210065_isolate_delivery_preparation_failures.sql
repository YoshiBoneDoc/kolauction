-- Apply after 064. Set aside known-unsent preparation failures, including asset
-- deliveries, without dropping liabilities or blocking unrelated messages.
begin;
create table khub_bot.delivery_preparation_reviews (
    id bigint generated always as identity primary key,
    delivery_id uuid not null references khub_bot.deliveries(id),
    error_code text not null,
    reason text not null,
    report_id uuid references khub_bot.bug_reports(id) on delete set null,
    created_at timestamptz not null default clock_timestamp(),
    released_at timestamptz,
    release_evidence text
);
create unique index delivery_preparation_reviews_active on khub_bot.delivery_preparation_reviews(delivery_id) where released_at is null;
alter table khub_bot.delivery_preparation_reviews enable row level security;
revoke all on khub_bot.delivery_preparation_reviews from public,anon,authenticated;
grant all on khub_bot.delivery_preparation_reviews to service_role;
grant usage on sequence khub_bot.delivery_preparation_reviews_id_seq to service_role;

create function khub_bot.hold_unprepared_delivery(p_id uuid,p_code text,p_reason text) returns void
language plpgsql set search_path='' as $$
declare d khub_bot.deliveries%rowtype; review_id bigint; r khub_bot.bug_reports%rowtype; body text; alert uuid;
begin
    select * into d from khub_bot.deliveries where id=p_id for update;
    if not found or d.state<>'pending' then raise exception 'Only a pending, unsent delivery can be set aside.'; end if;
    insert into khub_bot.delivery_preparation_reviews(delivery_id,error_code,reason)
        values(d.id,p_code,p_reason) on conflict(delivery_id) where released_at is null do nothing returning id into review_id;
    if review_id is null then return; end if;
    body:='Delivery D-'||d.reference_number||' needs administrator review.'
        ||E'\n'||p_reason
        ||E'\nDelivery UUID: '||d.id
        ||E'\n\nNo send was attempted for this preparation failure. The delivery and any owed items or Meat remain reserved. Other ready deliveries continue.'
        ||E'\nAfter fixing the cause, release this delivery for retry. Closing this ticket alone does not release or complete the delivery.';
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category,is_system)
        values(gen_random_uuid(),null,'kHub bot',3888760,body,'other',true) returning * into r;
    update khub_bot.delivery_preparation_reviews set report_id=r.id where id=review_id;
    body:='Delivery D-'||d.reference_number||' set aside for review (B-'||r.report_number||').'
        ||E'\n'||p_reason||E'\nNo send was attempted. Other ready deliveries continue.'
        ||E'\nAdministrator inbox: /admin/inbox?category=other';
    insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
        values('delivery-preparation-review:'||review_id,3552305,'notice',body,body,'') returning id into alert;
    insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,alert);
end; $$;

create or replace function public.bot_claim_delivery(p_message_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; body text; failure_code text; reason text;
begin
    if p_message_version is distinct from 2 then raise exception 'Update the bot to message format version 2 before sending.'; end if;
    perform pg_advisory_xact_lock(3888760);
    perform khub_bot.suppress_previous_donation_plans();
    -- A preparation error is definitely unsent. An interrupted send is not:
    -- preserve the existing stop/reconciliation guards for uncertain transfers.
    if exists(select 1 from khub_bot.deliveries where state in ('sending','unknown')) then raise exception 'Uncertain delivery requires reconciliation. No automatic resend.'; end if;
    if exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown')) then raise exception 'Uncertain closet transfer requires reconciliation.'; end if;
    loop
        select x.* into d from khub_bot.deliveries x where x.state='pending'
            and not exists(select 1 from khub_bot.delivery_preparation_reviews h where h.delivery_id=x.id and h.released_at is null)
            order by x.created_at,x.id limit 1 for update;
        if not found then return null; end if;
        begin
            body:=coalesce(d.display_message,khub_bot.friendly_message(d));
            if body is null or btrim(body)='' then raise exception 'Delivery message is empty; inspect this delivery before sending.'; end if;
        exception
            when serialization_failure or deadlock_detected then raise;
            when others then
                failure_code:=sqlstate;
                reason:=case sqlerrm
                    when 'Unrecognized delivery template; inspect delivery before sending.' then 'Unrecognized delivery template; inspect delivery before sending.'
                    when 'Accepted bid amount missing; inspect delivery before sending.' then 'Accepted bid amount missing; inspect delivery before sending.'
                    when 'Delivery message is empty; inspect this delivery before sending.' then 'Delivery message is empty; inspect this delivery before sending.'
                    else 'Delivery message preparation failed; inspect this delivery before sending.' end;
                perform khub_bot.hold_unprepared_delivery(d.id,failure_code,reason);
                continue;
        end;
        update khub_bot.deliveries set state='sending',attempt=gen_random_uuid(),
            display_footer=case when display_message is null and dedupe_key like 'donation-thanks:%'
                then $footer$
*If this donation was sent in error, please KMail teres minor (#3552305) with the reference ID above.$footer$ else display_footer end,
            display_message=body where id=d.id returning * into d;
        return khub_bot.delivery_details(d);
    end loop;
end; $$;

create function public.bot_retry_held_delivery(p_id uuid,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; body text;
begin
    if p_evidence is null or char_length(btrim(p_evidence)) not between 12 and 1000 then
        raise exception 'Describe the correction in 12 to 1,000 characters.';
    end if;
    perform pg_advisory_xact_lock(3888760);
    select * into d from khub_bot.deliveries where id=p_id for update;
    if not found or d.state<>'pending' or not exists(select 1 from khub_bot.delivery_preparation_reviews where delivery_id=d.id and released_at is null) then
        raise exception 'This delivery is not awaiting preparation review.';
    end if;
    -- Do not release an unfixed formatter. Frozen message bodies stay unchanged.
    body:=coalesce(d.display_message,khub_bot.friendly_message(d));
    if body is null or btrim(body)='' then raise exception 'Delivery message is still empty.'; end if;
    update khub_bot.delivery_preparation_reviews set released_at=clock_timestamp(),release_evidence=btrim(p_evidence)
        where delivery_id=d.id and released_at is null;
end; $$;

-- Teach 064's read-only checks to distinguish held deliveries from the sendable
-- queue. Retain every existing inspection field and the credential redaction.
do $$ declare definition text; anchor text:=$anchor$where state='pending'$anchor$;
begin
    definition:=pg_get_functiondef('public.bot_inspect()'::regprocedure);
    if (char_length(definition)-char_length(replace(definition,anchor,'')))/char_length(anchor)<>2 then
        raise exception 'Unexpected inspection implementation; migration not applied.';
    end if;
    execute replace(definition,anchor,anchor||' and not exists(select 1 from khub_bot.delivery_preparation_reviews h where h.delivery_id=khub_bot.deliveries.id and h.released_at is null)');
end; $$;
alter function public.bot_inspect() set schema khub_bot;
alter function khub_bot.bot_inspect() rename to inspect_before_delivery_holds;
create function public.bot_inspect() returns jsonb
language sql stable security definer set search_path='' as $$
    select khub_bot.inspect_before_delivery_holds()||jsonb_build_object(
        'heldDeliveryCount',(select count(*) from khub_bot.delivery_preparation_reviews h join khub_bot.deliveries d on d.id=h.delivery_id where h.released_at is null and d.state='pending'),
        'heldDeliveryAttention',coalesce((select jsonb_agg(jsonb_build_object(
            'id',d.id,'delivery_reference','D-'||d.reference_number,'kind',d.kind,
            'created_at',h.created_at,'reason',h.reason,'error_code',h.error_code,
            'support_reference','B-'||r.report_number
        ) order by h.created_at,h.id) from khub_bot.delivery_preparation_reviews h
            join khub_bot.deliveries d on d.id=h.delivery_id
            left join khub_bot.bug_reports r on r.id=h.report_id where h.released_at is null and d.state='pending'),'[]'::jsonb));
$$;
revoke all on function khub_bot.hold_unprepared_delivery(uuid,text,text),khub_bot.inspect_before_delivery_holds() from public,anon,authenticated,service_role;
revoke all on function public.bot_claim_delivery(integer),public.bot_retry_held_delivery(uuid,text),public.bot_inspect() from public,anon,authenticated;
grant execute on function public.bot_claim_delivery(integer),public.bot_retry_held_delivery(uuid,text),public.bot_inspect() to service_role;
notify pgrst,'reload schema';
commit;
