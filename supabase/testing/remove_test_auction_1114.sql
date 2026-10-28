-- One-time maintenance for the owner's completed live gift test, auction #1114.
-- Run the entire file in Supabase SQL Editor. No bot restart is required.
-- Removes marketplace history/statistics, while retaining real transfer evidence.
-- Does not move assets, reset sequences, alter accounts, or touch other auctions.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';
select pg_advisory_xact_lock(3888760);

create table if not exists khub_bot.test_auction_archive (
    auction_id uuid primary key,
    auction_data jsonb not null,
    related_data jsonb not null,
    reason text not null,
    archived_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.test_auction_archive enable row level security;
revoke all on khub_bot.test_auction_archive from public, anon, authenticated;
grant select on khub_bot.test_auction_archive to service_role;

do $$
declare
    target constant uuid := 'f60d798e-f020-44d0-a351-57f808745c10';
    a public.auctions%rowtype;
begin
    select * into a from public.auctions where id=target for update;
    if not found then
        if exists(select 1 from khub_bot.test_auction_archive
            where auction_id=target and auction_data->>'auction_number'='1114') then
            raise notice 'Test auction #1114 was already archived and removed.';
            return;
        end if;
        raise exception 'Expected test auction #1114 was not found; nothing changed.';
    end if;
    if a.auction_number<>1114 or a.status<>'completed' or not a.escrow_mode
        or a.auction_kind<>'sell' or a.item_id<>1904 or a.quantity<>1
        or a.final_price is distinct from 10000 or a.fee_meat is distinct from 500
        or a.settled_at is null or a.winner_id is null
        or not exists(select 1 from public.profiles where id=a.seller_id and kol_player_id=3552305)
        or not exists(select 1 from public.profiles where id=a.winner_id and kol_player_id=1582168) then
        raise exception 'Auction does not match the completed 5-ball test; nothing changed.';
    end if;
    if exists(select 1 from khub_bot.deliveries where auction_id=target and state<>'sent')
        or exists(select 1 from khub_bot.closet_transfers where auction_id=target and state<>'moved') then
        raise exception 'Test has unfinished deliveries or closet transfers; nothing changed.';
    end if;
    if not exists(select 1 from khub_bot.deliveries where auction_id=target
        and kind='sale_item' and state='sent' and recipient_id=1582168 and item_id=1904 and quantity=1 and meat=0)
        or not exists(select 1 from khub_bot.deliveries where auction_id=target
        and kind='sale_meat' and state='sent' and recipient_id=3552305 and meat=9500 and item_id is null)
        or not exists(select 1 from khub_bot.closet_transfers where auction_id=target
        and source='sale_fee' and state='moved' and meat=500) then
        raise exception 'Expected completed test transfers are missing; nothing changed.';
    end if;
    -- Unexpected moderation/feedback records need separate review, not erasure.
    if exists(select 1 from khub_bot.trade_reports where auction_id=target)
        or exists(select 1 from khub_bot.trade_queries where auction_id=target)
        or exists(select 1 from khub_bot.trade_feedback where auction_id=target)
        or exists(select 1 from khub_bot.rating_notifications where auction_id=target)
        or exists(select 1 from khub_bot.auction_ban_reviews where auction_id=target)
        or exists(select 1 from khub_bot.direct_trade_reminders where auction_id=target)
        or exists(select 1 from khub_bot.buy_orders where auction_id=target) then
        raise exception 'Unexpected related records require review; nothing changed.';
    end if;

    insert into khub_bot.test_auction_archive(auction_id,auction_data,related_data,reason)
    values(target,to_jsonb(a),jsonb_build_object(
        'bids',(select coalesce(jsonb_agg(to_jsonb(b)),'[]') from public.bids b where auction_id=target),
        'bid_receipts',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from khub_bot.bid_receipts r
            join public.bids b on b.id=r.bid_id where b.auction_id=target),
        'bid_extensions',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from khub_bot.auction_bid_extensions e where auction_id=target),
        'market_prices',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from khub_bot.auction_market_prices p where auction_id=target),
        'mail_order',(select coalesce(jsonb_agg(to_jsonb(o)),'[]') from khub_bot.escrow_mail_order o where auction_id=target),
        'close_authorizations',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from khub_bot.escrow_close_authorizations c where auction_id=target),
        'deliveries',(select coalesce(jsonb_agg(to_jsonb(d)),'[]') from khub_bot.deliveries d where auction_id=target),
        'closet_transfers',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from khub_bot.closet_transfers c where auction_id=target)
    ),'Owner-requested removal of completed live gift-delivery test #1114. Real transfers retained privately.');

    -- Preserve states, amounts, recipients, receipts, references and evidence.
    -- Only detach the foreign key, as in the existing prelaunch cleanup.
    update khub_bot.deliveries set auction_id=null where auction_id=target;
    update khub_bot.closet_transfers set auction_id=null where auction_id=target;
    delete from khub_bot.auction_bid_extensions where auction_id=target;
    delete from public.bids where auction_id=target;
    delete from public.auctions where id=target;
    -- Dependent bid-receipt links, market snapshots and close metadata cascade;
    -- all were archived above. Unexpected foreign keys abort this transaction.
end;
$$;

select 'Test auction #1114 removed from marketplace history and derived trade totals; transfer evidence retained privately.' as result,
    not exists(select 1 from public.auctions where id='f60d798e-f020-44d0-a351-57f808745c10') as removed,
    exists(select 1 from khub_bot.test_auction_archive where auction_id='f60d798e-f020-44d0-a351-57f808745c10') as privately_archived;
commit;
