-- Stop workers, apply once, then deploy the matching worker. Existing individual
-- asset rows remain the source of truth for liabilities and settlement.
begin;
alter table khub_bot.deliveries
    add column mail_batch uuid references khub_bot.deliveries(id),
    add column mail_batch_body text,
    add column mail_batch_disabled boolean not null default false;
create index deliveries_mail_batch_idx on khub_bot.deliveries(mail_batch) where mail_batch is not null;
create table khub_bot.mail_batch_splits (
    delivery_id uuid not null references khub_bot.deliveries(id), attempt uuid not null,
    created_at timestamptz not null default clock_timestamp(), primary key(delivery_id,attempt)
);
alter table khub_bot.mail_batch_splits enable row level security;
revoke all on khub_bot.mail_batch_splits from public,anon,authenticated;
grant select on khub_bot.mail_batch_splits to service_role;

alter function khub_bot.delivery_details(khub_bot.deliveries) rename to delivery_details_before_multi_mail;
create function khub_bot.delivery_details(d khub_bot.deliveries) returns jsonb
language sql stable set search_path='' as $$
    select khub_bot.delivery_details_before_multi_mail(d)
        || case when d.mail_batch=d.id then jsonb_build_object(
            'display_message',coalesce(d.mail_batch_body,d.display_message),
            'items',coalesce((select jsonb_agg(jsonb_build_object('id',x.item_id,'quantity',x.quantity::text) order by x.item_id)
                from khub_bot.deliveries x where x.mail_batch=d.id and x.item_id is not null),'[]'::jsonb),
            'meat',(select sum(x.meat)::text from khub_bot.deliveries x where x.mail_batch=d.id))
        when d.mail_batch is not null then jsonb_build_object('batch_reference',
            (select 'D-'||x.reference_number from khub_bot.deliveries x where x.id=d.mail_batch))
        else '{}'::jsonb end;
$$;

