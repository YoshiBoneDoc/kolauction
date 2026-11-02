-- One-account removal, requested by BlakAcid (#1455915).
-- Run with the bot stopped. Any failed check or FK rolls back the entire script.
-- Retains private financial evidence, not passwords, sessions or Auth metadata.
begin;
set local lock_timeout = '2s';
select pg_advisory_xact_lock(3888760);

create table if not exists khub_bot.account_removal_archives (
    user_id uuid primary key,
    kol_player_id bigint not null,
    removed_at timestamptz not null default clock_timestamp(),
    financial_records jsonb not null
);
alter table khub_bot.account_removal_archives enable row level security;
revoke all on khub_bot.account_removal_archives from public, anon, authenticated, service_role;

do $remove$
declare
    target_id constant uuid := '2f1159d1-af21-41fb-afd6-2c1a57510bed';
    listing_id constant uuid := '328f8a5e-12c6-458e-8161-bdfcf3a1f987';
    listing public.auctions%rowtype;
    ledger khub_bot.buy_orders%rowtype;
begin
    -- Fresh databases and successful reruns have no account to remove.
    if not exists(select 1 from public.profiles where id=target_id)
       and not exists(select 1 from auth.users where id=target_id) then
        return;
    end if;
    perform 1 from auth.users where id=target_id for update;
    if not found then raise exception 'Expected Auth account missing.'; end if;
    perform 1 from public.profiles where id=target_id and kol_player_id=1455915
        and lower(khub_username)='blakacid' for update;
    if not found then raise exception 'Expected BlakAcid profile does not match.'; end if;

    select * into listing from public.auctions where id=listing_id for update;
    if not found then raise exception 'Expected cancelled listing missing.'; end if;
    if listing.seller_id<>target_id or listing.status<>'cancelled'
       or listing.auction_kind<>'buy' or listing.final_price is not null then
        raise exception 'Listing is not the expected cancelled buy order.';
    end if;
    if exists(select 1 from public.auctions where seller_id=target_id and id<>listing_id)
       or exists(select 1 from public.auctions where winner_id=target_id or highest_bidder_id=target_id)
       or exists(select 1 from public.bids where bidder_id=target_id or auction_id=listing_id) then
        raise exception 'Additional auction or bid history needs review.';
    end if;

    select * into ledger from khub_bot.buy_orders where auction_id=listing_id for update;
    if not found then raise exception 'Expected buy ledger missing.'; end if;
    if ledger.funded_meat<>205110000 or ledger.refunded_meat<>205110000
       or ledger.balance_meat<>0 or ledger.held_quantity<>0
       or ledger.purchased_quantity<>0 or ledger.purchase_meat<>0
       or ledger.commission_meat<>0 or ledger.gift_meat<>0 or not ledger.refund_finalized then
        raise exception 'Order is not fully refunded and closed.';
    end if;
    if exists(select 1 from khub_bot.buy_fulfillments where auction_id=listing_id or seller_id=target_id)
       or exists(select 1 from khub_bot.buy_reservations where auction_id=listing_id or seller_id=target_id)
       or exists(select 1 from khub_bot.buy_item_batches where auction_id=listing_id)
       or exists(select 1 from khub_bot.buy_gift_expenses where auction_id=listing_id)
       or exists(select 1 from khub_bot.account_jobs
                 where (user_id=target_id or kol_player_id=1455915) and state='pending') then
        raise exception 'Additional fulfillment, reservation, gift or account records need review.';
    end if;

    perform 1 from khub_bot.deliveries
        where auction_id=listing_id or recipient_id=1455915 for update;
    if exists(select 1 from khub_bot.deliveries
              where (auction_id=listing_id or recipient_id=1455915) and state<>'sent') then
        raise exception 'Unsent or unresolved deliveries remain.';
    end if;
    if (select count(*) from khub_bot.deliveries where auction_id=listing_id)<>2
       or not exists(select 1 from khub_bot.deliveries
           where id='3f6065df-b6d2-4dc2-948c-c33982487e4b' and auction_id=listing_id
             and recipient_id=1455915 and kind='notice' and state='sent' and meat=0 and quantity=0)
       or not exists(select 1 from khub_bot.deliveries
           where id='830b799d-8687-44b8-ae57-907d9634e277' and auction_id=listing_id
             and recipient_id=1455915 and kind='refund' and state='sent' and meat=205110000 and quantity=0) then
        raise exception 'Delivery records differ from the reviewed notice and refund.';
    end if;

    -- Store original links and complete financial rows before removing the order.
    insert into khub_bot.account_removal_archives(user_id,kol_player_id,financial_records)
    values(target_id,1455915,jsonb_build_object(
        'auction',to_jsonb(listing),'buy_order',to_jsonb(ledger),
        'deliveries',(select jsonb_agg(to_jsonb(d) order by d.id)
                      from khub_bot.deliveries d where d.auction_id=listing_id),
        'buy_order_events',coalesce((select jsonb_agg(to_jsonb(e) order by e.id)
                      from khub_bot.buy_order_events e where e.auction_id=listing_id),'[]'::jsonb),
        'delivery_profile',(select to_jsonb(p) from khub_bot.buy_delivery_profiles p where p.auction_id=listing_id)
    ));

    -- Keep sent deliveries and receipt/reconciliation links in the live audit log.
    update khub_bot.deliveries set auction_id=null where auction_id=listing_id;
    delete from khub_bot.buy_order_events where auction_id=listing_id;
    delete from khub_bot.buy_delivery_profiles where auction_id=listing_id;
    delete from khub_bot.buy_orders where auction_id=listing_id;
    delete from public.auctions where id=listing_id;
    delete from khub_bot.verifications where user_id=target_id;
    delete from public.site_activity where user_id=target_id;
    -- Auth deletion cascades to sessions, identities, the profile and private votes/ignores.
    -- Other restrictive references intentionally abort rather than erase history.
    delete from auth.users where id=target_id;
    if not found then raise exception 'Auth deletion failed.'; end if;
end;
$remove$;

commit;
