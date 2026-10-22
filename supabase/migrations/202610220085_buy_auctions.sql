-- Apply after 084 with the Oracle worker stopped. Install the matching worker,
-- then restart it and deploy the website. No historical sell terms/assets change.
begin;
select pg_advisory_xact_lock(3888760);
alter table public.auctions add column auction_kind text not null default 'sell' check(auction_kind in ('sell','buy'));
alter table public.auctions add constraint buy_auction_escrow check(auction_kind<>'buy' or (escrow_mode and instant_purchase_price is null and highest_bidder_id is null and current_bid=0));
alter table public.auctions drop constraint auctions_status_check;
alter table public.auctions add constraint auctions_status_check check(status in ('pending_escrow','active','on_hold','voided','settling','awaiting_trade','ended_no_bids','cancelled','completed','expired'));
alter table public.auctions drop constraint auctions_settlement_outcome_check;
alter table public.auctions add constraint auctions_settlement_outcome_check check(settlement_outcome in ('completed','ended_no_bids','cancelled','expired'));

create table khub_bot.buy_orders (
    auction_id uuid primary key references public.auctions(id),
    delivery_mode text not null check(delivery_mode in ('immediate','finished')),
    funding_required bigint not null check(funding_required between 1 and 20000000000),
    funding_receipt text unique references khub_bot.receipts(mail_id),
    funded_meat bigint not null default 0 check(funded_meat>=0),
    balance_meat bigint not null default 0 check(balance_meat>=0),
    purchased_quantity bigint not null default 0 check(purchased_quantity>=0),
    held_quantity bigint not null default 0 check(held_quantity between 0 and purchased_quantity),
    purchase_meat bigint not null default 0 check(purchase_meat>=0),
    commission_meat bigint not null default 0 check(commission_meat>=0),
    refunded_meat bigint not null default 0 check(refunded_meat>=0),
    check(funded_meat=balance_meat+purchase_meat+commission_meat+refunded_meat)
);
create table khub_bot.buy_fulfillments (
    receipt_id text primary key references khub_bot.receipts(mail_id),
    auction_id uuid not null references khub_bot.buy_orders(auction_id),
    seller_id uuid not null references public.profiles(id),
    seller_kol_id bigint not null,
    quantity bigint not null check(quantity>0),
    price_per_item bigint not null check(price_per_item>0),
    payment_meat bigint not null check(payment_meat>0),
    commission_meat bigint not null check(commission_meat>=0),
    created_at timestamptz not null default clock_timestamp()
);
create index buy_fulfillments_auction_idx on khub_bot.buy_fulfillments(auction_id,created_at,receipt_id);
create index buy_fulfillments_seller_idx on khub_bot.buy_fulfillments(seller_id,auction_id);
alter table khub_bot.buy_orders enable row level security;
alter table khub_bot.buy_fulfillments enable row level security;
revoke all on khub_bot.buy_orders,khub_bot.buy_fulfillments from public,anon,authenticated;
grant all on khub_bot.buy_orders,khub_bot.buy_fulfillments to service_role;

-- Same marginal schedule as sell commissions; retain fractional Meat until a
-- whole fulfillment is priced. The reserve rounds UP, actual charges round DOWN.
create function khub_bot.buy_fee_numerator(p_price bigint) returns numeric
language plpgsql immutable set search_path='' as $$
begin
    if p_price is null or p_price not between 1 and 20000000000 then raise exception 'Invalid buy price per item.'; end if;
    return least(p_price,1000000)::numeric*500
      +least(greatest(p_price-1000000,0),9000000)::numeric*400
      +least(greatest(p_price-10000000,0),90000000)::numeric*300
      +least(greatest(p_price-100000000,0),900000000)::numeric*200
      +greatest(p_price-1000000000,0)::numeric*100;