-- Bundle and gift templates formerly named a single attachment. Normalize only
-- those recognized, unchanged templates for the shared envelope. The original
-- frozen row messages remain intact for individual gift fallback/history.
create function khub_bot.multi_mail_body(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare body text; expected text; a public.auctions%rowtype;
begin
    body:=coalesce(d.display_message,khub_bot.friendly_message(d));
    begin expected:=khub_bot.friendly_message(d);
    exception when serialization_failure or deadlock_detected then raise;
        when others then return body;end;
    if body is distinct from expected then return body;end if;
    if d.dedupe_key like 'gift-return:%' then
        return E'Your gift contents are being returned.\n\nOriginal KMail: '||d.receipt_id
            ||E'\n\nYour returned items and Meat are attached. Any remaining contents arrive separately. Original packaging is not included.';
    end if;
    select * into a from public.auctions where id=d.auction_id;
    if a.bundle_items<>'[]'::jsonb and d.kind in ('sale_item','return_item') then
        return case when d.kind='sale_item' then 'You won the bundle!' else 'Your bundle items are being returned.' end
            ||E'\n\nAuction #'||a.auction_number||E'\n'||khub_bot.escape_report_kmail(a.item)
            ||E'\n\nThe attached items belong to this bundle. Any remaining items arrive separately.';
    end if;
    return body;
end;$$;

-- Call the existing guarded claim first. Only siblings from the EXACT same queue
-- plan can join it; no unrelated mail, Buy packaging groups, held or uncertain
-- rows may be swept into a send. Distinct item types only, <=11 slots, <=1b Meat.
create function public.bot_claim_delivery_batch(p_message_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; d khub_bot.deliveries%rowtype; x khub_bot.deliveries%rowtype;
    root_key text; seen integer[]:='{}'; total_meat bigint; members integer:=1; body text; group_body text;
begin
    perform pg_advisory_xact_lock(3888760);
    result:=public.bot_claim_delivery(p_message_version);
    if result is null then return null;end if;
    select * into strict d from khub_bot.deliveries where id=(result->>'id')::uuid for update;
    if d.mail_batch_disabled or d.kind not in ('refund','return_item','sale_item')
        or d.dedupe_key like 'buy-%' or d.dedupe_key !~ ':(item:[0-9]+|meat):[0-9]+$' then return result;end if;
    root_key:=regexp_replace(d.dedupe_key,':(item:[0-9]+|meat):[0-9]+$','');
    if d.item_id is not null then seen:=array[d.item_id];end if;
    total_meat:=d.meat; group_body:=khub_bot.multi_mail_body(d);
    for x in select s.* from khub_bot.deliveries s where s.state='pending' and not s.mail_batch_disabled
        and s.mail_batch is null and s.kind=d.kind and s.recipient_id=d.recipient_id
        and s.auction_id is not distinct from d.auction_id and s.receipt_id is not distinct from d.receipt_id
        and s.message=d.message and s.dedupe_key ~ ':(item:[0-9]+|meat):[0-9]+$'
        and regexp_replace(s.dedupe_key,':(item:[0-9]+|meat):[0-9]+$','')=root_key
        and not exists(select 1 from khub_bot.delivery_preparation_reviews h where h.delivery_id=s.id and h.released_at is null)
        and not exists(select 1 from khub_bot.buy_delivery_waits w where w.delivery_id=s.id and w.retry_after>clock_timestamp())
        and not exists(select 1 from khub_bot.gift_delivery_waits w where w.delivery_id=s.id and w.retry_after>clock_timestamp())
        order by s.created_at,s.id for update
    loop
        if x.item_id=any(seen) or (x.item_id is not null and cardinality(seen)>=11)
            or total_meat+x.meat>1000000000 then continue;end if;
        -- Frozen per-item wording may differ for some special delivery kinds.
        -- Such rows stay individual rather than losing their original message.
        begin body:=khub_bot.multi_mail_body(x);
        exception when serialization_failure or deadlock_detected then raise;
            when others then continue;end;
        if body is distinct from group_body or x.display_footer is distinct from d.display_footer then continue;end if;
        update khub_bot.deliveries set state='sending',attempt=d.attempt,display_message=coalesce(display_message,khub_bot.friendly_message(x)),mail_batch=d.id where id=x.id;
        seen:=case when x.item_id is null then seen else array_append(seen,x.item_id) end;
        total_meat:=total_meat+x.meat; members:=members+1;
        exit when members>=12;
    end loop;
    if members>1 then
        update khub_bot.deliveries set mail_batch=id,mail_batch_body=group_body where id=d.id returning * into d;
        return khub_bot.delivery_details(d);
    end if;
    return result;
end;$$;

-- Only a known pre-gift non-attempt or an explicit game rejection may split a
-- batch. This RPC is never called for a timeout or ambiguous acknowledgment.
create function public.bot_split_delivery_batch(p_id uuid,p_attempt uuid) returns void
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.mail_batch_splits where delivery_id=p_id and attempt=p_attempt) then return;end if;
    select * into d from khub_bot.deliveries where id=p_id for update;
    if not found or d.mail_batch is distinct from d.id or d.state<>'sending' or d.attempt is distinct from p_attempt
        or exists(select 1 from khub_bot.deliveries x where x.mail_batch=d.id and (x.state<>'sending' or x.attempt is distinct from p_attempt))
        then raise exception 'Batch claim changed; inspect before splitting.';end if;
    insert into khub_bot.mail_batch_splits(delivery_id,attempt) values(p_id,p_attempt);
    update khub_bot.deliveries set state='pending',attempt=null,mail_batch=null,mail_batch_body=null,mail_batch_disabled=true,
        evidence='No assets sent: recipient requires individual gift packaging.' where mail_batch=p_id;
end;$$;

alter function public.bot_ack_delivery(uuid,uuid,boolean,text) set schema khub_bot;
alter function khub_bot.bot_ack_delivery(uuid,uuid,boolean,text) rename to ack_before_multi_mail;
create function public.bot_ack_delivery(p_id uuid,p_attempt uuid,p_sent boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype;x record;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into d from khub_bot.deliveries where id=p_id for update;
    if d.mail_batch is not null and d.mail_batch<>d.id then raise exception 'Acknowledge the batch reference, not an individual member.';end if;
    if d.mail_batch is null then perform khub_bot.ack_before_multi_mail(p_id,p_attempt,p_sent,p_evidence);return;end if;
    for x in select id from khub_bot.deliveries where mail_batch=d.id order by id for update loop
        perform khub_bot.ack_before_multi_mail(x.id,p_attempt,p_sent,p_evidence);
    end loop;
end;$$;

alter function public.bot_reconcile_delivery(uuid,boolean,text) set schema khub_bot;
alter function khub_bot.bot_reconcile_delivery(uuid,boolean,text) rename to reconcile_before_multi_mail;
create function public.bot_reconcile_delivery(p_id uuid,p_sent boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
declare leader uuid;x record;
begin
    perform pg_advisory_xact_lock(3888760);
    select mail_batch into leader from khub_bot.deliveries where id=p_id for update;
    if leader is null then perform khub_bot.reconcile_before_multi_mail(p_id,p_sent,p_evidence);return;end if;
    for x in select id from khub_bot.deliveries where mail_batch=leader order by id for update loop
        perform khub_bot.reconcile_before_multi_mail(x.id,p_sent,p_evidence);
    end loop;
    if not p_sent then update khub_bot.deliveries set mail_batch=null,mail_batch_body=null,mail_batch_disabled=true where mail_batch=leader;end if;
end;$$;

-- One Sent Mail record proves the entire envelope, using the leader's frozen
-- body/reference AND complete attachment manifest. Never resend on absence.
alter function public.bot_mailbox_check_deliveries() set schema khub_bot;
alter function khub_bot.bot_mailbox_check_deliveries() rename to mailbox_before_multi_mail;
create function public.bot_mailbox_check_deliveries() returns jsonb
language sql stable security definer set search_path='' as $$
    select coalesce(jsonb_agg(value || case when value->>'mail_batch'=value->>'id' then
            jsonb_build_object('expected_message',(value->>'display_message')||E'\n\n'||(value->>'reference_marker')
                ||case when coalesce(value->>'display_footer','')<>'' then E'\n'||(value->>'display_footer') else '' end)
            else '{}'::jsonb end),'[]'::jsonb)
        from jsonb_array_elements(khub_bot.mailbox_before_multi_mail())
        where value->>'mail_batch' is null or value->>'mail_batch'=value->>'id';
$$;
alter function public.bot_record_mailbox_check(uuid,uuid,jsonb) set schema khub_bot;
alter function khub_bot.bot_record_mailbox_check(uuid,uuid,jsonb) rename to record_mailbox_before_multi_mail;
create function public.bot_record_mailbox_check(p_id uuid,p_attempt uuid,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype;result jsonb;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into d from khub_bot.deliveries where id=p_id for update;
    if d.mail_batch is not null and d.mail_batch<>d.id then raise exception 'Check the batch reference, not an individual member.';end if;
    result:=khub_bot.record_mailbox_before_multi_mail(p_id,p_attempt,p_result);
    if d.mail_batch=d.id and result->>'status'='isolated' then
        update khub_bot.deliveries set state='unknown' where mail_batch=d.id and state='sending';
        -- Share one operator report while retaining every disputed liability.
        insert into khub_bot.delivery_mailbox_reviews(delivery_id,attempt,check_status,candidate_ids,report_id)
            select x.id,x.attempt,h.check_status,h.candidate_ids,h.report_id
            from khub_bot.deliveries x join khub_bot.delivery_mailbox_reviews h on h.delivery_id=d.id and h.resolved_at is null
            where x.mail_batch=d.id and x.id<>d.id
            on conflict(delivery_id) where resolved_at is null do update set
                check_status=excluded.check_status,candidate_ids=excluded.candidate_ids,checked_at=clock_timestamp();
    end if;
    return result;
end;$$;

-- Resolve any member reference to the full envelope so manual operators see
-- every asset they are confirming, rather than just one component.
alter function public.bot_lookup_delivery(text) set schema khub_bot;
alter function khub_bot.bot_lookup_delivery(text) rename to lookup_before_multi_mail;
create function public.bot_lookup_delivery(p_reference text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d jsonb;
begin
    d:=khub_bot.lookup_before_multi_mail(p_reference);
    if d->>'mail_batch' is not null and d->>'mail_batch'<>d->>'id' then
        d:=khub_bot.lookup_before_multi_mail(d->>'mail_batch');
    end if;
    return d;
end;$$;

-- Lightweight capability discovery; old workers continue individual claims.
alter function public.bot_worker_status() set schema khub_bot;
alter function khub_bot.bot_worker_status() rename to worker_status_before_multi_mail;
create function public.bot_worker_status() returns jsonb language sql security definer set search_path='' as $$
    select khub_bot.worker_status_before_multi_mail()||jsonb_build_object('multiItemMailVersion',1);
$$;
revoke all on function khub_bot.multi_mail_body(khub_bot.deliveries),khub_bot.delivery_details_before_multi_mail(khub_bot.deliveries),khub_bot.delivery_details(khub_bot.deliveries),
    khub_bot.ack_before_multi_mail(uuid,uuid,boolean,text),khub_bot.reconcile_before_multi_mail(uuid,boolean,text),
    khub_bot.mailbox_before_multi_mail(),khub_bot.record_mailbox_before_multi_mail(uuid,uuid,jsonb),khub_bot.worker_status_before_multi_mail(),khub_bot.lookup_before_multi_mail(text)
    from public,anon,authenticated,service_role;
revoke all on function public.bot_claim_delivery_batch(integer),public.bot_split_delivery_batch(uuid,uuid),
    public.bot_ack_delivery(uuid,uuid,boolean,text),public.bot_reconcile_delivery(uuid,boolean,text),public.bot_mailbox_check_deliveries(),
    public.bot_record_mailbox_check(uuid,uuid,jsonb),public.bot_worker_status(),public.bot_lookup_delivery(text) from public,anon,authenticated;
grant execute on function public.bot_claim_delivery_batch(integer),public.bot_split_delivery_batch(uuid,uuid),
    public.bot_ack_delivery(uuid,uuid,boolean,text),public.bot_reconcile_delivery(uuid,boolean,text),public.bot_mailbox_check_deliveries(),
    public.bot_record_mailbox_check(uuid,uuid,jsonb),public.bot_worker_status(),public.bot_lookup_delivery(text) to service_role;
notify pgrst,'reload schema';
commit;
