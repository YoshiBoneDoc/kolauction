-- Apply after 085 with Oracle stopped; install the matching worker before restart.
-- Sell auctions and their gift costs retain the existing kHub-funded behavior.
begin;
select pg_advisory_xact_lock(3888760);
alter table khub_bot.buy_orders add column gift_meat bigint not null default 0 check(gift_meat>=0),
    add column reduced_quantity bigint not null default 0 check(reduced_quantity>=0),
    add column close_reason text check(close_reason in ('filled','cancel','deadline')),
    add column refund_finalized boolean not null default false;
do $$
declare constraint_name text;
begin
    select conname into strict constraint_name from pg_constraint where conrelid='khub_bot.buy_orders'::regclass and contype='c' and pg_get_constraintdef(oid) like '%funded_meat =%';
    execute format('alter table khub_bot.buy_orders drop constraint %I',constraint_name);
end; $$;
alter table khub_bot.buy_orders add constraint buy_order_conservation check(funded_meat=balance_meat+purchase_meat+commission_meat+refunded_meat+gift_meat);
create table khub_bot.buy_reservations (
    id uuid primary key default gen_random_uuid(),
    auction_id uuid not null references khub_bot.buy_orders(auction_id),
    seller_id uuid not null references public.profiles(id),
    quantity bigint not null check(quantity>0),
    reserved_meat bigint not null check(reserved_meat>0),
    created_at timestamptz not null default clock_timestamp(),
    expires_at timestamptz not null,
    state text not null default 'active' check(state in ('active','fulfilled','expired')),
    receipt_id text unique references khub_bot.receipts(mail_id),
    resolved_at timestamptz,
    check(expires_at>created_at)
);
create unique index buy_reservation_one_per_order on khub_bot.buy_reservations(auction_id,seller_id) where state='active';
create index buy_reservation_expiry on khub_bot.buy_reservations(expires_at) where state='active';
alter table khub_bot.buy_fulfillments add column reservation_id uuid unique references khub_bot.buy_reservations(id);
create table khub_bot.buy_gift_expenses (
    delivery_id uuid primary key references khub_bot.deliveries(id),
    auction_id uuid not null references khub_bot.buy_orders(auction_id),
    hold_meat integer not null default 0 check(hold_meat in (0,50)),
    charged_meat integer not null default 0 check(charged_meat in (0,50)),
    state text not null default 'pending' check(state in ('pending','charged','ordinary')),
    attempt uuid,
    updated_at timestamptz not null default clock_timestamp()
);
create table khub_bot.buy_order_events (
    id bigint generated always as identity primary key,
    auction_id uuid not null references khub_bot.buy_orders(auction_id),
    kind text not null, delivery_id uuid references khub_bot.deliveries(id),
    reservation_id uuid references khub_bot.buy_reservations(id),
    details jsonb not null default '{}',created_at timestamptz not null default clock_timestamp()
);
create table khub_bot.buy_delivery_waits (
    delivery_id uuid primary key references khub_bot.deliveries(id),
    retry_after timestamptz not null
);
alter table khub_bot.buy_reservations enable row level security;
alter table khub_bot.buy_gift_expenses enable row level security;
alter table khub_bot.buy_order_events enable row level security;
alter table khub_bot.buy_delivery_waits enable row level security;
revoke all on khub_bot.buy_reservations,khub_bot.buy_gift_expenses,khub_bot.buy_order_events,khub_bot.buy_delivery_waits from public,anon,authenticated;
grant all on khub_bot.buy_reservations,khub_bot.buy_gift_expenses,khub_bot.buy_order_events,khub_bot.buy_delivery_waits to service_role;
grant usage on sequence khub_bot.buy_order_events_id_seq to service_role;

create function khub_bot.buy_cost(p_price bigint,p_quantity bigint) returns bigint
language sql immutable set search_path='' as $$
    select (p_price::numeric*p_quantity+floor(khub_bot.buy_fee_numerator(p_price)*p_quantity/10000))::bigint;
