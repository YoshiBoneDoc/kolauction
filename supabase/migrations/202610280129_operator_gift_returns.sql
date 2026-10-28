-- Operator-requested return of verified, UNPROCESSED gift contents only.
-- No package opening, guessed contents or refunds of accepted/processed assets.
begin;
select pg_advisory_xact_lock(3888760);
create table khub_bot.gift_returns (
    mail_id text primary key references khub_bot.incoming_gifts(mail_id),
    recipient_id bigint not null check(recipient_id>0 and recipient_id<>3888760),
    fingerprint text not null, meat bigint not null check(meat>=0), items jsonb not null,
    deliveries jsonb not null check(jsonb_typeof(deliveries)='array'),
    evidence text not null check(length(btrim(evidence))>=20),
    created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.gift_returns enable row level security;
revoke all on khub_bot.gift_returns from public,anon,authenticated;
grant select on khub_bot.gift_returns to service_role;

create function public.bot_preview_gift_return(p_mail_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare g khub_bot.incoming_gifts%rowtype; r khub_bot.gift_returns%rowtype; blocked text; plan jsonb; fingerprint text;
begin
    if p_mail_id is null or p_mail_id!~'^[1-9][0-9]{0,15}$' then raise exception 'Use the original numeric KMail ID.'; end if;
    select * into r from khub_bot.gift_returns where mail_id=p_mail_id;
    if found then
        select coalesce(jsonb_agg(p||jsonb_build_object('state',coalesce(d.state,'history_unavailable')) order by p->>'reference'),'[]') into plan
            from jsonb_array_elements(r.deliveries) p left join khub_bot.deliveries d on d.id=(p->>'id')::uuid;
        return jsonb_build_object('mail_id',p_mail_id,'already_queued',true,'eligible',false,'fingerprint',r.fingerprint,
            'recipient_id',r.recipient_id,'meat',r.meat::text,'items',r.items,'deliveries',plan,'evidence',r.evidence,
            'status',case when jsonb_array_length(plan)>0 and not exists(select 1 from jsonb_array_elements(plan) x where x->>'state'<>'sent') then 'returned' else 'queued_or_review' end);
    end if;
    select * into g from khub_bot.incoming_gifts where mail_id=p_mail_id;
    if not found then blocked:='No registered gift with verified contents. Unknown or unregistered contents cannot be returned automatically.';
    elsif g.legacy_donation then blocked:='Historical donations require separate reconciliation; this command cannot refund them.';
    elsif g.payload is null or not exists(select 1 from khub_bot.gift_verified_contents where mail_id=p_mail_id) then
        blocked:='Gift contents have not been verified. This command never opens packages or guesses their contents.';
    elsif exists(select 1 from khub_bot.receipts where mail_id=p_mail_id)
        or exists(select 1 from khub_bot.deliveries where receipt_id=p_mail_id)
        or exists(select 1 from khub_bot.closet_transfers where receipt_id=p_mail_id) then
        blocked:='This gift already has processing, delivery or closet records. Inspect those obligations; do not create another refund.';
    elsif exists(select 1 from khub_bot.inbox_bid_mail where mail_id=p_mail_id and payload is distinct from g.payload) then
        blocked:='The staged mail payload differs from the verified gift. Reconcile before returning anything.';
    elsif (g.payload->>'sender_id') is distinct from (g.envelope->>'fromid')
        or g.payload->>'id' is distinct from g.mail_id then blocked:='Saved sender or KMail identity does not match the verified original.';
    elsif (g.payload->>'meat')::bigint=0 and jsonb_array_length(g.payload->'items')=0 then
        blocked:='The verified gift contains no Meat or items to return. The consumed wrapper is not a returnable asset.';
    end if;
    -- Optimistic payload version only; not an authentication credential.
    fingerprint:=md5(jsonb_build_object('payload',g.payload,'sender',g.envelope->>'fromid','wrapper',g.wrapper_id,'legacy',g.legacy_donation)::text);
    return jsonb_build_object('mail_id',p_mail_id,'eligible',blocked is null,'blocked_reason',blocked,'already_queued',false,
        'fingerprint',case when blocked is null then fingerprint end,
        'recipient_id',case when g.payload is not null then g.payload->>'sender_id' end,
        'recipient_name',g.envelope->>'fromname','meat',g.payload->>'meat','items',g.payload->'items','deliveries','[]'::jsonb);
end; $$;

create function public.bot_return_gift(p_mail_id text,p_fingerprint text,p_evidence text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare preview jsonb; g khub_bot.incoming_gifts%rowtype; plan jsonb;
begin
    if length(btrim(coalesce(p_evidence,'')))<20 then raise exception 'Record why the verified gift contents should be returned (at least 20 characters).'; end if;
    perform pg_advisory_xact_lock(3888760);
    preview:=public.bot_preview_gift_return(p_mail_id);
    if (preview->>'already_queued')::boolean then
        if p_fingerprint is distinct from preview->>'fingerprint' then raise exception 'Gift preview changed. Review it again before confirming.'; end if;
        return preview; -- The same command NEVER resets/requeues an uncertain send.
    end if;
    if not (preview->>'eligible')::boolean then raise exception '%',preview->>'blocked_reason'; end if;
    if p_fingerprint is null or p_fingerprint is distinct from preview->>'fingerprint' then raise exception 'Gift preview changed. Review it again before confirming.'; end if;
    select * into g from khub_bot.incoming_gifts where mail_id=p_mail_id for update;
    -- Original normalized payload stays unchanged. The receipt atomically removes
    -- it from unposted-gift liabilities/intake while refund deliveries replace it.
    insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result)
        values(p_mail_id,(g.payload->>'sender_id')::bigint,(g.payload->>'received_at')::timestamptz,g.payload,'Gift return queued by operator.');
    update khub_bot.inbox_bid_mail set processed=true where mail_id=p_mail_id and payload=g.payload;
    perform khub_bot.queue('gift-return:'||p_mail_id,null,p_mail_id,(g.payload->>'sender_id')::bigint,'refund',
        (g.payload->>'meat')::bigint,g.payload->'items','Operator-requested return of verified gift contents.');
    select jsonb_agg(jsonb_build_object('id',d.id,'reference','D-'||d.reference_number,'meat',d.meat::text,
        'item_id',d.item_id,'quantity',d.quantity::text) order by d.reference_number) into plan
        from khub_bot.deliveries d where d.receipt_id=p_mail_id and d.dedupe_key like 'gift-return:'||p_mail_id||':%';
    if coalesce(jsonb_array_length(plan),0)=0 then raise exception 'No return deliveries were queued; no review was cleared.'; end if;
    insert into khub_bot.gift_returns(mail_id,recipient_id,fingerprint,meat,items,deliveries,evidence)
        values(p_mail_id,(g.payload->>'sender_id')::bigint,p_fingerprint,(g.payload->>'meat')::bigint,g.payload->'items',plan,btrim(p_evidence));
    update khub_bot.gift_mail_reviews set resolved_at=clock_timestamp(),resolution='Verified contents return queued; see gift return audit. '||btrim(p_evidence)
        where mail_id=p_mail_id and resolved_at is null;
    -- Separate uncertain opening attempts and protected unknown assets stay intact.
    return public.bot_preview_gift_return(p_mail_id)||jsonb_build_object('newly_queued',true);
end; $$;

alter function khub_bot.friendly_message(khub_bot.deliveries) rename to message_before_operator_gift_returns;
create function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql set search_path='' as $$
declare attachment text;
begin
    if d.dedupe_key like 'gift-return:%' then
        attachment:=case when d.meat>0 then khub_bot.format_message_number(d.meat)||' Meat'
            when d.item_id is not null then khub_bot.format_message_number(d.quantity)||' x '||khub_bot.escape_report_kmail(coalesce((select name from khub_bot.catalog where id=d.item_id),'item #'||d.item_id))
            else 'No attachments' end;
        return E'Your gift contents are being returned.\n\nOriginal KMail: '||d.receipt_id
            ||E'\nAttached in this message: '||attachment||E'\n\nContents may arrive in separately tracked messages. Original packaging is not included.';
    end if;
    return khub_bot.message_before_operator_gift_returns(d);
end; $$;
revoke all on function public.bot_preview_gift_return(text),public.bot_return_gift(text,text,text),
    khub_bot.message_before_operator_gift_returns(khub_bot.deliveries),khub_bot.friendly_message(khub_bot.deliveries) from public,anon,authenticated;
grant execute on function public.bot_preview_gift_return(text),public.bot_return_gift(text,text,text) to service_role;
notify pgrst,'reload schema';
commit;
