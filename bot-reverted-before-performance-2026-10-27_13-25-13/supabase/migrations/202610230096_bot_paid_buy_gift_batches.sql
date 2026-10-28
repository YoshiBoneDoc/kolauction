-- Apply after 095 WITH ORACLE STOPPED; install the matching worker before restart.
-- Buy packaging uses kHub operating funds; seller commission and Sell delivery stay intact.
begin;
select pg_advisory_xact_lock(3888760);

alter table khub_bot.buy_gift_expenses
    add column bot_authorized_meat integer not null default 0 check(bot_authorized_meat in (0,50)),
    add column bot_paid_meat integer not null default 0 check(bot_paid_meat in (0,50));
alter table khub_bot.buy_gift_expenses drop constraint buy_gift_expenses_state_check;
alter table khub_bot.buy_gift_expenses add constraint buy_gift_expenses_state_check
    check(state in ('pending','charged','ordinary','bot_authorized','bot_paid'));

-- Open orders regain any packaging Meat already taken under the old policy.
-- Keep the original event trail; never rewrite finalized refunds or sent messages.
insert into khub_bot.buy_order_events(auction_id,kind,details)
    select auction_id,'packaging_sponsored',jsonb_build_object('restored_meat',gift_meat,'previous_reduction',reduced_quantity)
    from khub_bot.buy_orders where not refund_finalized and (gift_meat>0 or reduced_quantity>0);
update khub_bot.buy_gift_expenses g set charged_meat=0,hold_meat=0,
    bot_paid_meat=case when d.state='sent' and g.charged_meat=50 then 50 else 0 end,
    bot_authorized_meat=case when d.state in ('sending','unknown') and g.charged_meat=50 then 50 else 0 end,
    state=case when d.state='sent' and g.charged_meat=50 then 'bot_paid'
        when d.state in ('sending','unknown') and g.charged_meat=50 then 'bot_authorized'
        when d.state='sent' then 'ordinary' else 'pending' end
    from khub_bot.buy_orders o,khub_bot.deliveries d
    where o.auction_id=g.auction_id and not o.refund_finalized and d.id=g.delivery_id;
update khub_bot.buy_orders set balance_meat=balance_meat+gift_meat,gift_meat=0,reduced_quantity=0 where not refund_finalized;
update khub_bot.buy_gift_expenses set hold_meat=0 where hold_meat<>0;
-- Obsolete, definitely unattempted top-up requests must no longer be sent.
update khub_bot.deliveries set state='cancelled',evidence='Buy gift packaging is now paid by kHub.'
    where dedupe_key like 'buy-gift-topup:%' and state='pending' and attempt is null;
delete from khub_bot.buy_delivery_waits;

create table khub_bot.buy_delivery_profiles (
    auction_id uuid primary key references khub_bot.buy_orders(auction_id),
    needs_gift boolean, checked_at timestamptz not null default clock_timestamp()
);
create table khub_bot.buy_item_batches (
    id uuid primary key,
    auction_id uuid not null references khub_bot.buy_orders(auction_id),
    quantity bigint not null check(quantity>0),
    source_deliveries jsonb not null,
    created_at timestamptz not null default clock_timestamp()
);
create table khub_bot.buy_item_batch_members (
    batch_id uuid not null references khub_bot.buy_item_batches(id),
    source_id uuid not null references khub_bot.deliveries(id),
    delivery_id uuid not null references khub_bot.deliveries(id),
    primary key(source_id,delivery_id), check(source_id<>delivery_id)
);
create index buy_batch_targets_idx on khub_bot.buy_item_batch_members(delivery_id,batch_id);
create index buy_batch_group_idx on khub_bot.buy_item_batch_members(batch_id,delivery_id);
alter table khub_bot.buy_delivery_profiles enable row level security;
alter table khub_bot.buy_item_batches enable row level security;
alter table khub_bot.buy_item_batch_members enable row level security;
revoke all on khub_bot.buy_delivery_profiles,khub_bot.buy_item_batches,khub_bot.buy_item_batch_members from public,anon,authenticated;
grant all on khub_bot.buy_delivery_profiles,khub_bot.buy_item_batches,khub_bot.buy_item_batch_members to service_role;

