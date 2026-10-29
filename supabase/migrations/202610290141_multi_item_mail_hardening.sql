-- Apply after 140 with workers stopped. No sent/uncertain message bodies are
-- rewritten. Financial rows, amounts, source receipts and dedupe keys stay intact.
begin;
select pg_advisory_xact_lock(3888760);

create function khub_bot.delivery_attachment_list(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare name text; lines text:='';
begin
    if d.item_id is not null then
        select x->>'name' into name from public.auctions a cross join lateral jsonb_array_elements(a.bundle_items) x
            where a.id=d.auction_id and (x->>'id')::integer=d.item_id;
        if name is null then select c.name into name from khub_bot.catalog c where c.id=d.item_id;end if;
        lines:='- '||khub_bot.format_message_number(d.quantity)||' × '||khub_bot.escape_report_kmail(coalesce(name,'item #'||d.item_id));
    end if;
    if d.meat>0 then lines:=lines||case when lines<>'' then E'\n' else '' end||'- '||khub_bot.format_message_number(d.meat)||' Meat';end if;
    return lines;
end;$$;

create function khub_bot.prepare_bundle_mail(d khub_bot.deliveries,p_body text) returns text
language plpgsql stable set search_path='' as $$
declare a public.auctions%rowtype; title text; context text; contents text; line text; result text:=''; inserted boolean:=false; attachment text;
begin
    if p_body is null then return null;end if;
    select * into a from public.auctions where id=d.auction_id;
    if a.bundle_items<>'[]'::jsonb then
        title:=khub_bot.escape_report_kmail(a.item);
        select string_agg('- '||khub_bot.format_message_number((x->>'quantity')::bigint)||' × '
            ||khub_bot.escape_report_kmail(x->>'name'),E'\n' order by n) into contents
            from jsonb_array_elements(a.bundle_items) with ordinality as t(x,n);
        context:=title||E'\nBundle contents:\n'||contents;
        if strpos(p_body,context)=0 then
            -- Recognize both escrow and Direct Trade title lines. Keep narrative
            -- text and trade instructions unchanged; expand only the title line.
            for line in select unnest(string_to_array(p_body,E'\n')) loop
                if not inserted and line in (title,title||' × 1','1 x '||title,'1 × '||title,'1 x '||khub_bot.escape_report_kmail(left(a.item,80))) then
                    line:=context;inserted:=true;
                end if;
                result:=result||case when result<>'' then E'\n' else '' end||line;
            end loop;
            if not inserted then
                if strpos(p_body,'Auction #'||a.auction_number||E'\n')>0 then
                    result:=replace(p_body,'Auction #'||a.auction_number||E'\n','Auction #'||a.auction_number||E'\n'||context||E'\n');
                else result:=p_body||E'\n\nAuction #'||a.auction_number||E'\n'||context;end if;
            end if;
            p_body:=result;
        end if;
    end if;
    -- All individual item deliveries, including rejected deposits, identify the
    -- actual attached item. Gift fallback sends this same frozen body unchanged.
    if d.item_id is not null and strpos(p_body,E'\nAttached in this message: ')=0
        and strpos(p_body,E'\nAttached in this package: ')=0 then
        attachment:=E'\n\nThis message contains:\n'||khub_bot.delivery_attachment_list(d);
        if right(p_body,length(attachment))<>attachment then p_body:=p_body||attachment;end if;
    end if;
    return p_body;
end;$$;

alter function khub_bot.friendly_message(khub_bot.deliveries) rename to friendly_before_bundle_contents;
create function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
begin return khub_bot.prepare_bundle_mail(d,khub_bot.friendly_before_bundle_contents(d));end;$$;

-- Covers preformatted Direct Trade reminders and other explicit notices, as well
-- as templates frozen during claim. Never alter bodies already sent or uncertain.
create function khub_bot.prepare_new_bundle_message() returns trigger
language plpgsql set search_path='' as $$
begin
    if new.display_message is not null and new.state in ('pending','sending')
        and (tg_op='INSERT' or old.state='pending') then
        new.display_message:=khub_bot.prepare_bundle_mail(new,new.display_message);
    end if;
    return new;
end;$$;
create trigger prepare_new_bundle_message before insert or update of display_message on khub_bot.deliveries
    for each row execute function khub_bot.prepare_new_bundle_message();

alter function khub_bot.multi_mail_body(khub_bot.deliveries) rename to multi_body_before_contents;
create function khub_bot.multi_mail_body(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare body text; attachment text; plain khub_bot.deliveries%rowtype;
begin
    body:=khub_bot.multi_body_before_contents(d);
    -- The attachment list is envelope-specific, not part of the common message.
    -- Strip only the exact suffix generated from this row's trusted assets.
    attachment:=E'\n\nThis message contains:\n'||khub_bot.delivery_attachment_list(d);
    if d.item_id is not null and right(body,length(attachment))=attachment then body:=left(body,length(body)-length(attachment));end if;
    plain:=d;plain.item_id:=null;plain.quantity:=0;
    return khub_bot.prepare_bundle_mail(plain,body);
end;$$;

-- Extend eligible returns to Buy-auction rejections/excess returns. Actual Buy
-- purchase shipments retain their specialized preparation/packaging protections.
do $$ declare definition text; anchor text:='d.dedupe_key like ''buy-%''';
begin
    definition:=pg_get_functiondef('public.bot_claim_delivery_batch(integer)'::regprocedure);
    if strpos(definition,anchor)=0 then raise exception 'Unexpected 140 batch selector; inspect before applying 141.';end if;
    execute replace(definition,anchor,'(d.dedupe_key like ''buy-%'' and d.kind=''sale_item'')');
end;$$;

-- Freeze the full actual envelope list alongside its reference. The bundle list
-- above describes the auction; this list describes only what THIS mail contains.
create function khub_bot.freeze_batch_attachment_list() returns trigger
language plpgsql set search_path='' as $$
declare lines text;
begin
    if new.mail_batch=new.id and new.mail_batch_body is not null
        and (old.mail_batch is distinct from new.mail_batch or old.mail_batch_body is distinct from new.mail_batch_body) then
        select string_agg(khub_bot.delivery_attachment_list(d),E'\n' order by d.item_id nulls last,d.id) into lines
            from khub_bot.deliveries d where d.mail_batch=new.id or d.id=new.id;
        new.mail_batch_body:=new.mail_batch_body||E'\n\nThis message contains:\n'||lines;
    end if;
    return new;
end;$$;
create trigger freeze_batch_attachment_list before update of mail_batch,mail_batch_body on khub_bot.deliveries
    for each row execute function khub_bot.freeze_batch_attachment_list();

-- One envelope is one acknowledgment: validate every claim before changing any
-- row and run settlement once, rather than once per attachment under the lock.
create or replace function public.bot_ack_delivery(p_id uuid,p_attempt uuid,p_sent boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; expected integer; changed integer;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into d from khub_bot.deliveries where id=p_id for update;
    if d.mail_batch is not null and d.mail_batch<>d.id then raise exception 'Acknowledge the batch reference, not an individual member.';end if;
    if d.mail_batch is null then perform khub_bot.ack_before_multi_mail(p_id,p_attempt,p_sent,p_evidence);return;end if;
    if p_sent is null then raise exception 'Choose sent or not-sent.';end if;
    perform 1 from khub_bot.deliveries where mail_batch=d.id order by id for update;
    select count(*) into expected from khub_bot.deliveries where mail_batch=d.id;
    update khub_bot.deliveries set state=case when p_sent then 'sent' else 'unknown' end,
        sent_at=case when p_sent then clock_timestamp() end,evidence=p_evidence
        where mail_batch=d.id and state='sending' and attempt=p_attempt;
    get diagnostics changed=row_count;
    if expected<2 or changed<>expected then raise exception 'Delivery claim does not match. Reconcile before continuing.';end if;
    perform public.bot_tick();
end;$$;

-- A positively verified not-sent regular envelope can be grouped again. This
-- does NOT release uncertain sends, preparation holds, or known gift-only splits.
do $$ declare definition text; anchor text:='mail_batch_disabled=true';
begin
    definition:=pg_get_functiondef('public.bot_reconcile_delivery(uuid,boolean,text)'::regprocedure);
    if strpos(definition,anchor)=0 then raise exception 'Unexpected 140 reconciliation; inspect before applying 141.';end if;
    execute replace(definition,anchor,'mail_batch_disabled=false');
end;$$;

revoke all on function khub_bot.delivery_attachment_list(khub_bot.deliveries),khub_bot.prepare_bundle_mail(khub_bot.deliveries,text),
    khub_bot.friendly_before_bundle_contents(khub_bot.deliveries),khub_bot.friendly_message(khub_bot.deliveries),
    khub_bot.prepare_new_bundle_message(),khub_bot.multi_body_before_contents(khub_bot.deliveries),khub_bot.multi_mail_body(khub_bot.deliveries),
    khub_bot.freeze_batch_attachment_list() from public,anon,authenticated,service_role;
revoke all on function public.bot_ack_delivery(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.bot_ack_delivery(uuid,uuid,boolean,text) to service_role;
notify pgrst,'reload schema';
commit;
