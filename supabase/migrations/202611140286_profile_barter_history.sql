-- After 285. Apply once, then deploy the website. No financial/settlement changes.
-- New unified profile reader; existing browse/detail/cache RPCs are untouched.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
create index barter_bidder_history on khub_bot.barter_offers(bidder_id,auction_id,created_at desc,id desc);

-- Adapter records exist only inside this read. Never insert estimated barter
-- values into public.auctions or the financial/settlement ledger.
create function khub_bot.profile_barter_records(p_view text,p_seller uuid)
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
    when b.current_offer_id is not null then 'awaiting_trade' else 'ended_no_bids' end,
  'finalized_at',case when b.end_time<=statement_timestamp() and b.cancelled_at is null then b.end_time end,
  'final_price',case when b.end_time<=statement_timestamp() and b.cancelled_at is null then chosen.value end,
  'winner_id',case when b.end_time<=statement_timestamp() and khub_bot.can_view_usernames()
    and (auth.uid() in (b.seller_id,chosen.bidder_id) or khub_bot.is_administrator(auth.uid())) then chosen.bidder_id end
 )) r
 where khub_bot.direct_trade_visible(b.seller_id,false)
 and (p_view='seller' or (p_view='profile' and auth.uid() is not null and khub_bot.can_view_usernames()));