create function khub_bot.buy_gift_threshold(p_price bigint) returns bigint
language sql immutable set search_path='' as $$
    select case when p_price<50 then 1000 when p_price<1000 then 100 when p_price<50000 then 10 else 1 end::bigint;
$$;
create or replace function khub_bot.rebalance_buy_order(p_id uuid) returns void
language plpgsql set search_path='' as $$
declare a public.auctions%rowtype;o khub_bot.buy_orders%rowtype;reserved bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_id for update;
    select * into o from khub_bot.buy_orders where auction_id=p_id for update;
    if not found or o.refund_finalized then return;end if;
    select coalesce(sum(reserved_meat),0) into reserved from khub_bot.buy_reservations where auction_id=p_id and state='active';
    if o.balance_meat<reserved then raise exception 'Buy escrow is below seller commitments; reconcile.';end if;
    if o.reduced_quantity<>0 then
        update khub_bot.buy_orders set reduced_quantity=0 where auction_id=p_id;
        insert into khub_bot.buy_order_events(auction_id,kind,details) values(p_id,'quantity_restored',jsonb_build_object('quantity',o.reduced_quantity));
    end if;
    if o.close_reason='filled' and o.purchased_quantity<a.quantity then
        update khub_bot.buy_orders set close_reason=null where auction_id=p_id;
        update public.auctions set status='active',settlement_outcome=null,finalized_at=null where id=p_id;
    end if;
end; $$;
create or replace function khub_bot.buy_available(p_id uuid) returns bigint
language sql stable set search_path='' as $$
    select case when o.close_reason is not null or a.status<>'active' or a.end_time<=statement_timestamp() then 0 else
        least(greatest(0,a.quantity-o.purchased_quantity-coalesce(r.quantity,0)),
            khub_bot.buy_affordable(a.min_bid_meat,greatest(0,o.balance_meat-coalesce(r.meat,0)),greatest(0,a.quantity-o.purchased_quantity-coalesce(r.quantity,0)))) end
    from public.auctions a join khub_bot.buy_orders o on o.auction_id=a.id
    left join lateral(select sum(quantity)::bigint quantity,sum(reserved_meat)::bigint meat from khub_bot.buy_reservations where auction_id=p_id and state='active')r on true
    where a.id=p_id;
$$;

create or replace function khub_bot.track_buy_delivery() returns trigger
language plpgsql set search_path='' as $$
declare g khub_bot.buy_gift_expenses%rowtype;
begin
    if new.kind='sale_item' and new.dedupe_key like 'buy-%' and exists(
        select 1 from public.auctions a where a.id=new.auction_id and a.auction_kind='buy' and a.seller_kol_id=new.recipient_id) then
        insert into khub_bot.buy_gift_expenses(delivery_id,auction_id) values(new.id,new.auction_id) on conflict do nothing;
        if tg_op='INSERT' and new.state='pending' and exists(select 1 from khub_bot.buy_orders where auction_id=new.auction_id and delivery_mode='immediate') then
            insert into khub_bot.buy_delivery_waits values(new.id,'infinity') on conflict(delivery_id) do update set retry_after='infinity';
        end if;
        if new.state='sent' then
            select * into g from khub_bot.buy_gift_expenses where delivery_id=new.id for update;
            if g.bot_authorized_meat=50 and g.bot_paid_meat=0 then
                insert into khub_bot.buy_order_events(auction_id,kind,delivery_id,details)
                    values(new.auction_id,'bot_packaging_paid',new.id,jsonb_build_object('meat',50,'attempt',new.attempt));
            end if;
            delete from khub_bot.buy_delivery_waits where delivery_id=new.id;
            update khub_bot.buy_gift_expenses set bot_paid_meat=greatest(bot_paid_meat,bot_authorized_meat),bot_authorized_meat=0,hold_meat=0,
                state=case when bot_authorized_meat>0 or bot_paid_meat>0 then 'bot_paid' when charged_meat>0 then 'charged' else 'ordinary' end where delivery_id=new.id;
        end if;
    elsif tg_op='UPDATE' and old.kind='sale_item' and new.state='cancelled' then
        delete from khub_bot.buy_delivery_waits where delivery_id=new.id;
        update khub_bot.buy_gift_expenses set state='ordinary',hold_meat=0,bot_authorized_meat=0 where delivery_id=new.id and charged_meat=0;
    end if;
    return new;
