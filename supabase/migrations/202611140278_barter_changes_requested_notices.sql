-- After 277. Reuse the private pending-notice read for bidder change requests.
begin;
create index barter_requested_changes_by_bidder on khub_bot.barter_offers(bidder_id,auction_id,created_at desc,id) where status='changes_requested';
create or replace function public.read_barter_pending() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p public.profiles%rowtype;
begin
 select * into p from public.profiles where id=auth.uid();
 if not found or p.is_banned or khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name) then return '[]'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'item',q.item,'count',q.n,'kind',q.kind) order by q.end_time,q.id) from (
  (select a.id,a.item,count(o.id) n,'pending'::text kind,a.end_time
   from khub_bot.barter_auctions a join khub_bot.barter_offers o on o.auction_id=a.id and o.status='pending'
   where a.seller_id=p.id and a.end_time>statement_timestamp() and a.cancelled_at is null
   group by a.id order by a.end_time,a.id limit 20)
  union all
  (select a.id,a.item,null::bigint n,'changes_requested'::text kind,a.end_time
   from khub_bot.barter_offers o join khub_bot.barter_auctions a on a.id=o.auction_id
   where o.bidder_id=p.id and o.status='changes_requested' and a.end_time>statement_timestamp() and a.cancelled_at is null
   and khub_bot.direct_trade_visible(a.seller_id,false)
   and not exists(select 1 from khub_bot.barter_offers newer where newer.auction_id=o.auction_id and newer.bidder_id=o.bidder_id
      and (newer.created_at,newer.id)>(o.created_at,o.id))
   order by a.end_time,a.id limit 20)
  order by end_time,id limit 20
 ) q),'[]');
end; $$;
notify pgrst,'reload schema';
commit;