end; $$;
create function public.create_buy_auction(p_item_id integer,p_quantity bigint,p_price_per_item bigint,p_duration_hours integer,p_delivery_mode text) returns uuid
language plpgsql security definer set search_path='' as $$
declare trader public.profiles%rowtype; item khub_bot.catalog%rowtype; ident uuid; total numeric; v_now timestamptz;
begin
    perform pg_advisory_xact_lock(3888760);
    trader:=khub_bot.require_verified_trader();v_now:=clock_timestamp();
    if p_quantity is null or p_quantity not between 1 and 5000000000 then raise exception 'Quantity must be between 1 and 5 billion.'; end if;
    if p_duration_hours is null or p_duration_hours not in (6,12,24,72,168,336,720) then raise exception 'Choose a valid auction duration.'; end if;
    if p_delivery_mode is null or p_delivery_mode not in ('immediate','finished') then raise exception 'Choose a delivery preference.'; end if;
    total:=p_price_per_item::numeric*p_quantity+ceil(khub_bot.buy_fee_numerator(p_price_per_item)*p_quantity/10000);
    if total>20000000000 then raise exception 'A buy order including its fee reserve cannot exceed 20 billion Meat.'; end if;
    if not exists(select 1 from khub_bot.item_catalog_state where id) then raise exception 'The item catalog is being updated. Please try again shortly.'; end if;
    select * into item from khub_bot.catalog where id=p_item_id and tradeable and is_current;
    if not found then raise exception 'Choose a current tradeable catalog item.'; end if;
    insert into public.auctions(seller_id,seller_username,seller_kol_id,item,item_id,quantity,min_bid_meat,duration_hours,image,
        created_at,end_time,escrow_mode,status,start_on_deposit,auction_kind)
    values(trader.id,trader.khub_username,trader.kol_player_id,item.name,item.id,p_quantity,p_price_per_item,p_duration_hours,
        'https://images.kingdomofloathing.com/'||case when strpos(item.image,'/')>0 then item.image else 'itemimages/'||item.image end,
        v_now,v_now+make_interval(hours=>p_duration_hours),true,'pending_escrow',true,'buy') returning id into ident;
    insert into khub_bot.buy_orders(auction_id,delivery_mode,funding_required) values(ident,p_delivery_mode,total::bigint);
    return ident;
end; $$;

create function khub_bot.finish_buy_order(p_id uuid,p_reason text) returns void
language plpgsql set search_path='' as $$
declare a public.auctions%rowtype; o khub_bot.buy_orders%rowtype; outcome text;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_id for update;
    if not found or a.auction_kind<>'buy' or a.status not in ('pending_escrow','active') then return; end if;
    select * into strict o from khub_bot.buy_orders where auction_id=p_id for update;
    if p_reason='deadline' and (a.status<>'active' or a.end_time>clock_timestamp()) then return; end if;
    if p_reason='filled' and o.purchased_quantity<>a.quantity then raise exception 'Order is not fully filled.'; end if;
    outcome:=case when p_reason='filled' then 'completed' when p_reason='cancel' then 'cancelled' else 'expired' end;
    if o.held_quantity>0 then
        perform khub_bot.queue('buy-order-items:'||p_id,p_id,null,a.seller_kol_id,'sale_item',0,
            jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',o.held_quantity)),
            'Buy auction #'||a.auction_number||': your purchased items are attached.');
    end if;
    if o.balance_meat>0 then
        perform khub_bot.queue('buy-order-refund:'||p_id,p_id,null,a.seller_kol_id,'refund',o.balance_meat,'[]',
            'Buy auction #'||a.auction_number||': unused purchase funds and fee reserve are returned. Completed purchases are final.');
    end if;
    update khub_bot.buy_orders set held_quantity=0,balance_meat=0,refunded_meat=refunded_meat+o.balance_meat where auction_id=p_id;
    update public.auctions set status='settling',settlement_outcome=outcome,finalized_at=clock_timestamp(),fee_meat=o.commission_meat where id=p_id;
end; $$;