end; $$;
-- Gate pre-upgrade, unclaimed immediate items too; uncertain/sending rows stay untouched.
insert into khub_bot.buy_delivery_waits(delivery_id,retry_after)
    select d.id,'infinity' from khub_bot.deliveries d join khub_bot.buy_orders o on o.auction_id=d.auction_id
    join public.auctions a on a.id=o.auction_id where o.delivery_mode='immediate' and d.kind='sale_item'
        and d.recipient_id=a.seller_kol_id and d.state='pending' and d.attempt is null
    on conflict(delivery_id) do update set retry_after='infinity';

create function public.bot_pending_buy_delivery_groups() returns jsonb
language sql stable security definer set search_path='' as $$
    select coalesce(jsonb_agg(to_jsonb(g) order by g.checked_at nulls first,g.auction_id),'[]'::jsonb) from (
        select a.id auction_id,a.seller_kol_id recipient_id,p.checked_at
        from public.auctions a join khub_bot.buy_orders o on o.auction_id=a.id
        left join khub_bot.buy_delivery_profiles p on p.auction_id=a.id
        where o.delivery_mode='immediate' and exists(select 1 from khub_bot.deliveries d where d.auction_id=a.id
            and d.kind='sale_item' and d.recipient_id=a.seller_kol_id and d.state='pending' and d.attempt is null)
        order by p.checked_at nulls first,a.id limit 100
    )g;