$$;
create function khub_bot.profile_barter_projection(a public.auctions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object(
  'id',a.id,'auction_kind','barter','seller_id',a.seller_id,
  'seller_username',case when khub_bot.can_view_usernames() then (select khub_username from public.profiles where id=a.seller_id) else 'Host' end,
  'usernames_visible',khub_bot.can_view_usernames(),'item',a.item,'item_id',a.item_id,
  'image',a.image,'quantity',a.quantity,'escrow_mode',false,'created_at',a.created_at,
  'end_time',a.end_time,'cancelled_at',a.cancelled_at,'finalized_at',a.finalized_at,
  'status',a.status,'min_bid_meat',a.min_bid_meat,'current_bid',a.current_bid,
  'final_price',a.final_price,'has_winner',a.status='awaiting_trade' and a.current_bid>0,
  'winner_id',a.winner_id,'winner_username',case when a.winner_id=auth.uid() then 'You' else 'Winner' end,
  'winner_public',false,'bid_count',a.display_bid_count,
  'viewer_is_highest_bidder',case when khub_bot.can_view_usernames() then exists(
    select 1 from khub_bot.barter_auctions b join khub_bot.barter_offers o on o.id=b.current_offer_id where b.id=a.id and o.bidder_id=auth.uid()) else null end,
  'latest_bid_at',(select latest_bid_at from khub_bot.barter_auctions where id=a.id));
$$;
revoke all on function khub_bot.profile_barter_records(text,uuid),khub_bot.profile_barter_projection(public.auctions) from public,anon,authenticated;

-- Clone the current established reader, preserving ordinary row projections,
-- restrictions, seller statistics and ordering. Merge before LIMIT/OFFSET.
do $patch$
declare d text; anchor text; projection text; start_at integer; end_at integer;
begin
 select prosrc into d from pg_proc where oid='public.read_auction_page(text,uuid,text,text,text,integer,text,text)'::regprocedure;
 if strpos(d,'with hot_auctions as materialized')=0
 or strpos(d,'), page as materialized (')=0
 or strpos(d,'join public.auctions a on a.id=p.id')=0
 or strpos(d,'khub_bot.public_auction(a,p.bid_count,h.label,w.label)')=0 then
   raise exception 'Unexpected profile history reader; inspect before applying 286.';
 end if;
 d:=replace(d,'with hot_auctions as materialized',
   'with barter_records as materialized (select * from khub_bot.profile_barter_records(p_view,p_id)), hot_auctions as materialized');
 d:=replace(d,'), page as materialized (',$merge$
 union all
 select b.*,0 as deal_score,b.display_bid_count as bid_count,
   case when p_sort='activity' then (select latest_bid_at from khub_bot.barter_auctions where id=b.id) end as latest_bid_at
 from barter_records b
 where p_kind in ('all','barter') and p_trade in ('all','direct')
 and (p_view='profile' or (
   lower(b.item) like khub_bot.literal_auction_pattern(p_search)
   and case when p_status='all' then true
     when p_status='ended' then b.status<>'active'
     when p_status='expired' then b.status='ended_no_bids'
     else b.status=p_status end))
), page as materialized ($merge$);
 -- The original ordinary projection retains all its scoped privacy checks.
 start_at:=strpos(d,'khub_bot.public_auction(a,p.bid_count,h.label,w.label)');
 end_at:=strpos(d,E'
        order by p.ordinal');
 if end_at<=start_at then raise exception 'Unexpected profile row projection.'; end if;
 projection:=substring(d from start_at for end_at-start_at);
 d:=overlay(d placing 'case when a.auction_kind=''barter'' then khub_bot.profile_barter_projection(a) else '||projection||' end' from start_at for end_at-start_at);
 d:=replace(d,'join public.auctions a on a.id=p.id','cross join lateral jsonb_populate_record(null::public.auctions,to_jsonb(p)) a');
 -- A host with only barter listings must also have a seller profile shell.
 anchor:='where p_view=''seller'' and p.id=p_id and (';
 if strpos(d,anchor)=0 then raise exception 'Unexpected seller history metadata.'; end if;
 d:=replace(d,anchor,anchor||'exists(select 1 from barter_records) or ');
 -- Private bid history contains only the viewer's own latest barter offer. No
 -- other bidder identity or pending offer enters this response.
 anchor:='''bids'',coalesce(';
 if strpos(d,anchor)=0 then raise exception 'Unexpected profile bid projection.'; end if;
 d:=replace(d,anchor,$bids$'bids',coalesce((select jsonb_agg(jsonb_build_object(
   'id',mine.id,'auction_id',mine.auction_id,'bidder_id',mine.bidder_id,
   'bidder_username','You','amount',mine.value,'created_at',mine.created_at,'status',mine.status)) from (
   select distinct on (o.auction_id) o.* from khub_bot.barter_offers o
   where p_view='profile' and khub_bot.can_view_usernames() and o.bidder_id=auth.uid()
     and o.auction_id in (select id from page where auction_kind='barter')
   order by o.auction_id,o.created_at desc,o.id desc) mine),'[]'::jsonb)||coalesce($bids$);
 -- This RPC is explicitly scoped; it cannot be used to change ordinary browse.
 execute 'create function public.read_profile_auction_page(p_view text,p_id uuid default null,p_search text default '''',p_status text default ''all'',p_sort text default ''ending'',p_page integer default 1,p_trade text default ''all'',p_kind text default ''all'',p_summary_only boolean default false) returns jsonb language plpgsql stable security definer set search_path='''' as '
 ||quote_literal('declare result jsonb; begin if p_view not in (''profile'',''seller'') or p_view is null then raise exception ''Invalid profile view.''; end if; if p_summary_only then result:=public.read_seller_auction_context(p_id,''{}''::uuid[]); if result->''seller'' is not null and result->''seller''<>''null''::jsonb then return result; end if; end if; result:=('||rtrim(d,E' 
;')||'); if p_summary_only then result:=result||jsonb_build_object(''rows'',''[]''::jsonb,''bids'',''[]''::jsonb,''total'',0); end if; return result; end;');
end $patch$;
revoke all on function public.read_profile_auction_page(text,uuid,text,text,text,integer,text,text,boolean) from public,anon,authenticated;
grant execute on function public.read_profile_auction_page(text,uuid,text,text,text,integer,text,text,boolean) to anon,authenticated;
notify pgrst,'reload schema';
commit;