-- Route existing cancellation, ban review, deadline, and bot tick paths through
-- the buy close handler. Keep the receipt-time sell-auction handler untouched.
alter function khub_bot.finish_listing(uuid,text) rename to finish_sell_listing;
create function khub_bot.finish_listing(p_id uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
begin
    if exists(select 1 from public.auctions where id=p_id and auction_kind='buy') then
        perform khub_bot.finish_buy_order(p_id,p_reason);
    else perform khub_bot.finish_sell_listing(p_id,p_reason); end if;
end; $$;
alter function public.cancel_auction(uuid) rename to cancel_sell_auction;
create function public.cancel_auction(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    if a.auction_kind='buy' then
        perform khub_bot.require_verified_trader();
        if auth.uid() is distinct from a.seller_id then raise exception 'Only the buyer can cancel this order.'; end if;
        if a.status not in ('pending_escrow','active') then raise exception 'This order has already closed.'; end if;
        perform khub_bot.finish_buy_order(a.id,case when a.status='active' and a.end_time<=clock_timestamp() then 'deadline' else 'cancel' end);
        perform public.bot_tick();
    else perform public.cancel_sell_auction(p_auction_id); end if;
end; $$;

-- The service-role adapter has verified and secured the KMail attachments before
-- this call. Receipt, allocation, payments, fees and item obligations commit once.
alter function public.bot_ingest_mail(jsonb) set schema khub_bot;
alter function khub_bot.bot_ingest_mail(jsonb) rename to ingest_before_buy_orders;
create function public.bot_ingest_mail(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare mid text:=p_mail->>'id'; sid bigint:=(p_mail->>'sender_id')::bigint;
    cmd text:=p_mail#>>'{command,type}'; a public.auctions%rowtype; o khub_bot.buy_orders%rowtype;
    trader public.profiles%rowtype; meat bigint:=(p_mail->>'meat')::bigint; attachments jsonb:=p_mail->'items';
    reason text; quantity bigint; payment bigint; fee bigint; accepted bigint; returned bigint; received timestamptz;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where
        case when (p_mail->'command') ? 'auction_number' then auction_number::text=p_mail#>>'{command,auction_number}'
            else id::text=lower(p_mail#>>'{command,auction_id}') end for update;
    if cmd not in ('fund','fill') and a.auction_kind is distinct from 'buy' then return khub_bot.ingest_before_buy_orders(p_mail); end if;
    received:=(p_mail->>'received_at')::timestamptz;
    if mid is null or mid!~'^[1-9][0-9]*$' or sid is null or sid<=0 or sid=3888760
        or meat is null or meat not between 0 and 20000000000 or received is null or not isfinite(received)
        or jsonb_typeof(attachments) is distinct from 'array' or p_mail#>>'{raw,type}' is distinct from 'normal' then raise exception 'Invalid normalized buy KMail.'; end if;
    if exists(select 1 from jsonb_array_elements(attachments) x where (x->>'id') is null or (x->>'quantity') is null
        or (x->>'id')::integer<=0 or (x->>'quantity')::bigint not between 1 and 5000000000) then raise exception 'Invalid attachments.'; end if;
    if exists(select 1 from khub_bot.receipts where mail_id=mid) then
        if (select payload from khub_bot.receipts where mail_id=mid)<>p_mail then raise exception 'KMail ID payload changed; reconcile before continuing.'; end if;
        return 'duplicate';
    end if;
    insert into khub_bot.receipts(mail_id,sender_id,received_at,payload) values(mid,sid,received,p_mail);
    select * into trader from public.profiles where kol_player_id=sid and kol_verified_at is not null;
    select * into o from khub_bot.buy_orders where auction_id=a.id for update;
    if a.id is null or a.auction_kind<>'buy' then reason:='Unknown buy auction. Copy FUND or FILL from the buy auction page.';
    elsif trader.id is null then reason:='Register and link your KoL account before funding or fulfilling a buy auction.';
    elsif khub_bot.profile_is_restricted(trader.id) or khub_bot.profile_is_restricted(a.seller_id) then reason:='This account or buy auction is restricted.';
    elsif cmd='fund' then
        if a.seller_id<>trader.id then reason:='Only the buyer can fund this order.';
        elsif a.status<>'pending_escrow' or o.funding_receipt is not null then reason:='This order is not waiting for funding.';
        elsif a.created_at<=clock_timestamp()-interval '24 hours' then reason:='The 24-hour funding deadline has passed.';
        elsif attachments<>'[]'::jsonb or meat<o.funding_required then reason:='Attach the full required deposit with no items.';
        else
            update khub_bot.buy_orders set funding_receipt=mid,funded_meat=o.funding_required,balance_meat=o.funding_required where auction_id=a.id;
            update public.auctions set status='active',item_escrowed_at=clock_timestamp(),end_time=clock_timestamp()+make_interval(hours=>duration_hours) where id=a.id;
            perform khub_bot.queue('buy-funded:'||mid,a.id,mid,sid,'notice',0,'[]','Buy auction #'||a.auction_number||': your Meat deposit has been accepted. Your order is active.');
            if meat>o.funding_required then perform khub_bot.queue('buy-fund-excess:'||mid,a.id,mid,sid,'refund',meat-o.funding_required,'[]','Buy auction #'||a.auction_number||': extra funding is returned.'); end if;
        end if;
    elsif cmd='fill' then
        if a.status<>'active' or a.end_time<=clock_timestamp() then reason:='This buy order is not accepting items.';
        elsif trader.id=a.seller_id then reason:='You cannot fulfill your own buy order.';
        elsif meat<>0 or jsonb_array_length(attachments)<>1 or (attachments->0->>'id')::integer<>a.item_id then reason:='Attach only the requested item, without Meat or extra item types.';
        else
            quantity:=(attachments->0->>'quantity')::bigint;
            accepted:=least(quantity,a.quantity-o.purchased_quantity);returned:=quantity-accepted;
            if accepted<=0 then reason:='This order has already been filled.';
            else
                payment:=a.min_bid_meat*accepted;
                fee:=floor(khub_bot.buy_fee_numerator(a.min_bid_meat)*accepted/10000)::bigint;
                if payment::numeric+fee>o.balance_meat then raise exception 'Insufficient recorded buy escrow; reconcile before processing.'; end if;
                insert into khub_bot.buy_fulfillments(receipt_id,auction_id,seller_id,seller_kol_id,quantity,price_per_item,payment_meat,commission_meat)
                    values(mid,a.id,trader.id,sid,accepted,a.min_bid_meat,payment,fee);
                update khub_bot.buy_orders set balance_meat=balance_meat-payment-fee,purchased_quantity=purchased_quantity+accepted,
                    purchase_meat=purchase_meat+payment,commission_meat=commission_meat+fee,
                    held_quantity=held_quantity+case when delivery_mode='finished' then accepted else 0 end where auction_id=a.id;
                perform khub_bot.queue('buy-fill-payment:'||mid,a.id,mid,sid,'sale_meat',payment,'[]',
                    'Buy auction #'||a.auction_number||': purchased '||khub_bot.format_message_number(accepted)||' x '||a.item||' at '||khub_bot.format_message_number(a.min_bid_meat)||' Meat per item. Your full payment is attached. Fees are paid separately by the buyer.');
                if o.delivery_mode='immediate' then perform khub_bot.queue('buy-fill-items:'||mid,a.id,mid,a.seller_kol_id,'sale_item',0,
                    jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',accepted)),
                    'Buy auction #'||a.auction_number||': purchased items are attached ('||khub_bot.format_message_number(accepted)||' x '||a.item||').'); end if;
                if o.delivery_mode='finished' then perform khub_bot.queue('buy-fill-accepted:'||mid,a.id,mid,a.seller_kol_id,'notice',0,'[]',
                    'Buy auction #'||a.auction_number||': purchased '||khub_bot.format_message_number(accepted)||' x '||a.item||'. Items are held for delivery when your order ends.'); end if;
                if returned>0 then perform khub_bot.queue('buy-fill-excess:'||mid,a.id,mid,sid,'return_item',0,
                    jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',returned)),
                    'Buy auction #'||a.auction_number||': items beyond the remaining requested quantity are returned.'); end if;
                if fee>0 then perform khub_bot.queue_closet('buy-fill-fee:'||mid,'sale_fee',mid,a.id,fee,'[]'); end if;
                if o.purchased_quantity+accepted=a.quantity then perform khub_bot.finish_buy_order(a.id,'filled'); end if;
            end if;
        end if;
    else reason:='Buy auctions use FUND for Meat deposits and FILL for item fulfillments. Copy the command from the listing.';
    end if;
    if reason is not null then perform khub_bot.queue('buy-rejected:'||mid,a.id,mid,sid,'refund',meat,attachments,'Buy auction request not accepted: '||reason||' Your attachments are returned.'); end if;
    update khub_bot.receipts set result=coalesce(reason,'accepted') where mail_id=mid;
    update khub_bot.inbox_bid_mail set processed=true where mail_id=mid;
    return coalesce(reason,'accepted');
end; $$;

-- Do not let old sale-message templates reinterpret purchase-order payments.
alter function khub_bot.friendly_message(khub_bot.deliveries) rename to sell_friendly_message;
create function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
begin
    if d.dedupe_key like 'buy-%' then return d.message; end if;
    return khub_bot.sell_friendly_message(d);
end; $$;

-- Buy balances are Meat, not the listed items. Held acquired items and queued
-- item deliveries are disjoint; moving to the queue clears held_quantity.
do $$
declare body text;
begin
    body:=pg_get_functiondef('public.bot_liabilities()'::regprocedure);
    body:=replace(body,'where escrow_mode and status=''active''','where auction_kind=''sell'' and escrow_mode and status=''active''');
    body:=replace(body,'union all select item_id,quantity,meat from khub_bot.deliveries',
        'union all select a.item_id,o.held_quantity,o.balance_meat from khub_bot.buy_orders o join public.auctions a on a.id=o.auction_id '
        ||'union all select item_id,quantity,meat from khub_bot.deliveries');
    execute body;
end; $$;

create function khub_bot.buy_history(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
    select coalesce(jsonb_agg(row_data order by created_at desc,receipt_id desc),'[]'::jsonb) from (
        select f.created_at,f.receipt_id,jsonb_build_object('quantity',f.quantity,'price_per_item',f.price_per_item,
            'payment_meat',f.payment_meat,'created_at',f.created_at,
            'seller',case when khub_bot.can_view_usernames() and (khub_bot.is_administrator(auth.uid()) or auth.uid() in (a.seller_id,f.seller_id))
                then p.khub_username else 'Seller' end,
            'is_own',f.seller_id=auth.uid(),
            'payment_sent',not exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id and d.dedupe_key like 'buy-fill-payment:%' and d.state<>'sent'))
            ||case when khub_bot.is_administrator(auth.uid()) then jsonb_build_object('receipt_id',f.receipt_id,'commission_meat',f.commission_meat,
                'delivery_references',(select jsonb_agg(jsonb_build_object('reference','D-'||d.reference_number,'state',d.state)) from khub_bot.deliveries d where d.receipt_id=f.receipt_id)) else '{}'::jsonb end as row_data
        from khub_bot.buy_fulfillments f join public.auctions a on a.id=f.auction_id join public.profiles p on p.id=f.seller_id
        where f.auction_id=p_id order by f.created_at desc,f.receipt_id desc limit 100
    ) history;
$$;
create function khub_bot.buy_profile_totals(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_build_object('buy_order_sales',count(*)::text,'buy_order_value',coalesce(sum(f.payment_meat),0)::text,
        'buy_order_units',coalesce(sum(f.quantity),0)::text)
    from khub_bot.buy_fulfillments f where f.seller_id=p_id and not exists(
        select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id and d.dedupe_key like 'buy-fill-payment:%' and d.state<>'sent');
$$;
create function khub_bot.guard_buy_terms() returns trigger
language plpgsql set search_path='' as $$
begin
    if new.auction_kind is distinct from old.auction_kind or (old.auction_kind='buy' and (
        new.item_id is distinct from old.item_id or new.quantity is distinct from old.quantity
        or new.min_bid_meat is distinct from old.min_bid_meat or new.seller_id is distinct from old.seller_id
        or new.duration_hours is distinct from old.duration_hours)) then raise exception 'Published buy order terms cannot change.'; end if;
    return new;
end; $$;
create trigger auctions_guard_buy_terms before update on public.auctions for each row execute function khub_bot.guard_buy_terms();

-- Shared safe projection; private balance and identities are never added to a
-- public row. Aggregate fulfillment quantities are safe for every viewer.
alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to public_sell_auction;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text) returns jsonb
language sql stable security definer set search_path='' as $$
    select khub_bot.public_sell_auction(a,p_bid_count,p_highest_label,p_winner_label)||jsonb_build_object('auction_kind',a.auction_kind)
      ||coalesce((select jsonb_build_object('purchased_quantity',o.purchased_quantity,'remaining_quantity',a.quantity-o.purchased_quantity,
        'fulfillments',khub_bot.buy_history(a.id),'fulfilled_by_me',exists(select 1 from khub_bot.buy_fulfillments f where f.auction_id=a.id and f.seller_id=auth.uid()),
        'my_sale_meat',coalesce((select sum(f.payment_meat) from khub_bot.buy_fulfillments f where f.auction_id=a.id and f.seller_id=auth.uid() and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id and d.dedupe_key like 'buy-fill-payment:%' and d.state<>'sent')),0),
        'price_per_item',a.min_bid_meat,'delivery_mode',o.delivery_mode,'purchase_meat',o.purchase_meat,'buy_commission_meat',o.commission_meat)
        ||case when auth.uid()=a.seller_id or khub_bot.is_administrator(auth.uid()) then jsonb_build_object(
            'buy_admin',khub_bot.is_administrator(auth.uid()),'funding_required',o.funding_required,'balance_meat',o.balance_meat,'held_quantity',o.held_quantity,'refunded_meat',o.refunded_meat) else '{}'::jsonb end
        from khub_bot.buy_orders o where o.auction_id=a.id),'{}'::jsonb);
$$;

do $$
declare definition text;
begin
    definition:=pg_get_functiondef('khub_bot.hot_auction_ids()'::regprocedure);
    if strpos(definition,'where a.status=''active''')=0 then raise exception 'Unexpected hot auction ranker.'; end if;
    execute replace(definition,'where a.status=''active''','where a.auction_kind=''sell'' and a.status=''active''');
end; $$;

-- Buy/sell filtering happens BEFORE pagination. Existing RPC signatures continue
-- to work; the new overload is used only when an explicit kind filter is selected.
do $$
declare body text; signature text;
begin
    foreach signature in array array['text,uuid,text,text,text,integer','text,uuid,text,text,text,integer,text'] loop
        body:=pg_get_functiondef(('public.read_auction_page('||signature||')')::regprocedure);
        body:=replace(body,'a.seller_id=auth.uid() or a.winner_id=auth.uid()',
            'a.seller_id=auth.uid() or a.winner_id=auth.uid() or exists(select 1 from khub_bot.buy_fulfillments f where f.auction_id=a.id and f.seller_id=auth.uid())');
        body:=replace(body,'where p_view=''seller'' and p.id=p_id and (exists(select 1 from seller_lots)',
            'where p_view=''seller'' and p.id=p_id and (exists(select 1 from khub_bot.buy_fulfillments f where f.seller_id=p_id) or exists(select 1 from seller_lots)');
        body:=replace(body,'|| khub_bot.profile_feedback(p.id) as stats','|| khub_bot.profile_feedback(p.id) || khub_bot.buy_profile_totals(p.id) as stats');
        body:=replace(body,'(select max(b.created_at) from public.bids b where b.auction_id=a.id) as latest_bid_at',
            'greatest((select max(b.created_at) from public.bids b where b.auction_id=a.id),(select max(f.created_at) from khub_bot.buy_fulfillments f where f.auction_id=a.id)) as latest_bid_at');
        execute body;
    end loop;
    select prosrc into body from pg_proc where oid='public.read_auction_page(text,uuid,text,text,text,integer,text)'::regprocedure;
    body:=replace(body,'where (p_view<>''others''','where (p_kind=''all'' or a.auction_kind=p_kind) and (p_view<>''others''');
    execute 'create function public.read_auction_page(p_view text,p_id uuid,p_search text,p_status text,p_sort text,p_page integer,p_trade text,p_kind text) returns jsonb language sql stable security definer set search_path='''' as '||quote_literal(body);
end; $$;

-- Fulfillment sellers can open the existing private auction support thread.
do $$
declare definition text;
begin
    definition:=pg_get_functiondef('public.submit_trade_query(uuid,uuid,text)'::regprocedure);
    definition:=replace(definition,'actor.id=a.seller_id or (a.finalized_at',
        'actor.id=a.seller_id or exists(select 1 from khub_bot.buy_fulfillments f where f.auction_id=a.id and f.seller_id=actor.id) or (a.finalized_at');
    execute definition;
end; $$;
revoke all on function khub_bot.buy_history(uuid),khub_bot.buy_profile_totals(uuid),khub_bot.guard_buy_terms() from public,anon,authenticated,service_role;

alter function public.bot_inspect() set schema khub_bot;
alter function khub_bot.bot_inspect() rename to inspect_before_buy_orders;
create function public.bot_inspect() returns jsonb
language sql security definer set search_path='' as $$
    select khub_bot.inspect_before_buy_orders()||jsonb_build_object('buyAuctionsVersion',1,'buyOrderEscrow',jsonb_build_object(
        'active_orders',(select count(*) from public.auctions where auction_kind='buy' and status='active'),
        'remaining_meat',(select coalesce(sum(balance_meat),0)::text from khub_bot.buy_orders),
        'held_items',(select coalesce(sum(held_quantity),0)::text from khub_bot.buy_orders),
        'fill_count',(select count(*) from khub_bot.buy_fulfillments)));
$$;
revoke all on function public.bot_inspect(),khub_bot.inspect_before_buy_orders() from public,anon,authenticated,service_role;
grant execute on function public.bot_inspect() to service_role;

-- Separate fulfillment totals avoid treating an order with several sellers as
-- one conventional sale. These include secured, irrevocably accepted purchases.
alter function public.bot_financial_stats() set schema khub_bot;
alter function khub_bot.bot_financial_stats() rename to sell_financial_stats;
create function public.bot_financial_stats() returns jsonb
language sql stable security definer set search_path='' as $$
    select khub_bot.sell_financial_stats() || jsonb_build_object('buy_orders',jsonb_build_object(
        'fulfillments',(select count(*)::text from khub_bot.buy_fulfillments),
        'purchase_meat',(select coalesce(sum(payment_meat),0)::text from khub_bot.buy_fulfillments),
        'commission_meat',(select coalesce(sum(commission_meat),0)::text from khub_bot.buy_fulfillments),
        'held_meat',(select coalesce(sum(balance_meat),0)::text from khub_bot.buy_orders),
        'held_items',(select coalesce(sum(held_quantity),0)::text from khub_bot.buy_orders)));
$$;
alter function public.bot_financial_history(text,bigint,integer) set schema khub_bot;
alter function khub_bot.bot_financial_history(text,bigint,integer) rename to sell_financial_history;
create function public.bot_financial_history(p_kind text,p_offset bigint default 0,p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare rows jsonb;
begin
    if p_kind<>'buy-orders' then return khub_bot.sell_financial_history(p_kind,p_offset,p_limit); end if;
    if p_offset is null or p_offset<0 or p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid report page.'; end if;
    select coalesce(jsonb_agg(to_jsonb(r) order by r.completed_at desc,r.receipt_id desc),'[]'::jsonb) into rows from (
        select f.receipt_id,a.auction_number::text,a.item,f.quantity::text,f.created_at as completed_at,
            f.price_per_item::text,f.payment_meat::text as sale_meat,f.commission_meat::text,f.payment_meat::text as seller_proceeds_meat
        from khub_bot.buy_fulfillments f join public.auctions a on a.id=f.auction_id
        order by f.created_at desc,f.receipt_id desc limit p_limit offset p_offset
    ) r;
    return jsonb_build_object('kind',p_kind,'offset',p_offset,'limit',p_limit,'records',rows);
end; $$;
revoke all on function public.bot_financial_stats(),public.bot_financial_history(text,bigint,integer),khub_bot.sell_financial_stats(),khub_bot.sell_financial_history(text,bigint,integer) from public,anon,authenticated,service_role;
grant execute on function public.bot_financial_stats(),public.bot_financial_history(text,bigint,integer) to service_role;

-- Revoke renamed entry points as well as new internals; wrappers are the only
-- intended browser/service endpoints.
revoke all on function khub_bot.buy_fee_numerator(bigint),khub_bot.finish_buy_order(uuid,text),khub_bot.finish_listing(uuid,text),khub_bot.finish_sell_listing(uuid,text),
    khub_bot.ingest_before_buy_orders(jsonb),khub_bot.sell_friendly_message(khub_bot.deliveries),khub_bot.friendly_message(khub_bot.deliveries),
    khub_bot.public_auction(public.auctions,bigint,text,text),khub_bot.public_sell_auction(public.auctions,bigint,text,text),public.cancel_sell_auction(uuid) from public,anon,authenticated,service_role;
revoke all on function public.create_buy_auction(integer,bigint,bigint,integer,text),public.cancel_auction(uuid) from public,anon,authenticated;
grant execute on function public.create_buy_auction(integer,bigint,bigint,integer,text),public.cancel_auction(uuid) to authenticated;
revoke all on function public.bot_ingest_mail(jsonb) from public,anon,authenticated;
grant execute on function public.bot_ingest_mail(jsonb) to service_role;
revoke all on function public.read_auction_page(text,uuid,text,text,text,integer,text,text) from public;
grant execute on function public.read_auction_page(text,uuid,text,text,text,integer,text,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