$$;
create function khub_bot.buy_affordable(p_price bigint,p_balance bigint,p_max bigint) returns bigint
language plpgsql immutable set search_path='' as $$
declare lo bigint:=0; hi bigint:=greatest(0,p_max); mid bigint;
begin
    while lo<hi loop
        mid:=(lo+hi+1)/2;
        if p_price::numeric*mid+floor(khub_bot.buy_fee_numerator(p_price)*mid/10000)<=p_balance then lo:=mid;else hi:=mid-1;end if;
    end loop;
    return lo;
end; $$;

-- Never release a reservation on wall-clock time alone: a complete post-deadline
-- scan must first process all timely mail. Whole-second game stamps get 60s grace.
create function khub_bot.expire_buy_reservations() returns void
language plpgsql set search_path='' as $$
declare r khub_bot.buy_reservations%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    for r in select * from khub_bot.buy_reservations x where x.state='active' and x.expires_at<=clock_timestamp()
        and exists(select 1 from khub_bot.inbox_scans s where s.completed_at is not null and s.started_at>=x.expires_at+interval '60 seconds')
        and not exists(select 1 from khub_bot.inbox_bid_mail m where not m.processed and m.payload#>>'{command,reservation_id}'=x.id::text)
        order by x.id for update
    loop
        update khub_bot.buy_reservations set state='expired',resolved_at=clock_timestamp() where id=r.id;
        insert into khub_bot.buy_order_events(auction_id,kind,reservation_id,details) values(r.auction_id,'reservation_expired',r.id,jsonb_build_object('quantity',r.quantity));
    end loop;
end; $$;

create function khub_bot.rebalance_buy_order(p_id uuid) returns void
language plpgsql set search_path='' as $$
declare a public.auctions%rowtype; o khub_bot.buy_orders%rowtype; reserved bigint; reserved_qty bigint; reduced bigint; spare bigint; d record;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_id for update;
    select * into o from khub_bot.buy_orders where auction_id=p_id for update;
    if not found or o.refund_finalized then return;end if;
    select coalesce(sum(reserved_meat),0),coalesce(sum(quantity),0) into reserved,reserved_qty from khub_bot.buy_reservations where auction_id=p_id and state='active';
    if o.balance_meat<reserved then raise exception 'Buy escrow is below seller commitments; reconcile.';end if;
    reduced:=case when o.gift_meat=0 then 0 else greatest(0,a.quantity-o.purchased_quantity-reserved_qty
        -khub_bot.buy_affordable(a.min_bid_meat,o.balance_meat-reserved,a.quantity-o.purchased_quantity-reserved_qty)) end;
    if reduced<>o.reduced_quantity then
        update khub_bot.buy_orders set reduced_quantity=reduced where auction_id=p_id;
        insert into khub_bot.buy_order_events(auction_id,kind,details) values(p_id,'quantity_adjusted',jsonb_build_object('before',o.reduced_quantity,'after',reduced,'gift_meat',o.gift_meat));
    end if;
    if o.close_reason='filled' and o.purchased_quantity+reduced<a.quantity and not o.refund_finalized then
        -- A proven no-send or top-up can restore purchasing power before final
        -- settlement. Cancellation and expiration requests never reopen.
        update khub_bot.buy_orders set close_reason=null where auction_id=p_id;
        update public.auctions set status='active',settlement_outcome=null,finalized_at=null where id=p_id;
    end if;
    -- Pending package budgets are holds, not charges and not completed purchases.
    -- If no spare funds exist, stop further reservations and await delivery or a
    -- buyer top-up; already reserved sellers are always paid in full.
    spare:=o.balance_meat-reserved;
    for d in select g.delivery_id from khub_bot.buy_gift_expenses g where g.auction_id=p_id and g.state='pending' order by g.updated_at,g.delivery_id for update loop
        update khub_bot.buy_gift_expenses set hold_meat=case when spare>=50 then 50 else 0 end where delivery_id=d.delivery_id;
        spare:=greatest(0,spare-50);
    end loop;
end; $$;
create function khub_bot.buy_available(p_id uuid) returns bigint
language sql stable set search_path='' as $$
    select case when o.close_reason is not null or a.status<>'active' or a.end_time<=statement_timestamp()
        or exists(select 1 from khub_bot.buy_gift_expenses g where g.auction_id=p_id and g.state='pending' and g.hold_meat=0) then 0 else
        least(greatest(0,a.quantity-o.purchased_quantity-o.reduced_quantity-coalesce(r.quantity,0)),
        khub_bot.buy_affordable(a.min_bid_meat,greatest(0,o.balance_meat-coalesce(r.meat,0)-coalesce(g.meat,0)),greatest(0,a.quantity-o.purchased_quantity-coalesce(r.quantity,0)))) end
    from public.auctions a join khub_bot.buy_orders o on o.auction_id=a.id
    left join lateral(select sum(quantity)::bigint quantity,sum(reserved_meat)::bigint meat from khub_bot.buy_reservations where auction_id=p_id and state='active')r on true
    left join lateral(select sum(hold_meat)::bigint meat from khub_bot.buy_gift_expenses where auction_id=p_id and state='pending')g on true
    where a.id=p_id;
$$;
create function public.reserve_buy_quantity(p_auction_id uuid,p_quantity bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles%rowtype;a public.auctions%rowtype;r khub_bot.buy_reservations%rowtype;v_now timestamptz;
begin
    perform pg_advisory_xact_lock(3888760);actor:=khub_bot.require_verified_trader();
    perform khub_bot.expire_buy_reservations();perform khub_bot.rebalance_buy_order(p_auction_id);v_now:=clock_timestamp();
    select * into a from public.auctions where id=p_auction_id for update;
    if not found or a.auction_kind<>'buy' or a.status<>'active' or a.end_time<=v_now or khub_bot.profile_is_restricted(a.seller_id) then raise exception 'This buy order is not accepting reservations.';end if;
    if actor.id=a.seller_id then raise exception 'You cannot fulfill your own order.';end if;
    select * into r from khub_bot.buy_reservations where auction_id=p_auction_id and seller_id=actor.id and state='active';
    if found then
        if r.quantity=p_quantity then return jsonb_build_object('id',r.id,'quantity',r.quantity,'expires_at',r.expires_at);end if;
        raise exception 'You already have a reservation for this order. Complete it or wait for it to expire.';
    end if;
    if p_quantity is null or p_quantity<1 or p_quantity>khub_bot.buy_available(p_auction_id) then raise exception 'That quantity is not currently available. Refresh the order.';end if;
    if (select count(*) from khub_bot.buy_reservations where seller_id=actor.id and state='active')>=3 then raise exception 'Complete an existing reservation before reserving another order (maximum 3 active).';end if;
    if (select count(*) from khub_bot.buy_reservations where seller_id=actor.id and created_at>v_now-interval '1 hour')>=12 then raise exception 'Please wait before making more reservations (maximum 12 per hour).';end if;
    insert into khub_bot.buy_reservations(auction_id,seller_id,quantity,reserved_meat,created_at,expires_at)
        values(p_auction_id,actor.id,p_quantity,khub_bot.buy_cost(a.min_bid_meat,p_quantity),v_now,least(v_now+interval '10 minutes',a.end_time)) returning * into r;
    insert into khub_bot.buy_order_events(auction_id,kind,reservation_id,details) values(a.id,'reservation_created',r.id,jsonb_build_object('quantity',r.quantity,'expires_at',r.expires_at));
    return jsonb_build_object('id',r.id,'quantity',r.quantity,'expires_at',r.expires_at);
end; $$;
create function khub_bot.valid_buy_reservation(p_mail jsonb,p_id uuid,p_seller uuid) returns boolean
language plpgsql stable set search_path='' as $$
declare token text:=p_mail#>>'{command,reservation_id}';stamp timestamptz;r khub_bot.buy_reservations%rowtype;
begin
    if token is null or token!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false;end if;
    select * into r from khub_bot.buy_reservations where id=token::uuid and auction_id=p_id and seller_id=p_seller and state='active';
    stamp:=(p_mail->>'received_at')::timestamptz;
    return r.id is not null and stamp>=date_trunc('second',r.created_at) and stamp<r.expires_at
        and jsonb_array_length(p_mail->'items')=1 and (p_mail#>>'{items,0,quantity}')::bigint=r.quantity;
end; $$;

-- A close request honors existing reservations. Refunds wait until item delivery
-- is known, so final Hardcore/Ronin packaging can use only uncommitted escrow.
create or replace function khub_bot.finish_buy_order(p_id uuid,p_reason text) returns void
language plpgsql set search_path='' as $$
declare a public.auctions%rowtype;o khub_bot.buy_orders%rowtype;reason text;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_id for update;
    select * into o from khub_bot.buy_orders where auction_id=p_id for update;
    if not found or o.refund_finalized or a.status not in ('active','pending_escrow','settling') then return;end if;
    if p_reason='deadline' and (a.end_time>clock_timestamp() or not exists(select 1 from khub_bot.inbox_scans s where s.completed_at is not null and s.started_at>=a.end_time+interval '60 seconds')) then return;end if;
    reason:=o.close_reason;
    if reason is null then
        if p_reason='filled' and o.purchased_quantity+o.reduced_quantity<a.quantity then return;end if;
        reason:=p_reason;
        update khub_bot.buy_orders set close_reason=reason where auction_id=p_id;
    end if;
    if exists(select 1 from khub_bot.buy_reservations where auction_id=p_id and state='active') then return;end if;
    if o.held_quantity>0 then
        perform khub_bot.queue('buy-order-items:'||p_id,p_id,null,a.seller_kol_id,'sale_item',0,
            jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',o.held_quantity)),
            'Buy auction #'||a.auction_number||': your purchased items are attached.');
        update khub_bot.buy_orders set held_quantity=0 where auction_id=p_id;
    end if;
    update public.auctions set status='settling',settlement_outcome=case when reason='cancel' then 'cancelled' when reason='deadline' then 'expired' else 'completed' end,
        finalized_at=coalesce(finalized_at,clock_timestamp()),fee_meat=o.commission_meat where id=p_id;
    -- Hold refunds until all purchased-item deliveries are confirmed, including
    -- unresolved gifts. Seller payments remain separate durable obligations.
    if exists(select 1 from khub_bot.deliveries d where d.auction_id=p_id and d.kind='sale_item' and d.recipient_id=a.seller_kol_id and d.state<>'sent') then return;end if;
    select * into o from khub_bot.buy_orders where auction_id=p_id;
    if o.balance_meat>0 then perform khub_bot.queue('buy-order-refund:'||p_id,p_id,null,a.seller_kol_id,'refund',o.balance_meat,'[]',
        'Buy auction #'||a.auction_number||': unused purchase funds and fee reserve are returned after delivery expenses. Completed purchases are final.');end if;
    update khub_bot.buy_orders set balance_meat=0,refunded_meat=refunded_meat+o.balance_meat,refund_finalized=true where auction_id=p_id;
end; $$;
create function khub_bot.maintain_buy_orders() returns void
language plpgsql set search_path='' as $$
declare o record;
begin
    perform pg_advisory_xact_lock(3888760);perform khub_bot.expire_buy_reservations();
    for o in select b.auction_id,b.close_reason from khub_bot.buy_orders b join public.auctions a on a.id=b.auction_id where not b.refund_finalized and a.status in ('active','pending_escrow','settling') order by b.auction_id loop
        perform khub_bot.rebalance_buy_order(o.auction_id);
        perform khub_bot.finish_buy_order(o.auction_id,coalesce(o.close_reason,'filled'));
    end loop;
end; $$;

create function khub_bot.track_buy_delivery() returns trigger
language plpgsql set search_path='' as $$
begin
    if new.kind='sale_item' and new.dedupe_key like 'buy-%' and exists(select 1 from public.auctions a where a.id=new.auction_id and a.auction_kind='buy' and a.seller_kol_id=new.recipient_id) then
        insert into khub_bot.buy_gift_expenses(delivery_id,auction_id) values(new.id,new.auction_id) on conflict do nothing;
        if new.state='sent' then delete from khub_bot.buy_delivery_waits where delivery_id=new.id; update khub_bot.buy_gift_expenses set state=case when charged_meat>0 then 'charged' else 'ordinary' end,hold_meat=0 where delivery_id=new.id;end if;
        perform khub_bot.rebalance_buy_order(new.auction_id);
    end if;
    return new;
end; $$;
create trigger buy_delivery_budget after insert or update of state on khub_bot.deliveries for each row execute function khub_bot.track_buy_delivery();
insert into khub_bot.buy_gift_expenses(delivery_id,auction_id,state)
    select d.id,d.auction_id,case when d.state='sent' then 'ordinary' else 'pending' end from khub_bot.deliveries d join public.auctions a on a.id=d.auction_id
    where a.auction_kind='buy' and d.kind='sale_item' and d.recipient_id=a.seller_kol_id;

create function public.bot_charge_buy_gift(p_id uuid,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype;g khub_bot.buy_gift_expenses%rowtype;o khub_bot.buy_orders%rowtype;reserved bigint;other_holds bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into d from khub_bot.deliveries where id=p_id for update;
    if not found or d.state<>'sending' or d.attempt is distinct from p_attempt then raise exception 'Delivery claim changed.';end if;
    select * into g from khub_bot.buy_gift_expenses where delivery_id=p_id for update;
    if not found then return jsonb_build_object('payer','bot','authorized',true);end if;
    if g.charged_meat=50 then return jsonb_build_object('payer','buyer','authorized',true,'already_charged',true);end if;
    select * into strict o from khub_bot.buy_orders where auction_id=g.auction_id for update;
    select coalesce(sum(reserved_meat),0) into reserved from khub_bot.buy_reservations where auction_id=g.auction_id and state='active';
    select coalesce(sum(hold_meat),0) into other_holds from khub_bot.buy_gift_expenses where auction_id=g.auction_id and state='pending' and delivery_id<>p_id;
    if o.refund_finalized or o.balance_meat-reserved-other_holds<50 then
        perform khub_bot.queue('buy-gift-topup:'||p_id,g.auction_id,null,d.recipient_id,'notice',0,'[]',
            'Buy order item delivery is safely held: a Hardcore/Ronin gift requires 50 Meat of uncommitted escrow. Send FUND <your buy auction number> with additional Meat. Seller payments and reserved quantities are protected.');
        return jsonb_build_object('payer','buyer','authorized',false,'reason','topup_required');
    end if;
    update khub_bot.buy_orders set balance_meat=balance_meat-50,gift_meat=gift_meat+50 where auction_id=g.auction_id;
    update khub_bot.buy_gift_expenses set charged_meat=50,hold_meat=0,state='charged',attempt=p_attempt,updated_at=clock_timestamp() where delivery_id=p_id;
    insert into khub_bot.buy_order_events(auction_id,kind,delivery_id,details) values(g.auction_id,'gift_charged',p_id,jsonb_build_object('meat',50,'attempt',p_attempt));
    perform khub_bot.rebalance_buy_order(g.auction_id);
    return jsonb_build_object('payer','buyer','authorized',true);
end; $$;
create function khub_bot.release_buy_gift(p_id uuid,p_attempt uuid,p_reason text) returns void
language plpgsql set search_path='' as $$
declare g khub_bot.buy_gift_expenses%rowtype;
begin
    select * into g from khub_bot.buy_gift_expenses where delivery_id=p_id for update;
    if not found or g.charged_meat=0 or g.attempt is distinct from p_attempt then return;end if;
    update khub_bot.buy_orders set balance_meat=balance_meat+50,gift_meat=gift_meat-50 where auction_id=g.auction_id;
    update khub_bot.buy_gift_expenses set charged_meat=0,state='pending',attempt=null,updated_at=clock_timestamp() where delivery_id=p_id;
    insert into khub_bot.buy_order_events(auction_id,kind,delivery_id,details) values(g.auction_id,'gift_released',p_id,jsonb_build_object('meat',50,'reason',p_reason));
    perform khub_bot.rebalance_buy_order(g.auction_id);
end; $$;
create function public.bot_defer_buy_delivery(p_id uuid,p_attempt uuid) returns void
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into d from khub_bot.deliveries where id=p_id for update;
    if not found or d.state<>'sending' or d.attempt is distinct from p_attempt or not exists(select 1 from khub_bot.buy_gift_expenses where delivery_id=p_id) then raise exception 'Invalid buy delivery deferral.';end if;
    -- Service adapter calls ONLY when it knows no asset request was attempted.
    perform khub_bot.release_buy_gift(p_id,p_attempt,'gift request not attempted');
    update khub_bot.deliveries set state='pending',attempt=null where id=p_id;
    insert into khub_bot.buy_delivery_waits values(p_id,clock_timestamp()+interval '60 seconds') on conflict(delivery_id) do update set retry_after=excluded.retry_after;
end; $$;

-- Preserve the existing manual evidence requirement. Only a proven not-sent
-- resolution refunds a charged package; uncertainty keeps funds conservative.
alter function public.bot_reconcile_delivery(uuid,boolean,text) set schema khub_bot;
alter function khub_bot.bot_reconcile_delivery(uuid,boolean,text) rename to reconcile_before_buy_gifts;
create function public.bot_reconcile_delivery(p_id uuid,p_sent boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
declare attempt uuid;
begin
    perform pg_advisory_xact_lock(3888760);select d.attempt into attempt from khub_bot.deliveries d where id=p_id;
    if not p_sent then perform khub_bot.release_buy_gift(p_id,attempt,'operator confirmed not sent');end if;
    perform khub_bot.reconcile_before_buy_gifts(p_id,p_sent,p_evidence);
end; $$;

-- Reject old FILL commands lacking reservations. The existing validated intake
-- still performs receipt dedupe, attachment verification and the payment plans.
alter function public.bot_ingest_mail(jsonb) set schema khub_bot;
alter function khub_bot.bot_ingest_mail(jsonb) rename to ingest_before_buy_reservations;
do $$
declare definition text;
begin
    definition:=pg_get_functiondef('khub_bot.ingest_before_buy_reservations(jsonb)'::regprocedure);
    definition:=replace(definition,'a.status<>''active'' or a.end_time<=clock_timestamp()',
        'a.status<>''active'' or not khub_bot.valid_buy_reservation(p_mail,a.id,trader.id)');
    definition:=replace(definition,'This buy order is not accepting items.','A valid reservation and its exact quantity are required. Reserve through the website before sending items.');
    definition:=replace(definition,'accepted:=least(quantity,a.quantity-o.purchased_quantity);returned:=quantity-accepted;',
        'accepted:=quantity;returned:=0;');
    definition:=replace(definition,'insert into khub_bot.buy_fulfillments(receipt_id,',
        'update khub_bot.buy_reservations set state=''fulfilled'',receipt_id=mid,resolved_at=clock_timestamp() where id=(p_mail#>>''{command,reservation_id}'')::uuid; '
        ||'insert into khub_bot.buy_fulfillments(reservation_id,receipt_id,');
    definition:=replace(definition,'values(mid,a.id,trader.id,sid,accepted,',
        'values((p_mail#>>''{command,reservation_id}'')::uuid,mid,a.id,trader.id,sid,accepted,');
    definition:=replace(definition,'if o.purchased_quantity+accepted=a.quantity then perform khub_bot.finish_buy_order(a.id,''filled''); end if;',
        'perform khub_bot.rebalance_buy_order(a.id); perform khub_bot.finish_buy_order(a.id,''filled'');');
    execute definition;
end; $$;
create function public.bot_ingest_mail(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;trader public.profiles%rowtype;mid text:=p_mail->>'id';meat bigint:=(p_mail->>'meat')::bigint;result text;
begin
    perform pg_advisory_xact_lock(3888760);
    if p_mail#>>'{command,type}'='fill' and not exists(select 1 from khub_bot.inbox_bid_mail where mail_id=mid and payload=p_mail) then raise exception 'Fulfillment requires a complete staged inbox scan; upgrade the worker.';end if;
    select * into a from public.auctions where case when (p_mail->'command')?'auction_number' then auction_number::text=p_mail#>>'{command,auction_number}' else id::text=p_mail#>>'{command,auction_id}' end for update;
    if p_mail#>>'{command,type}'='fund' and a.auction_kind='buy' and a.status in ('active','settling') then
        if exists(select 1 from khub_bot.receipts where mail_id=mid) then
            if (select payload from khub_bot.receipts where mail_id=mid)<>p_mail then raise exception 'KMail ID payload changed; reconcile.';end if;
            return 'duplicate';
        end if;
        select * into trader from public.profiles where kol_player_id=(p_mail->>'sender_id')::bigint;
        if trader.id=a.seller_id and not khub_bot.profile_is_restricted(trader.id) and meat between 1 and 20000000000
            and p_mail->'items'='[]'::jsonb and p_mail#>>'{raw,type}'='normal' and mid~'^[1-9][0-9]*$'
            and exists(select 1 from khub_bot.buy_orders where auction_id=a.id and not refund_finalized and funded_meat::numeric+meat<=9007199254740991) then
            insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result) values(mid,(p_mail->>'sender_id')::bigint,(p_mail->>'received_at')::timestamptz,p_mail,'accepted');
            update khub_bot.buy_orders set balance_meat=balance_meat+meat,funded_meat=funded_meat+meat where auction_id=a.id;
            insert into khub_bot.buy_order_events(auction_id,kind,details) values(a.id,'topup',jsonb_build_object('receipt_id',mid,'meat',meat));
            delete from khub_bot.buy_delivery_waits where delivery_id in (select delivery_id from khub_bot.buy_gift_expenses where auction_id=a.id);
            perform khub_bot.rebalance_buy_order(a.id);return 'accepted';
        end if;
    end if;
    result:=khub_bot.ingest_before_buy_reservations(p_mail);
    if p_mail#>>'{command,type}'='fill' then update khub_bot.inbox_bid_mail set processed=true where mail_id=mid;end if;
    return result;
end; $$;

-- Stage FILL payloads durably and validate their genuine KoL receipt timestamp.
do $$
declare definition text;
begin
    definition:=pg_get_functiondef('public.bot_stage_inbox_scan(uuid,jsonb)'::regprocedure);
    execute replace(definition,$a$not in ('bid','buy')$a$,$b$not in ('bid','buy','fill')$b$);
    definition:=pg_get_functiondef('public.bot_claim_delivery(integer)'::regprocedure);
    execute replace(definition,'where x.state=''pending''','where x.state=''pending'' and not exists(select 1 from khub_bot.buy_delivery_waits w where w.delivery_id=x.id and w.retry_after>clock_timestamp())');
    definition:=pg_get_functiondef('public.bot_tick()'::regprocedure);
    definition:=replace(definition,'where escrow_mode and status=''settling''','where (auction_kind=''sell'' or exists(select 1 from khub_bot.buy_orders o where o.auction_id=a.id and o.refund_finalized)) and escrow_mode and status=''settling''');
    execute definition;
end; $$;
alter function public.bot_tick() set schema khub_bot;
alter function khub_bot.bot_tick() rename to tick_before_buy_reservations;
create function public.bot_tick() returns void
language plpgsql security definer set search_path='' as $$
begin perform khub_bot.maintain_buy_orders();perform khub_bot.tick_before_buy_reservations();end; $$;
alter function public.bot_finish_inbox_scan(uuid) set schema khub_bot;
alter function khub_bot.bot_finish_inbox_scan(uuid) rename to scan_before_buy_reservations;
create function public.bot_finish_inbox_scan(p_scan_id uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare closed integer;
begin closed:=khub_bot.scan_before_buy_reservations(p_scan_id);perform khub_bot.maintain_buy_orders();return closed;end; $$;

alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to auction_before_buy_reservations;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text) returns jsonb
language sql stable security definer set search_path='' as $$
    select khub_bot.auction_before_buy_reservations(a,p_bid_count,p_highest_label,p_winner_label)
    ||coalesce((select jsonb_build_object('original_quantity',a.quantity,'remaining_quantity',greatest(0,a.quantity-o.purchased_quantity-o.reduced_quantity),
        'available_quantity',khub_bot.buy_available(a.id),'reserved_quantity',coalesce((select sum(quantity) from khub_bot.buy_reservations where auction_id=a.id and state='active'),0),
        'reduced_quantity',o.reduced_quantity,'gift_meat',o.gift_meat,'buy_closing_reason',o.close_reason,
        'gift_funding_needed',exists(select 1 from khub_bot.buy_gift_expenses g join khub_bot.buy_delivery_waits w on w.delivery_id=g.delivery_id where g.auction_id=a.id and g.state='pending'),
        'my_reservation',(select jsonb_build_object('id',r.id,'quantity',r.quantity,'expires_at',r.expires_at,'created_at',r.created_at) from khub_bot.buy_reservations r where r.auction_id=a.id and r.seller_id=auth.uid() and r.state='active'))
        ||case when khub_bot.is_administrator(auth.uid()) then jsonb_build_object('reservation_audit',
            (select coalesce(jsonb_agg(to_jsonb(e) order by e.id desc),'[]'::jsonb) from (select * from khub_bot.buy_order_events where auction_id=a.id order by id desc limit 100)e)) else '{}'::jsonb end
        from khub_bot.buy_orders o where o.auction_id=a.id),'{}'::jsonb);
$$;

-- Historical closed/refund-planned orders keep their original obligations.
update khub_bot.buy_orders o set refund_finalized=true from public.auctions a where a.id=o.auction_id and a.status not in ('active','pending_escrow');
delete from khub_bot.buy_gift_expenses g using khub_bot.buy_orders o where o.auction_id=g.auction_id and o.refund_finalized;

alter function public.bot_financial_stats() set schema khub_bot;
alter function khub_bot.bot_financial_stats() rename to stats_before_buy_gifts;
create function public.bot_financial_stats() returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_set(khub_bot.stats_before_buy_gifts(),'{buy_orders,gift_meat}',to_jsonb((select coalesce(sum(gift_meat),0)::text from khub_bot.buy_orders)));
$$;
alter function public.bot_inspect() set schema khub_bot;
alter function khub_bot.bot_inspect() rename to inspect_before_buy_reservations;
create function public.bot_inspect() returns jsonb
language sql security definer set search_path='' as $$
    select khub_bot.inspect_before_buy_reservations()||jsonb_build_object('buyReservationsVersion',1,
        'buyReservationsActive',(select count(*) from khub_bot.buy_reservations where state='active'),
        'buyGiftCosts',(select coalesce(sum(gift_meat),0)::text from khub_bot.buy_orders),
        'buyGiftDeliveryWaits',(select count(*) from khub_bot.buy_delivery_waits));
$$;
revoke all on function public.bot_financial_stats(),public.bot_inspect(),khub_bot.stats_before_buy_gifts(),khub_bot.inspect_before_buy_reservations() from public,anon,authenticated,service_role;
grant execute on function public.bot_financial_stats(),public.bot_inspect() to service_role;

-- All new helper functions are private; expose only authenticated reservation
-- creation and the service-role worker endpoints.
revoke all on function khub_bot.buy_cost(bigint,bigint),khub_bot.buy_affordable(bigint,bigint,bigint),khub_bot.expire_buy_reservations(),
    khub_bot.rebalance_buy_order(uuid),khub_bot.buy_available(uuid),khub_bot.valid_buy_reservation(jsonb,uuid,uuid),khub_bot.maintain_buy_orders(),
    khub_bot.track_buy_delivery(),khub_bot.release_buy_gift(uuid,uuid,text),khub_bot.reconcile_before_buy_gifts(uuid,boolean,text),
    khub_bot.ingest_before_buy_reservations(jsonb),khub_bot.tick_before_buy_reservations(),khub_bot.scan_before_buy_reservations(uuid),
    khub_bot.auction_before_buy_reservations(public.auctions,bigint,text,text),khub_bot.public_auction(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;
revoke all on function public.reserve_buy_quantity(uuid,bigint) from public,anon,authenticated;
grant execute on function public.reserve_buy_quantity(uuid,bigint) to authenticated;
revoke all on function public.bot_charge_buy_gift(uuid,uuid),public.bot_defer_buy_delivery(uuid,uuid),public.bot_ingest_mail(jsonb),
    public.bot_reconcile_delivery(uuid,boolean,text),public.bot_tick(),public.bot_finish_inbox_scan(uuid) from public,anon,authenticated;
grant execute on function public.bot_charge_buy_gift(uuid,uuid),public.bot_defer_buy_delivery(uuid,uuid),public.bot_ingest_mail(jsonb),
    public.bot_reconcile_delivery(uuid,boolean,text),public.bot_tick(),public.bot_finish_inbox_scan(uuid) to service_role;
select khub_bot.maintain_buy_orders();
notify pgrst,'reload schema';
commit;
