-- Apply after 078, then upgrade the Oracle worker and deploy the website.
-- Stop the old worker before applying: it cannot supply verified inbox scans.
-- Existing completed/settling auctions and recorded payment obligations stay frozen.
begin;
select pg_advisory_xact_lock(3888760);

alter table public.auctions add column escrow_buyout_received_at timestamptz,
    add column escrow_buyout_mail_id text,
    add column escrow_timing_review boolean not null default false;
create table khub_bot.inbox_scans (
    id uuid primary key default gen_random_uuid(), started_at timestamptz not null default clock_timestamp(),
    staged_at timestamptz, completed_at timestamptz
);
create table khub_bot.inbox_bid_mail (
    mail_id text primary key check(mail_id ~ '^[1-9][0-9]{0,15}$'),
    payload jsonb not null, received_at timestamptz not null, processed boolean not null default false
);
create table khub_bot.escrow_mail_order (
    auction_id uuid primary key references public.auctions(id) on delete cascade,
    received_at timestamptz not null, mail_id bigint not null
);
create table khub_bot.escrow_close_authorizations (
    auction_id uuid primary key references public.auctions(id) on delete cascade,
    scan_id uuid not null references khub_bot.inbox_scans(id)
);
alter table khub_bot.inbox_scans enable row level security;
alter table khub_bot.inbox_bid_mail enable row level security;
alter table khub_bot.escrow_mail_order enable row level security;
alter table khub_bot.escrow_close_authorizations enable row level security;
revoke all on khub_bot.inbox_scans,khub_bot.inbox_bid_mail,khub_bot.escrow_mail_order,
    khub_bot.escrow_close_authorizations from public,anon,authenticated,service_role;

-- Existing accepted bids participate in ordering checks without changing them.
insert into khub_bot.escrow_mail_order(auction_id,received_at,mail_id)
    select a.id,r.received_at,r.mail_id::bigint from public.auctions a
    join public.bids b on b.auction_id=a.id and b.amount=a.current_bid
    join khub_bot.bid_receipts br on br.bid_id=b.id
    join khub_bot.receipts r on r.mail_id=br.receipt_id
    where a.escrow_mode and a.status='active';

create function khub_bot.hold_escrow_mail_timing(p_id uuid,p_mail_id text) returns void
language plpgsql security definer set search_path='' as $$
declare r khub_bot.bug_reports%rowtype; alert uuid; body text;
begin
    update public.auctions set status='on_hold',escrow_timing_review=true
        where id=p_id and status='active' and not escrow_timing_review;
    if not found then return; end if;
    body:='Escrow bid ordering needs review for auction '||p_id||'. KMail '||p_mail_id
        ||' was encountered out of order or the previous bid has no verified receipt. No winner or payout was declared; existing escrow remains reserved.';
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category,is_system)
        values(gen_random_uuid(),null,'kHub bot',3888760,body,'other',true) returning * into r;
    insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
        values('escrow-timing-review:'||p_id,3552305,'notice',body,body,'') returning id into alert;
    insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,alert);
end; $$;
revoke all on function khub_bot.hold_escrow_mail_timing(uuid,text) from public,anon,authenticated,service_role;

create function public.bot_begin_inbox_scan() returns jsonb
language plpgsql security definer set search_path='' as $$
declare scan khub_bot.inbox_scans%rowtype;
begin
    insert into khub_bot.inbox_scans default values returning * into scan;
    return jsonb_build_object('id',scan.id,'started_at',scan.started_at);
end; $$;

