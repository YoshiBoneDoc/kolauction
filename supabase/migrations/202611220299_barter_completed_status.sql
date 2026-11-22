-- After 298. Read existing participant confirmations; no financial ledger changes.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
create function khub_bot.barter_completed(a khub_bot.barter_auctions) returns boolean
language sql stable set search_path='' as $$
 select a.cancelled_at is null and a.end_time<=statement_timestamp() and exists(
 select 1 from khub_bot.barter_offers o
 join khub_bot.barter_trade_responses host on host.auction_id=a.id and host.actor_id=a.seller_id
 join khub_bot.barter_trade_responses bidder on bidder.auction_id=a.id and bidder.actor_id=o.bidder_id
 where o.id=a.current_offer_id and o.auction_id=a.id and o.status='accepted');
$$;
revoke all on function khub_bot.barter_completed(khub_bot.barter_auctions) from public,anon,authenticated;
create or replace function khub_bot.profile_barter_records(p_view text,p_seller uuid)
returns setof public.auctions language sql stable set search_path='' as $$
 with scoped_ids as materialized (
   select id from khub_bot.barter_auctions where p_view='seller' and seller_id=p_seller
   union
   select id from khub_bot.barter_auctions where p_view='profile' and seller_id=auth.uid()
   union
   select auction_id from khub_bot.barter_offers where p_view='profile' and bidder_id=auth.uid()
 )
 select r.* from scoped_ids scope join khub_bot.barter_auctions b on b.id=scope.id
 left join khub_bot.barter_offers chosen on chosen.id=b.current_offer_id
 cross join lateral jsonb_populate_record(null::public.auctions,jsonb_build_object(
  'id',b.id,'seller_id',b.seller_id,'auction_kind','barter','item',b.item,
  'item_id',b.item_id,'image',b.image,'quantity',b.quantity,'escrow_mode',false,
  'created_at',b.created_at,'end_time',b.end_time,'cancelled_at',b.cancelled_at,
  'min_bid_meat',coalesce(b.minimum_value,0),'current_bid',coalesce(chosen.value,0),
  'display_bid_count',(select count(*) from khub_bot.barter_offers o where o.auction_id=b.id and o.accepted_at is not null),
  'status',case when b.cancelled_at is not null then 'cancelled'
    when b.end_time>statement_timestamp() then 'active'
    when khub_bot.barter_completed(b) then 'completed'
    when b.current_offer_id is not null then 'awaiting_trade' else 'ended_no_bids' end,
  'finalized_at',case when b.end_time<=statement_timestamp() and b.cancelled_at is null then b.end_time end,
  'final_price',case when b.end_time<=statement_timestamp() and b.cancelled_at is null then chosen.value end,
  'winner_id',case when b.end_time<=statement_timestamp() and khub_bot.can_view_usernames()
    and (auth.uid() in (b.seller_id,chosen.bidder_id) or khub_bot.is_administrator(auth.uid())) then chosen.bidder_id end
 )) r
 where khub_bot.direct_trade_visible(b.seller_id,false)
 and (p_view='seller' or (p_view='profile' and auth.uid() is not null and khub_bot.can_view_usernames()));
$$;
create or replace function khub_bot.profile_barter_projection(a public.auctions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object(
  'id',a.id,'auction_kind','barter','seller_id',a.seller_id,
  'seller_username',case when khub_bot.can_view_usernames() then (select khub_username from public.profiles where id=a.seller_id) else 'Host' end,
  'usernames_visible',khub_bot.can_view_usernames(),'item',a.item,'item_id',a.item_id,
  'image',a.image,'quantity',a.quantity,'escrow_mode',false,'created_at',a.created_at,
  'end_time',a.end_time,'cancelled_at',a.cancelled_at,'finalized_at',a.finalized_at,
  'status',a.status,'min_bid_meat',a.min_bid_meat,'current_bid',a.current_bid,
  'final_price',a.final_price,'has_winner',a.status in ('awaiting_trade','completed') and a.current_bid>0,
  'winner_id',a.winner_id,'winner_username',case when a.winner_id=auth.uid() then 'You' else 'Winner' end,
  'winner_public',false,'bid_count',a.display_bid_count,
  'viewer_is_highest_bidder',case when khub_bot.can_view_usernames() then exists(
    select 1 from khub_bot.barter_auctions b join khub_bot.barter_offers o on o.id=b.current_offer_id where b.id=a.id and o.bidder_id=auth.uid()) else null end,
  'latest_bid_at',(select latest_bid_at from khub_bot.barter_auctions where id=a.id));
$$;
create or replace function khub_bot.barter_card(a khub_bot.barter_auctions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',a.id,'sellerId',a.seller_id,'itemId',a.item_id,'item',a.item,'image',a.image,'quantity',a.quantity,
 'marketValue',a.market_value,'minimumValue',a.minimum_value,'createdAt',extract(epoch from a.created_at)*1000,
 'endTime',extract(epoch from a.end_time)*1000,'latestBidAt',extract(epoch from a.latest_bid_at)*1000,
 'completed',khub_bot.barter_completed(a),'cancelled',a.cancelled_at is not null,'currentOfferId',a.current_offer_id,
 'currentBid',coalesce((select value from khub_bot.barter_offers where id=a.current_offer_id),0));
$$;
create or replace function public.read_barter_auctions(p_search text default '',p_sort text default 'ending',p_page integer default 1,p_status text default 'active') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare rows jsonb; more boolean;
begin
 if p_page is null or p_page not between 1 and 10000
 or p_sort is null or p_sort not in ('ending','ended-desc','newest','activity')
 or p_status is null or p_status not in ('all','active','cancelled','expired','ended')
 or length(p_search)>120 then raise exception 'Invalid browse options.'; end if;
 with pool as (
 select a as listing from khub_bot.barter_auctions a
 where (p_status='all'
 or p_status='active' and a.cancelled_at is null and a.end_time>statement_timestamp()
 or p_status='cancelled' and a.cancelled_at is not null
 or p_status='expired' and a.cancelled_at is null and a.end_time<=statement_timestamp() and a.current_offer_id is null
 or p_status='ended' and (a.cancelled_at is not null or a.end_time<=statement_timestamp()))
 and strpos(lower(a.item),lower(btrim(coalesce(p_search,''))))>0
 and khub_bot.direct_trade_visible(a.seller_id,false)
 order by case when p_sort='ending' then a.end_time end,
 case when p_sort='ended-desc' then coalesce(a.cancelled_at,a.end_time) end desc,
 case when p_sort='activity' then a.latest_bid_at end desc nulls last,
 case when p_sort='newest' then a.created_at end desc,a.created_at desc,a.id
 limit 25 offset (p_page-1)*24
 ) select coalesce(jsonb_agg(khub_bot.barter_card(listing) || jsonb_build_object(
 'status',case when (listing).cancelled_at is not null then 'cancelled'
 when (listing).end_time>statement_timestamp() then 'active'
 when khub_bot.barter_completed(listing) then 'completed'
 when (listing).current_offer_id is not null then 'awaiting_trade' else 'expired' end,
 'cancelledAt', (listing).cancelled_at)
 order by case when p_sort='ending' then (listing).end_time end,
 case when p_sort='ended-desc' then coalesce((listing).cancelled_at,(listing).end_time) end desc,
 case when p_sort='activity' then (listing).latest_bid_at end desc nulls last,
 case when p_sort='newest' then (listing).created_at end desc,(listing).created_at desc,(listing).id),'[]'),count(*)>24 into rows,more from pool;
 return jsonb_build_object('rows',rows-24,'more',more);
end; $$;
notify pgrst,'reload schema';
commit;
