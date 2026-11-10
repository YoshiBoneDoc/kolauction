-- Run the whole script in Supabase SQL Editor as the database owner.
-- Physical assets only: Mr. A is item #194; its Meat-equivalent bid value is not Meat held.
-- Requires mixed-payment migrations 237–239.
-- One read-only snapshot. No worker start, financial locks, or ledger mutations.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '15s';

with
payloads as (
    select 'Mail awaiting refund review'::text category, 'KMail '||r.mail_id reference, r.payload p
    from khub_bot.receipts r join khub_bot.mail_policy_reviews v on v.receipt_id=r.mail_id
    where not v.refund_queued
    union all
    select 'Verified gift awaiting intake', 'KMail '||g.mail_id, g.payload
    from khub_bot.incoming_gifts g where g.payload is not null and not g.legacy_donation
      and not exists(select 1 from khub_bot.receipts r where r.mail_id=g.mail_id)
    union all
    select 'Raffle intake hold', 'KMail '||h.mail_id, h.payload
    from khub_bot.raffle_intake_holds h where not h.verified_gift
      and not exists(select 1 from khub_bot.receipts r where r.mail_id=h.mail_id)
), obligations as (
    select 'SELL deposited items'::text category, 'Auction #'||a.auction_number reference,
           (x->>'id')::text item_id, (x->>'quantity')::numeric amount
    from public.auctions a cross join lateral jsonb_array_elements(khub_bot.auction_items(a)) x
    where a.auction_kind='sell' and a.escrow_mode and (a.status='active' or (a.mr_a_rate is not null and a.status='on_hold')) and a.item_escrowed_at is not null
    union all
    select 'Current funded bid', 'Auction #'||a.auction_number, null, coalesce(a.payment_meat,a.current_bid)::numeric
    from public.auctions a where a.auction_kind='sell' and a.escrow_mode
      and (a.status='active' or (a.mr_a_rate is not null and a.status='on_hold'))
    union all
    select 'Current funded bid', 'Auction #'||a.auction_number, '194', a.payment_mr_a::numeric
    from public.auctions a where a.auction_kind='sell' and a.escrow_mode
      and (a.status='active' or (a.mr_a_rate is not null and a.status='on_hold'))
      and a.payment_mr_a>0
    union all
    select 'BUY remaining funds', 'Auction #'||a.auction_number, null, b.balance_meat::numeric
    from khub_bot.buy_orders b join public.auctions a on a.id=b.auction_id
    union all
    select 'BUY purchased items awaiting dispatch', 'Auction #'||a.auction_number, a.item_id::text, b.held_quantity::numeric
    from khub_bot.buy_orders b join public.auctions a on a.id=b.auction_id
    union all
    select 'Outgoing '||d.kind||' ('||d.state||')',
           concat_ws(' / ', 'Delivery '||d.id, 'Auction #'||a.auction_number, 'KMail '||d.receipt_id),
           null, d.meat::numeric
    from khub_bot.deliveries d left join public.auctions a on a.id=d.auction_id where d.state not in ('sent','cancelled')
    union all
    select 'Outgoing '||d.kind||' ('||d.state||')',
           concat_ws(' / ', 'Delivery '||d.id, 'Auction #'||a.auction_number, 'KMail '||d.receipt_id),
           d.item_id::text, d.quantity::numeric
    from khub_bot.deliveries d left join public.auctions a on a.id=d.auction_id
    where d.state not in ('sent','cancelled') and d.item_id is not null
    union all
    select 'Raffle ticket proceeds', 'Raffle '||r.raffle_id, null, r.held_meat::numeric from khub_bot.raffle_accounts r
    union all
    select 'Raffle deposited items', 'Raffle '||r.raffle_id, r.item_id::text, r.quantity::numeric from khub_bot.raffle_inventory r
    union all
    select category, reference, null, (p->>'meat')::numeric from payloads
    union all
    select category, reference, x->>'id', (x->>'quantity')::numeric
    from payloads cross join lateral jsonb_array_elements(p->'items') x
    union all
    select 'Uncertain gift asset protection', 'Unallocated review hold', null, (held->>'meat')::numeric
    from khub_bot.gift_asset_protection where id
    union all
    select 'Uncertain gift asset protection', 'Unallocated review hold', x.key, x.value::numeric
    from khub_bot.gift_asset_protection cross join lateral jsonb_each_text(held->'items') x where id
), detailed as (
    select category, reference, coalesce(item_id,'Meat') asset, sum(amount) amount
    from obligations group by category,reference,coalesce(item_id,'Meat') having sum(amount)<>0
), expected as (
    select public.bot_liabilities() b
), totals as (
    select 'Meat' asset, (b->>'meat')::numeric amount from expected
    union all select key, value::numeric from expected cross join lateral jsonb_each_text(b->'items')
), differences as (
    select coalesce(t.asset,d.asset) asset, coalesce(t.amount,0)-coalesce(d.amount,0) amount
    from totals t full join (select asset,sum(amount) amount from detailed group by asset) d using(asset)
), auction_context as (
    -- Buy listing owners are buyers; fulfillment participants are sellers.
    -- Sell listing owners are sellers; the highest bidder is the current buyer.
    select a.id, a.auction_number, a.item as listing_item,
           case when a.auction_kind='buy' then (
               select string_agg(distinct coalesce(p.khub_username, 'Player #'||f.seller_kol_id), ', ')
               from khub_bot.buy_fulfillments f left join public.profiles p on p.id=f.seller_id
               where f.auction_id=a.id
           ) else owner.khub_username end seller_username,
           case when a.auction_kind='buy' then owner.khub_username
                else bidder.khub_username end buyer_username
    from public.auctions a
    left join public.profiles owner on owner.id=a.seller_id
    left join public.profiles bidder on bidder.id=a.highest_bidder_id
), reference_context as (
    select 'Auction #'||a.auction_number reference, a.listing_item,
           a.seller_username, a.buyer_username,
           null::text recipient_username, null::text sender_username
    from auction_context a
    union all
    select concat_ws(' / ', 'Delivery '||d.id, 'Auction #'||a.auction_number, 'KMail '||d.receipt_id),
           a.listing_item, a.seller_username, a.buyer_username,
           coalesce(recipient.khub_username, 'Player #'||d.recipient_id), null
    from khub_bot.deliveries d
    left join auction_context a on a.id=d.auction_id
    left join public.profiles recipient on recipient.kol_player_id=d.recipient_id
    where d.state not in ('sent','cancelled')
    union all
    select distinct pl.reference, null, null, null, null,
           coalesce(sender.khub_username, 'Player #'||(pl.p->>'sender_id'))
    from payloads pl left join public.profiles sender on sender.kol_player_id::text=pl.p->>'sender_id'
    union all
    select 'Raffle '||r.id, r.name, owner.khub_username, null, null, null
    from public.mystery_raffles r left join public.profiles owner on owner.id=r.creator_id
), report as (
    select 0 sort, 'TOTAL PROTECTED'::text category, ''::text reference, asset, amount from totals where amount<>0
    union all select 1,category,reference,asset,amount from detailed
    union all select 2,'UNEXPLAINED DIFFERENCE — investigate', '',asset,amount from differences where amount<>0
)
select r.category, r.reference,
       case when r.asset='Meat' then 'Meat'
            else coalesce(c.name, 'Unknown item')||' (#'||r.asset||')' end asset,
       to_char(r.amount, 'FM999,999,999,999,999,999,999,999,999,999,999,999,990') amount,
       ctx.listing_item,
       ctx.seller_username,
       ctx.buyer_username,
       ctx.recipient_username,
       ctx.sender_username
from report r
left join khub_bot.catalog c on c.id::text=r.asset
left join reference_context ctx on ctx.reference=r.reference
order by r.sort,r.asset,r.category,r.reference;

commit;