create function public.bot_stage_inbox_scan(p_scan_id uuid,p_mails jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare scan khub_bot.inbox_scans%rowtype; mail jsonb; mid text; received timestamptz;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into scan from khub_bot.inbox_scans where id=p_scan_id for update;
    if not found or scan.staged_at is not null or scan.completed_at is not null
        or scan.started_at<clock_timestamp()-interval '15 minutes' then raise exception 'Start a fresh complete inbox scan.'; end if;
    if jsonb_typeof(p_mails) is distinct from 'array' or jsonb_array_length(p_mails)>10000 then
        raise exception 'Invalid inbox manifest.';
    end if;
    for mail in select value from jsonb_array_elements(p_mails) loop
        if mail#>>'{command,type}' not in ('bid','buy') then continue; end if;
        mid:=mail->>'id'; received:=(mail->>'received_at')::timestamptz;
        if mid is null or mid!~'^[1-9][0-9]{0,15}$' or mid::numeric>9007199254740991
            or received is null or received>clock_timestamp()+interval '5 seconds'
            or mail#>>'{raw,azunixtime}' is null
            or mail#>>'{raw,azunixtime}' !~ '^[0-9]{1,12}$'
            or to_timestamp((mail#>>'{raw,azunixtime}')::bigint)<>received then
            raise exception 'Invalid KoL bid timestamp; retain the mail for review.';
        end if;
        if exists(select 1 from khub_bot.inbox_bid_mail where mail_id=mid and payload<>mail) then
            raise exception 'KMail ID payload changed; retain mail for review.';
        end if;
        insert into khub_bot.inbox_bid_mail(mail_id,payload,received_at) values(mid,mail,received)
            on conflict(mail_id) do nothing;
    end loop;
    update khub_bot.inbox_scans set staged_at=clock_timestamp() where id=p_scan_id;
    -- Pending mail from an interrupted cycle is durable, even if it no longer
    -- appears in the latest API page. Always resume the complete ordered queue.
    return coalesce((select jsonb_agg(payload order by received_at,mail_id::bigint)
        from khub_bot.inbox_bid_mail where not processed),'[]'::jsonb);
end; $$;

-- Prevent every historical/public deadline path and old bot_tick from releasing
-- escrow assets. Only a completed, post-grace inbox scan can authorize closing.
alter function khub_bot.finish_listing(uuid,text) rename to finish_listing_before_receipt_time;
revoke all on function khub_bot.finish_listing_before_receipt_time(uuid,text) from public,anon,authenticated,service_role;
create function khub_bot.finish_listing(p_id uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if p_reason in ('deadline','instant') and not exists(
        select 1 from khub_bot.escrow_close_authorizations c
        join khub_bot.inbox_scans s on s.id=c.scan_id
        join public.auctions a on a.id=c.auction_id
        where c.auction_id=p_id and s.completed_at is not null
            and s.started_at>=coalesce(a.escrow_buyout_received_at,a.end_time)+interval '60 seconds'
    ) then return; end if;
    perform khub_bot.finish_listing_before_receipt_time(p_id,p_reason);
    if p_reason='instant' then
        update public.auctions set instant_purchased_at=escrow_buyout_received_at where id=p_id and escrow_buyout_received_at is not null and status='settling';
    end if;
end; $$;
revoke all on function khub_bot.finish_listing(uuid,text) from public,anon,authenticated,service_role;

-- Preserve the complete funded validation/refund implementation and exact bid
-- receipt linkage. Only the eligibility clock and immediate buyout close change.
do $$
declare definition text;
    cutoff text := 'a.status<>''active'' or a.end_time<=clock_timestamp()';
    instant text := 'perform khub_bot.finish_listing(aid,''instant'');';
begin
    definition:=pg_get_functiondef('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure);
    if strpos(definition,cutoff)=0 or strpos(definition,instant)=0 then
        raise exception 'Unexpected escrow intake; receipt-time migration not applied.';
    end if;
    definition:=replace(definition,cutoff,
        'a.status<>''active'' or a.escrow_buyout_received_at is not null or (p_mail->>''received_at'')::timestamptz>=a.end_time');
    definition:=replace(definition,instant,
        'update public.auctions set escrow_buyout_received_at=(p_mail->>''received_at'')::timestamptz,escrow_buyout_mail_id=mid where id=aid;');
    execute definition;
end; $$;

alter function public.bot_ingest_mail(jsonb) set schema khub_bot;
alter function khub_bot.bot_ingest_mail(jsonb) rename to ingest_before_receipt_time;
revoke all on function khub_bot.ingest_before_receipt_time(jsonb) from public,anon,authenticated,service_role;
create function public.bot_ingest_mail(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare mid text:=p_mail->>'id'; received timestamptz; listing public.auctions%rowtype;
    cursor_row khub_bot.escrow_mail_order%rowtype; result text;
begin
    perform pg_advisory_xact_lock(3888760);
    if p_mail#>>'{command,type}' in ('bid','buy') then
        if not exists(select 1 from khub_bot.inbox_bid_mail where mail_id=mid and payload=p_mail) then
            raise exception 'Bid intake requires a complete staged inbox scan; upgrade the worker.';
        end if;
        if not exists(select 1 from khub_bot.receipts where mail_id=mid) and exists(
            select 1 from khub_bot.inbox_bid_mail m where not m.processed
                and (m.received_at,m.mail_id::bigint)<((p_mail->>'received_at')::timestamptz,mid::bigint)
        ) then raise exception 'Process pending bid mail in KoL timestamp and message-ID order.'; end if;
        received:=(p_mail->>'received_at')::timestamptz;
        select * into listing from public.auctions a where a.escrow_mode and
            case when (p_mail->'command') ? 'auction_number'
                then a.auction_number::text=p_mail#>>'{command,auction_number}'
                else a.id::text=lower(p_mail#>>'{command,auction_id}') end for update;
        if listing.id is not null and listing.status='active'
            and not exists(select 1 from khub_bot.receipts where mail_id=mid) then
            select * into cursor_row from khub_bot.escrow_mail_order where auction_id=listing.id;
            if (found and (received,mid::bigint)<(cursor_row.received_at,cursor_row.mail_id))
                or (not found and listing.current_bid>0) then
                -- Do not silently choose an uncertain winner or reopen a refund.
                -- Existing funds stay protected; this auction needs admin review.
                perform khub_bot.hold_escrow_mail_timing(listing.id,mid);
            end if;
        end if;
    end if;
    result:=khub_bot.ingest_before_receipt_time(p_mail);
    if p_mail#>>'{command,type}' in ('bid','buy') then
        update khub_bot.inbox_bid_mail set processed=true where mail_id=mid;
        if result='accepted' and listing.id is not null then
            insert into khub_bot.escrow_mail_order(auction_id,received_at,mail_id) values(listing.id,received,mid::bigint)
                on conflict(auction_id) do update set received_at=excluded.received_at,mail_id=excluded.mail_id;
        end if;
    end if;
    return result;
end; $$;

create function public.bot_finish_inbox_scan(p_scan_id uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare scan khub_bot.inbox_scans%rowtype; listing public.auctions%rowtype; count_closed integer:=0;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into scan from khub_bot.inbox_scans where id=p_scan_id for update;
    if not found or scan.staged_at is null or scan.completed_at is not null
        or scan.started_at<clock_timestamp()-interval '15 minutes' then raise exception 'Start a fresh complete inbox scan.'; end if;
    if exists(select 1 from khub_bot.inbox_bid_mail where not processed) then
        raise exception 'Pending bid mail must be processed before settlement.';
    end if;
    update khub_bot.inbox_scans set completed_at=clock_timestamp() where id=p_scan_id;
    for listing in select * from public.auctions a where a.escrow_mode and a.status='active'
        and coalesce(a.escrow_buyout_received_at,a.end_time)+interval '60 seconds'<=scan.started_at
        order by a.id for update
    loop
        insert into khub_bot.escrow_close_authorizations values(listing.id,p_scan_id);
        perform khub_bot.finish_listing(listing.id,case when listing.escrow_buyout_received_at is not null then 'instant' else 'deadline' end);
        delete from khub_bot.escrow_close_authorizations where auction_id=listing.id;
        count_closed:=count_closed+1;
    end loop;
    -- Keep unprocessed payloads for crash recovery; completed scans/processed
    -- staging copies are disposable. Original financial receipts stay untouched.
    delete from khub_bot.inbox_scans where completed_at<clock_timestamp()-interval '7 days';
    delete from khub_bot.inbox_bid_mail where processed and received_at<clock_timestamp()-interval '7 days';
    return count_closed;
end; $$;

revoke all on function public.bot_begin_inbox_scan(),public.bot_stage_inbox_scan(uuid,jsonb),
    public.bot_finish_inbox_scan(uuid),public.bot_ingest_mail(jsonb) from public,anon,authenticated;
grant execute on function public.bot_begin_inbox_scan(),public.bot_stage_inbox_scan(uuid,jsonb),
    public.bot_finish_inbox_scan(uuid),public.bot_ingest_mail(jsonb) to service_role;

alter function public.bot_inspect() rename to bot_inspect_before_receipt_time;
alter function public.bot_inspect_before_receipt_time() set schema khub_bot;
revoke all on function khub_bot.bot_inspect_before_receipt_time() from public,anon,authenticated,service_role;
create function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
    select khub_bot.bot_inspect_before_receipt_time()||jsonb_build_object('receiptTimeBiddingVersion',1);
$$;
revoke all on function public.bot_inspect() from public,anon,authenticated;
grant execute on function public.bot_inspect() to service_role;

alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to public_auction_before_receipt_time;
revoke all on function khub_bot.public_auction_before_receipt_time(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language sql stable security definer set search_path='' as $$
    select khub_bot.public_auction_before_receipt_time(a,p_bid_count,p_highest_label,p_winner_label)
        ||jsonb_build_object('receipt_time_bidding',a.escrow_mode,
            'bid_deadline',case when a.escrow_mode then coalesce(a.escrow_buyout_received_at,a.end_time) else a.end_time end,
            'escrow_timing_review',a.escrow_timing_review,
            'finalization_not_before',case when a.escrow_mode then coalesce(a.escrow_buyout_received_at,a.end_time)+interval '60 seconds' end);
$$;
revoke all on function khub_bot.public_auction(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;

do $$
declare signature regprocedure; definition text;
begin
    foreach signature in array array[
        'public.read_auction_page(text,uuid,text,text,text,integer)'::regprocedure,
        'public.read_auction_page(text,uuid,text,text,text,integer,text)'::regprocedure
    ] loop
        definition:=pg_get_functiondef(signature);
        if strpos(definition,'''privacy_version'',1,')=0 then raise exception 'Unexpected auction reader.'; end if;
        definition:=replace(definition,'''privacy_version'',1,','''privacy_version'',1,''server_time'',clock_timestamp(),');
        definition:=replace(definition,'a.end_time>statement_timestamp()',
            'coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp()');
        definition:=replace(definition,'a.end_time<=statement_timestamp()',
            'coalesce(a.escrow_buyout_received_at,a.end_time)<=statement_timestamp()');
        execute definition;
    end loop;
    definition:=pg_get_functiondef('khub_bot.hot_auction_ids()'::regprocedure);
    execute replace(definition,'a.end_time>statement_timestamp()',
        'coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp()');
end; $$;
notify pgrst,'reload schema';
commit;
