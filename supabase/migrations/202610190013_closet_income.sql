-- Apply after 012 with all workers stopped; restart/deploy the matching worker.
-- Future listings charge 7.5%. Existing listings retain their agreed fee.
begin;
update khub_bot.settings set fee_bps=750 where id;
alter table khub_bot.settings alter column fee_bps set default 750;

create table khub_bot.closet_transfers (
    id uuid primary key default gen_random_uuid(),
    reference_number bigint generated always as identity (start with 1001) unique,
    dedupe_key text not null unique,
    source text not null check (source in ('donation','sale_fee','gift_package')),
    receipt_id text references khub_bot.receipts(mail_id),
    auction_id uuid references public.auctions(id),
    meat bigint not null default 0 check (meat between 0 and 1000000000),
    item_id integer, quantity bigint not null default 0 check (quantity between 0 and 1000000000),
    state text not null default 'pending' check (state in ('pending','moving','moved','unknown')),
    attempt uuid, before_state jsonb, evidence text,
    created_at timestamptz not null default clock_timestamp(), moved_at timestamptz,
    check ((meat>0 and item_id is null and quantity=0) or (meat=0 and item_id is not null and item_id>0 and quantity>0))
);
create table khub_bot.closet_reconciliations (
    id bigint generated always as identity primary key,
    transfer_id uuid not null references khub_bot.closet_transfers(id),
    resolution text not null check (resolution in ('moved','not-moved')),
    evidence text not null, created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.closet_transfers enable row level security;
alter table khub_bot.closet_reconciliations enable row level security;
grant all on khub_bot.closet_transfers,khub_bot.closet_reconciliations to service_role;
grant usage on all sequences in schema khub_bot to service_role;

create function khub_bot.queue_closet(p_key text,p_source text,p_receipt text,p_auction uuid,p_meat bigint,p_items jsonb)
returns void language plpgsql set search_path='' as $$
declare n bigint; part integer; x jsonb;
begin
    n:=p_meat; part:=0;
    while n>0 loop
        insert into khub_bot.closet_transfers(dedupe_key,source,receipt_id,auction_id,meat)
        values(p_key||':meat:'||part,p_source,p_receipt,p_auction,least(n,1000000000)) on conflict(dedupe_key) do nothing;
        n:=n-least(n,1000000000); part:=part+1;
    end loop;
    for x in select * from jsonb_array_elements(p_items) loop
        n:=(x->>'quantity')::bigint; part:=0;
        while n>0 loop
            insert into khub_bot.closet_transfers(dedupe_key,source,receipt_id,auction_id,item_id,quantity)
            values(p_key||':item:'||(x->>'id')||':'||part,p_source,p_receipt,p_auction,(x->>'id')::integer,least(n,1000000000))
            on conflict(dedupe_key) do nothing;
            n:=n-least(n,1000000000); part:=part+1;
        end loop;
    end loop;
end; $$;

create function khub_bot.record_donation_closet() returns trigger language plpgsql set search_path='' as $$
begin
    if new.result='donation' and new.payload#>>'{raw,type}'='normal' then
        perform khub_bot.queue_closet('donation:'||new.mail_id,'donation',new.mail_id,null,
            (new.payload->>'meat')::bigint,new.payload->'items');
    end if;
    return new;
end; $$;
create trigger donation_closet after insert on khub_bot.receipts
    for each row execute function khub_bot.record_donation_closet();

create function khub_bot.record_fee_closet() returns trigger language plpgsql set search_path='' as $$
begin
    if new.escrow_mode and new.status='completed' and old.status is distinct from 'completed'
        and new.highest_bidder_id is not null and new.current_bid>0 and new.fee_meat>0 then
        perform khub_bot.queue_closet('fee:'||new.id,'sale_fee',null,new.id,new.fee_meat,'[]');
    end if;
    return new;
end; $$;
create trigger sale_fee_closet after update of status on public.auctions
    for each row execute function khub_bot.record_fee_closet();

create function public.bot_queue_gift_packages(p_inventory jsonb,p_review_items jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare k integer; n bigint; liabilities jsonb;
begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown'))
       or exists(select 1 from khub_bot.deliveries where state in ('sending','unknown')) then
        raise exception 'Resolve uncertain operations before planning closet transfers.';
    end if;
    liabilities:=public.bot_liabilities();
    -- Actual gift-shop wrapper items; never open them or use their contents.
    foreach k in array array[1167,1168,1169,1170,1171,1172,1173,1174,1175,1176,1177,1460] loop
        n:=coalesce((p_inventory->>k::text)::bigint,0)-coalesce((liabilities#>>array['items',k::text])::bigint,0)
           -coalesce((p_review_items->>k::text)::bigint,0)
           -coalesce((select sum(quantity) from khub_bot.closet_transfers where item_id=k and state='pending'),0);
        if n>0 then
            perform khub_bot.queue_closet('package:'||gen_random_uuid(),'gift_package',null,null,0,
                jsonb_build_array(jsonb_build_object('id',k,'quantity',n)));
        end if;
    end loop;
end; $$;

create function public.bot_claim_closet_transfer(p_snapshot jsonb,p_reserve bigint,p_review_meat bigint,p_review_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d khub_bot.closet_transfers%rowtype; liabilities jsonb; inv bigint; held bigint; amount bigint; closet bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    if p_reserve is null or p_reserve<0 or p_review_meat is null or p_review_meat<0 then raise exception 'Invalid protected Meat.'; end if;
    if exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown'))
       or exists(select 1 from khub_bot.deliveries where state in ('sending','unknown')) then
        raise exception 'Resolve uncertain operations before moving assets.';
    end if;
    select * into d from khub_bot.closet_transfers where state='pending' order by created_at,id limit 1 for update;
    if not found then return null; end if;
    liabilities:=public.bot_liabilities();
    if d.item_id is null then
        inv:=(p_snapshot->>'meat')::bigint; closet:=(p_snapshot->>'closetMeat')::bigint;
        held:=(liabilities->>'meat')::bigint+p_reserve+p_review_meat; amount:=d.meat;
    else
        inv:=coalesce((p_snapshot#>>array['items',d.item_id::text])::bigint,0);
        closet:=coalesce((p_snapshot#>>array['closetItems',d.item_id::text])::bigint,0);
        held:=coalesce((liabilities#>>array['items',d.item_id::text])::bigint,0)
              +coalesce((p_review_items->>d.item_id::text)::bigint,0); amount:=d.quantity;
    end if;
    if inv is null or closet is null or inv<0 or closet<0 or held<0 then raise exception 'Invalid closet snapshot.'; end if;
    if inv-held<amount then raise exception 'Not enough unencumbered inventory for closet transfer C-%. Protect escrow, review mail, and operating reserve.',d.reference_number; end if;
    update khub_bot.closet_transfers set state='moving',attempt=gen_random_uuid(),
        before_state=jsonb_build_object('inventory',inv::text,'closet',closet::text)
        where id=d.id returning * into d;
    return to_jsonb(d)||jsonb_build_object('closet_reference','C-'||d.reference_number);
end; $$;

create function public.bot_ack_closet_transfer(p_id uuid,p_attempt uuid,p_moved boolean,p_evidence text)
returns void language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    update khub_bot.closet_transfers set state=case when p_moved then 'moved' else 'unknown' end,
        evidence=p_evidence,moved_at=case when p_moved then clock_timestamp() end
        where id=p_id and attempt=p_attempt and state='moving';
    if not found then raise exception 'Closet claim does not match. Reconcile before continuing.'; end if;
end; $$;

create function public.bot_lookup_closet_transfer(p_reference text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d khub_bot.closet_transfers%rowtype; v text:=upper(btrim(p_reference));
begin
    if v ~ '^C-[0-9]{1,19}$' then
        select * into d from khub_bot.closet_transfers where reference_number::numeric=substring(v from 3)::numeric;
    elsif v ~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$' then
        select * into d from khub_bot.closet_transfers where id=v::uuid;
    else raise exception 'Use a C-reference or full closet transfer UUID.'; end if;
    if not found then raise exception 'Closet transfer not found.'; end if;
    return to_jsonb(d)||jsonb_build_object('closet_reference','C-'||d.reference_number);
end; $$;
create function public.bot_reconcile_closet_transfer(p_id uuid,p_moved boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if p_moved is null or length(btrim(coalesce(p_evidence,'')))<12 then raise exception 'Record inventory/closet evidence before resolving.'; end if;
    update khub_bot.closet_transfers set state=case when p_moved then 'moved' else 'pending' end,
        moved_at=case when p_moved then clock_timestamp() end,evidence=p_evidence,attempt=null
        where id=p_id and state in ('moving','unknown');
    if not found then raise exception 'Only uncertain closet transfers can be reconciled.'; end if;
    insert into khub_bot.closet_reconciliations(transfer_id,resolution,evidence)
        values(p_id,case when p_moved then 'moved' else 'not-moved' end,p_evidence);
end; $$;

create or replace function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
    select jsonb_build_object('deliveryCounts',(select jsonb_object_agg(state,n) from (select state,count(*) n from khub_bot.deliveries group by state)s),
        'attention',(select coalesce(jsonb_agg(khub_bot.delivery_details(d)),'[]') from khub_bot.deliveries d where state in ('sending','unknown')),
        'closetCounts',(select jsonb_object_agg(state,n) from (select state,count(*) n from khub_bot.closet_transfers group by state)s),
        'closetAttention',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('closet_reference','C-'||c.reference_number)),'[]')
            from khub_bot.closet_transfers c where state in ('moving','unknown')),
        'receipts',(select count(*) from khub_bot.receipts),'settings',(select to_jsonb(s) from khub_bot.settings s where id));
$$;

create or replace function public.bot_mail_cleanup(p_mail_ids text[]) returns jsonb
language sql security definer set search_path='' as $$
    select coalesce(jsonb_agg(r.mail_id order by r.mail_id),'[]'::jsonb) from khub_bot.receipts r
    where r.mail_id=any(p_mail_ids) and r.payload#>>'{raw,type}'='normal'
      and r.payload#>>'{command,type}' in ('verify','list','bid','buy','donation')
      and r.result in ('accepted','donation','donation_help')
      and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id and d.state<>'sent')
      and not exists(select 1 from khub_bot.closet_transfers c where c.receipt_id=r.mail_id and c.state<>'moved');
$$;

-- Protect transfers even if an older worker is accidentally started.
create or replace function public.bot_claim_delivery(p_message_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; begin
    if p_message_version is distinct from 2 then raise exception 'Update the bot to message format version 2 before sending.'; end if;
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.deliveries where state in ('sending','unknown')) then raise exception 'Uncertain delivery requires reconciliation. No automatic resend.'; end if;
    if exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown')) then raise exception 'Uncertain closet transfer requires reconciliation.'; end if;
    select * into d from khub_bot.deliveries where state='pending' order by created_at,id limit 1 for update;
    if not found then return null; end if;
    update khub_bot.deliveries set state='sending',attempt=gen_random_uuid(),
        -- Freeze the footer with the body. Previously claimed deliveries retain their exact text.
        display_footer=case when display_message is null and dedupe_key like 'donation-thanks:%'
            then $footer$
*If this donation was sent in error, please KMail teres minor (#3552305) with the reference ID above.$footer$ else display_footer end,
        display_message=coalesce(display_message,khub_bot.friendly_message(d))
        where id=d.id returning * into d;
    return khub_bot.delivery_details(d);
end; $$;

revoke all on function khub_bot.queue_closet(text,text,text,uuid,bigint,jsonb),khub_bot.record_donation_closet(),khub_bot.record_fee_closet() from public,anon,authenticated;
revoke all on function public.bot_queue_gift_packages(jsonb,jsonb),public.bot_claim_closet_transfer(jsonb,bigint,bigint,jsonb),
    public.bot_ack_closet_transfer(uuid,uuid,boolean,text),public.bot_lookup_closet_transfer(text),public.bot_reconcile_closet_transfer(uuid,boolean,text)
    from public,anon,authenticated;
grant execute on function public.bot_queue_gift_packages(jsonb,jsonb),public.bot_claim_closet_transfer(jsonb,bigint,bigint,jsonb),
    public.bot_ack_closet_transfer(uuid,uuid,boolean,text),public.bot_lookup_closet_transfer(text),public.bot_reconcile_closet_transfer(uuid,boolean,text)
    to service_role;
notify pgrst,'reload schema';
commit;