$$;
create function public.bot_prepare_buy_delivery(p_auction_id uuid,p_needs_gift boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;o khub_bot.buy_orders%rowtype;ids uuid[];snapshots jsonb;total bigint;n integer;
    batch uuid:=gen_random_uuid();targets uuid[];closing boolean;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    select * into o from khub_bot.buy_orders where auction_id=p_auction_id for update;
    if not found or o.delivery_mode<>'immediate' then raise exception 'Immediate Buy delivery required.';end if;
    insert into khub_bot.buy_delivery_profiles(auction_id,needs_gift) values(p_auction_id,p_needs_gift)
        on conflict(auction_id) do update set needs_gift=excluded.needs_gift,checked_at=clock_timestamp();
    select array_agg(d.id order by d.created_at,d.id),jsonb_agg(to_jsonb(d) order by d.created_at,d.id),sum(d.quantity),count(*)
        into ids,snapshots,total,n from khub_bot.deliveries d
        where d.auction_id=p_auction_id and d.kind='sale_item' and d.recipient_id=a.seller_kol_id
            and d.item_id=a.item_id and d.meat=0 and d.state='pending' and d.attempt is null
            and not exists(select 1 from khub_bot.delivery_preparation_reviews h where h.delivery_id=d.id and h.released_at is null)
            and not exists(select 1 from khub_bot.buy_gift_expenses g where g.delivery_id=d.id and g.charged_meat>0);
    if n=0 then return jsonb_build_object('state','empty');end if;
    if p_needs_gift is null then
        insert into khub_bot.buy_delivery_waits select unnest(ids),'infinity' on conflict(delivery_id) do update set retry_after='infinity';
        return jsonb_build_object('state','profile_unknown');
    end if;
    if not p_needs_gift then
        delete from khub_bot.buy_delivery_waits where delivery_id=any(ids);
        return jsonb_build_object('state','ordinary','quantity',total);
    end if;
    closing:=o.close_reason is not null or a.status in ('settling','completed','cancelled','expired','voided');
    if not closing and total<khub_bot.buy_gift_threshold(a.min_bid_meat)
        and not exists(select 1 from khub_bot.buy_item_batch_members m join khub_bot.buy_item_batches b on b.id=m.batch_id
            where m.delivery_id=any(ids) and b.quantity>=khub_bot.buy_gift_threshold(a.min_bid_meat)) then
        insert into khub_bot.buy_delivery_waits select unnest(ids),'infinity' on conflict(delivery_id) do update set retry_after='infinity';
        return jsonb_build_object('state','accumulating','quantity',total,'threshold',khub_bot.buy_gift_threshold(a.min_bid_meat));
    end if;
    if n=1 then
        delete from khub_bot.buy_delivery_waits where delivery_id=any(ids);
        return jsonb_build_object('state','ready','quantity',total);
    end if;
    insert into khub_bot.buy_item_batches(id,auction_id,quantity,source_deliveries) values(batch,p_auction_id,total,snapshots);
    -- Keep the existing 1B per-message transport ceiling, not threshold-sized chunks.
    perform khub_bot.queue('buy-batch-items:'||batch,p_auction_id,null,a.seller_kol_id,'sale_item',0,
        jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',total)),
        'Buy auction #'||a.auction_number||': all accumulated purchased items are attached ('||khub_bot.format_message_number(total)||' x '||a.item||'). Gift packaging is covered by kHub.');
    select array_agg(id order by id) into targets from khub_bot.deliveries where dedupe_key like 'buy-batch-items:'||batch||':%';
    insert into khub_bot.buy_item_batch_members(batch_id,source_id,delivery_id)
        select batch,source,target from unnest(ids)source cross join unnest(targets)target;
    -- Original obligations move atomically to the new batch. Archive every source
    -- row above; cancel only its now-asset-free routing notice, never mark it sent.
    update khub_bot.deliveries set kind='notice',item_id=null,quantity=0,state='cancelled',
        evidence='Consolidated into Buy item batch '||batch where id=any(ids);
    delete from khub_bot.buy_delivery_waits where delivery_id=any(targets);
    insert into khub_bot.buy_order_events(auction_id,kind,details) values(p_auction_id,'items_batched',
        jsonb_build_object('batch_id',batch,'quantity',total,'sources',to_jsonb(ids),'deliveries',to_jsonb(targets)));
    return jsonb_build_object('state','batched','quantity',total,'deliveries',to_jsonb(targets));
end; $$;

create or replace function public.bot_charge_buy_gift(p_id uuid,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype;g khub_bot.buy_gift_expenses%rowtype;o khub_bot.buy_orders%rowtype;a public.auctions%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into d from khub_bot.deliveries where id=p_id for update;
    if not found or d.state<>'sending' or d.attempt is distinct from p_attempt then raise exception 'Delivery claim changed.';end if;
    select * into g from khub_bot.buy_gift_expenses where delivery_id=p_id for update;
    if not found then return jsonb_build_object('payer','bot','authorized',true);end if;
    select * into o from khub_bot.buy_orders where auction_id=g.auction_id;
    select * into a from public.auctions where id=g.auction_id;
    -- A fresh profile may reveal HC/Ronin after ordinary delivery was prepared.
    -- No gift request has been attempted yet: defer and consolidate next cycle.
    if o.delivery_mode='immediate' and (
        (o.close_reason is null and a.status='active' and d.quantity<khub_bot.buy_gift_threshold(a.min_bid_meat)
            and not exists(select 1 from khub_bot.buy_item_batch_members m join khub_bot.buy_item_batches b on b.id=m.batch_id
                where m.delivery_id=p_id and b.quantity>=khub_bot.buy_gift_threshold(a.min_bid_meat)))
        or exists(select 1 from khub_bot.deliveries x where x.auction_id=g.auction_id and x.kind='sale_item'
            and x.recipient_id=d.recipient_id and x.item_id=d.item_id and x.state='pending' and x.id<>p_id
            and not exists(select 1 from khub_bot.buy_item_batch_members md join khub_bot.buy_item_batch_members mx on mx.batch_id=md.batch_id
                where md.delivery_id=p_id and mx.delivery_id=x.id))) then
        return jsonb_build_object('payer','bot','authorized',false,'reason','batch_recheck');
    end if;
    if g.bot_authorized_meat=50 and g.attempt=p_attempt then return jsonb_build_object('payer','bot','authorized',true,'already_authorized',true);end if;
    update khub_bot.buy_gift_expenses set hold_meat=0,bot_authorized_meat=50,state='bot_authorized',attempt=p_attempt,updated_at=clock_timestamp() where delivery_id=p_id;
    insert into khub_bot.buy_order_events(auction_id,kind,delivery_id,details) values(g.auction_id,'bot_packaging_authorized',p_id,jsonb_build_object('meat',50,'attempt',p_attempt));
    return jsonb_build_object('payer','bot','authorized',true);
end; $$;
alter function khub_bot.release_buy_gift(uuid,uuid,text) rename to release_buy_gift_before_bot_packaging;
revoke all on function khub_bot.release_buy_gift_before_bot_packaging(uuid,uuid,text) from public,anon,authenticated,service_role;
create function khub_bot.release_buy_gift(p_id uuid,p_attempt uuid,p_reason text) returns void
language plpgsql set search_path='' as $$
begin
    -- Only preserved historical buyer charges use the previous release logic.
    perform khub_bot.release_buy_gift_before_bot_packaging(p_id,p_attempt,p_reason);
    update khub_bot.buy_gift_expenses set bot_authorized_meat=0,hold_meat=0,state=case when bot_paid_meat>0 then 'bot_paid' else 'pending' end,
        attempt=null,updated_at=clock_timestamp() where delivery_id=p_id and attempt=p_attempt and charged_meat=0;
end; $$;
create or replace function public.bot_defer_buy_delivery(p_id uuid,p_attempt uuid) returns void
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into d from khub_bot.deliveries where id=p_id for update;
    if not found or d.state<>'sending' or d.attempt is distinct from p_attempt
        or not exists(select 1 from khub_bot.buy_gift_expenses where delivery_id=p_id) then raise exception 'Invalid buy delivery deferral.';end if;
    perform khub_bot.release_buy_gift(p_id,p_attempt,'gift request not attempted');
    update khub_bot.deliveries set state='pending',attempt=null where id=p_id;
    insert into khub_bot.buy_delivery_waits values(p_id,case when exists(select 1 from khub_bot.buy_orders where auction_id=d.auction_id and delivery_mode='immediate')
        then 'infinity'::timestamptz else clock_timestamp()+interval '60 seconds' end)
        on conflict(delivery_id) do update set retry_after=excluded.retry_after;
    insert into khub_bot.buy_order_events(auction_id,kind,delivery_id,details) values(d.auction_id,'delivery_not_attempted',p_id,jsonb_build_object('attempt',p_attempt));
end; $$;

-- Buy commissions are already protected in their fulfillment fee/closet queue.
-- Only Sell settlements can have a not-yet-queued commission reserve here.
create or replace function public.bot_gift_wrapping_liabilities() returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_set(held,'{meat}',to_jsonb(((held->>'meat')::numeric
        +coalesce((select sum(c.meat) from khub_bot.closet_transfers c where c.state in ('pending','moving','unknown')),0)
        +coalesce((select sum(a.fee_meat) from public.auctions a
            where a.auction_kind='sell' and a.escrow_mode and a.status='settling' and a.settlement_outcome='completed'),0))::text))
    from (select public.bot_liabilities() held) protected;
$$;

-- New worker prepares batches only after ingesting the entire scanned mailbox.
alter function public.bot_claim_delivery(integer) rename to claim_before_buy_batching;
alter function public.claim_before_buy_batching(integer) set schema khub_bot;
revoke all on function khub_bot.claim_before_buy_batching(integer) from public,anon,authenticated,service_role;
create function public.bot_claim_delivery(p_message_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
    if p_message_version is distinct from 3 then raise exception 'Update the bot for Buy gift batching before sending.';end if;
    return khub_bot.claim_before_buy_batching(2);
end; $$;

create function khub_bot.buy_batch_delivery_sent(p_id uuid) returns boolean
language plpgsql stable set search_path='' as $$
declare status text;resolved boolean;
begin
    select state into status from khub_bot.deliveries where id=p_id;
    if status='sent' then return true;end if;
    if status is distinct from 'cancelled' then return false;end if;
    select bool_and(khub_bot.buy_batch_delivery_sent(delivery_id)) into resolved from khub_bot.buy_item_batch_members where source_id=p_id;
    return coalesce(resolved,false);
end; $$;
alter function public.bot_mail_cleanup(text[]) rename to cleanup_before_buy_batching;
alter function public.cleanup_before_buy_batching(text[]) set schema khub_bot;
revoke all on function khub_bot.cleanup_before_buy_batching(text[]) from public,anon,authenticated,service_role;
create function public.bot_mail_cleanup(p_mail_ids text[]) returns jsonb
language sql security definer set search_path='' as $$
    select khub_bot.cleanup_before_buy_batching(p_mail_ids)||coalesce((
        select jsonb_agg(r.mail_id order by r.mail_id) from khub_bot.receipts r
        where r.mail_id=any(p_mail_ids) and r.result='accepted' and r.payload#>>'{raw,type}'='normal'
            and exists(select 1 from khub_bot.deliveries d join khub_bot.buy_item_batch_members m on m.source_id=d.id where d.receipt_id=r.mail_id)
            and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id and not khub_bot.buy_batch_delivery_sent(d.id))
            and not exists(select 1 from khub_bot.closet_transfers c where c.receipt_id=r.mail_id and c.state<>'moved')
    ),'[]'::jsonb);
$$;
do $$ declare definition text;begin
    definition:=pg_get_functiondef('khub_bot.finish_buy_order(uuid,text)'::regprocedure);
    if strpos(definition,'returned after delivery expenses.')=0 then raise exception 'Unexpected Buy refund template.';end if;
    execute replace(definition,'returned after delivery expenses.','returned. Gift packaging is covered by kHub.');
    definition:=pg_get_functiondef('khub_bot.tick_before_buy_reservations()'::regprocedure);
    if strpos(definition,'d.state<>''sent''')=0 then raise exception 'Unexpected delivery settlement guard.';end if;
    execute replace(definition,'d.state<>''sent''','d.state not in (''sent'',''cancelled'')');
end; $$;
-- Keep existing privacy rules; the retired buyer top-up flag is always false.
alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to auction_before_bot_packaging;
revoke all on function khub_bot.auction_before_bot_packaging(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text) returns jsonb
language sql stable security definer set search_path='' as $$
    select khub_bot.auction_before_bot_packaging(a,p_bid_count,p_highest_label,p_winner_label)
        ||case when a.auction_kind='buy' and khub_bot.can_view_usernames()
            and (auth.uid()=a.seller_id or khub_bot.is_administrator(auth.uid())) then jsonb_build_object('gift_funding_needed',false) else '{}'::jsonb end;
$$;
alter function public.bot_financial_stats() rename to stats_before_bot_packaging;
alter function public.stats_before_bot_packaging() set schema khub_bot;
revoke all on function khub_bot.stats_before_bot_packaging() from public,anon,authenticated,service_role;
create function public.bot_financial_stats() returns jsonb language sql stable security definer set search_path='' as $$
    select jsonb_set(khub_bot.stats_before_bot_packaging(),'{buy_orders,bot_packaging_meat}',
        to_jsonb((select coalesce(sum(bot_paid_meat),0)::text from khub_bot.buy_gift_expenses)));
$$;
revoke all on function public.bot_financial_stats() from public,anon,authenticated;
grant execute on function public.bot_financial_stats() to service_role;
alter function public.bot_inspect() rename to bot_inspect_before_buy_batching;
create function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
    select public.bot_inspect_before_buy_batching()||jsonb_build_object('buyDeliveryBatchingVersion',1,
        'buyPackagingPaidByBot',(select coalesce(sum(bot_paid_meat),0)::text from khub_bot.buy_gift_expenses));
$$;
revoke all on function public.bot_inspect_before_buy_batching(),khub_bot.buy_gift_threshold(bigint),khub_bot.buy_batch_delivery_sent(uuid),
    khub_bot.public_auction(public.auctions,bigint,text,text),khub_bot.release_buy_gift(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.bot_pending_buy_delivery_groups(),public.bot_prepare_buy_delivery(uuid,boolean),public.bot_claim_delivery(integer),
    public.bot_charge_buy_gift(uuid,uuid),public.bot_defer_buy_delivery(uuid,uuid),public.bot_mail_cleanup(text[]),public.bot_inspect() from public,anon,authenticated;
grant execute on function public.bot_pending_buy_delivery_groups(),public.bot_prepare_buy_delivery(uuid,boolean),public.bot_claim_delivery(integer),
    public.bot_charge_buy_gift(uuid,uuid),public.bot_defer_buy_delivery(uuid,uuid),public.bot_mail_cleanup(text[]),public.bot_inspect() to service_role;
notify pgrst,'reload schema';
commit;
