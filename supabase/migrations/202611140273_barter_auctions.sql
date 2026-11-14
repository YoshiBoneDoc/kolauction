-- Separate Direct-only barter ledger. Apply once after 272; deploy website separately.
-- No ordinary auction, bot transfer, reserve, commission or trade-total paths change.
begin;
create table khub_bot.barter_auctions (
 id uuid primary key default gen_random_uuid(), seller_id uuid not null references public.profiles(id),
 item_id integer not null references khub_bot.catalog(id), item text not null, image text,
 quantity bigint not null check(quantity between 1 and 5000000000),
 market_value bigint not null check(market_value between 40000000 and 9007199254740991),
 minimum_value bigint check(minimum_value between 1 and 20000000000),
 created_at timestamptz not null default clock_timestamp(), end_time timestamptz not null,
 current_offer_id uuid, latest_bid_at timestamptz, cancelled_at timestamptz,
 request_id uuid not null unique, check(end_time>created_at)
);
create table khub_bot.barter_offers (
 id uuid primary key default gen_random_uuid(), auction_id uuid not null references khub_bot.barter_auctions(id),
 bidder_id uuid not null references public.profiles(id), meat bigint not null check(meat between 0 and 20000000000),
 items jsonb not null, value bigint not null check(value between 1 and 20000000000),
 status text not null default 'pending' check(status in ('pending','accepted','rejected','changes_requested','withdrawn')),
 rejected_items integer[] not null default '{}', created_at timestamptz not null default clock_timestamp(),
 reviewed_at timestamptz, accepted_at timestamptz, request_id uuid not null unique
);
alter table khub_bot.barter_auctions add foreign key(current_offer_id) references khub_bot.barter_offers(id);
create unique index barter_one_pending_offer on khub_bot.barter_offers(auction_id,bidder_id) where status='pending';
create index barter_browse_ending on khub_bot.barter_auctions(end_time,id) where cancelled_at is null;
create index barter_browse_newest on khub_bot.barter_auctions(created_at desc,id);
create index barter_browse_activity on khub_bot.barter_auctions(latest_bid_at desc nulls last,created_at desc,id);
create index barter_host on khub_bot.barter_auctions(seller_id,end_time);
create index barter_offer_history on khub_bot.barter_offers(auction_id,accepted_at desc) where accepted_at is not null;
create index barter_offer_private on khub_bot.barter_offers(auction_id,bidder_id,created_at desc);
create index barter_offer_pending on khub_bot.barter_offers(auction_id,created_at desc) where status='pending';
alter table khub_bot.barter_auctions enable row level security;
alter table khub_bot.barter_offers enable row level security;
revoke all on khub_bot.barter_auctions,khub_bot.barter_offers from public,anon,authenticated;

create function khub_bot.barter_quote(p_item integer,p_quantity bigint) returns bigint
language plpgsql stable set search_path='' as $$
declare q khub_bot.market_prices%rowtype; total numeric; stamp timestamptz:=statement_timestamp();
begin
 if p_quantity is null or p_quantity not between 1 and 5000000000 then raise exception 'Invalid item quantity.'; end if;
 select * into q from khub_bot.market_prices where item_id=p_item;
 if not found or not coalesce(q.available,false) or q.price_meat is null or q.price_meat<=0
  or q.observed_at is null or q.checked_at is null or q.checked_at>stamp or q.observed_at>q.checked_at
  or q.observed_at<=stamp-interval '26 hours' or q.checked_at<=stamp-interval '26 hours' then
  raise exception 'A fresh market price is unavailable for item %. Try again later.',p_item;
 end if;
 total:=q.price_meat::numeric*p_quantity;
 if total>9007199254740991 then raise exception 'Market value exceeds the supported exact-value range.'; end if;
 return total::bigint;
end; $$;

create function public.create_barter_auction(p_item_id integer,p_quantity bigint,p_minimum bigint,p_duration integer,p_end timestamptz,p_request uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; c khub_bot.catalog%rowtype; aid uuid; val bigint; ending timestamptz;
begin
 p:=khub_bot.require_verified_trader();
 -- Serialize duplicate publication tokens without taking the financial lock.
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,273));
 select id into aid from khub_bot.barter_auctions where request_id=p_request and seller_id=p.id;
 if found then return aid; end if;
 if p_request is null then raise exception 'Missing publication token.'; end if;
 select * into c from khub_bot.catalog where id=p_item_id;
 if not found or not khub_bot.auction_item_eligible(c) then raise exception 'Choose an eligible catalog item.'; end if;
 val:=khub_bot.barter_quote(p_item_id,p_quantity);
 if val<40000000 then raise exception 'Barter listings require at least 40m total market value.'; end if;
 if p_minimum is not null and p_minimum not between 1 and 20000000000 then raise exception 'Invalid minimum bid market value.'; end if;
 if p_duration is null or p_duration not in (6,12,24,72,168,336,720) then raise exception 'Invalid duration.'; end if;
 ending:=coalesce(p_end,clock_timestamp()+make_interval(hours=>p_duration));
 if ending<=clock_timestamp() or ending>clock_timestamp()+interval '30 days' then raise exception 'Choose an ending within 30 days.'; end if;
 insert into khub_bot.barter_auctions(seller_id,item_id,item,image,quantity,market_value,minimum_value,end_time,request_id)
 values(p.id,c.id,c.name,'https://images.kingdomofloathing.com/'||case when strpos(c.image,'/')>0 then c.image else 'itemimages/'||c.image end,
 p_quantity,val,p_minimum,ending,p_request) returning id into aid;
 return aid;
end; $$;

create function public.submit_barter_offer(p_auction uuid,p_meat bigint,p_items jsonb,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; a khub_bot.barter_auctions%rowtype; c khub_bot.catalog%rowtype;
 x jsonb; contents jsonb:='[]'; total numeric; unit_total bigint; oid uuid;
begin
 p:=khub_bot.require_verified_trader();
 select * into a from khub_bot.barter_auctions where id=p_auction for update;
 if not found then raise exception 'Barter not found.'; end if;
 select id into oid from khub_bot.barter_offers where request_id=p_request and bidder_id=p.id;
 if found then return oid; end if;
 if p_request is null then raise exception 'Missing offer token.'; end if;
 if a.seller_id=p.id then raise exception 'You cannot bid on your own barter.'; end if;
 if a.end_time<=clock_timestamp() or a.cancelled_at is not null then raise exception 'Bidding has closed.'; end if;
 if not khub_bot.direct_trade_visible(a.seller_id,false) then raise exception 'This Direct trade is unavailable.'; end if;
 if exists(select 1 from public.profiles s where s.id=a.seller_id and (s.is_banned or khub_bot.account_is_banned(s.kol_player_id,s.khub_username,s.kol_player_name))) then raise exception 'Host is restricted.'; end if;
 if p_meat is null or p_meat not between 0 and 20000000000 or jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Invalid offer.'; end if;
 if jsonb_array_length(p_items)>10 then raise exception 'Offer at most 10 item types.'; end if;
 total:=p_meat;
 for x in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(x) is distinct from 'object' or coalesce(x->>'id','')!~'^[1-9][0-9]{0,9}$' or coalesce(x->>'quantity','')!~'^[1-9][0-9]{0,9}$'
   or (x->>'id')::bigint>2147483647 or (x->>'quantity')::bigint>5000000000 then raise exception 'Invalid offer item or quantity.'; end if;
  if exists(select 1 from jsonb_array_elements(contents) y where y->>'id'=x->>'id') then raise exception 'Use one quantity per item.'; end if;
  select * into c from khub_bot.catalog where id=(x->>'id')::integer;
  if not found or not khub_bot.auction_item_eligible(c) then raise exception 'Choose eligible offer items.'; end if;
  unit_total:=khub_bot.barter_quote(c.id,(x->>'quantity')::bigint);
  total:=total+unit_total;
  contents:=contents||jsonb_build_array(jsonb_build_object('id',c.id,'name',c.name,'quantity',(x->>'quantity')::bigint,'marketValue',unit_total));
 end loop;
 if total<=0 or total>20000000000 then raise exception 'Offer value must be between 1 and 20 billion Meat.'; end if;
 if a.minimum_value is not null and total<=a.minimum_value then raise exception 'Offer must exceed the minimum bid market value.'; end if;
 if exists(select 1 from khub_bot.barter_offers where auction_id=a.id and bidder_id=p.id and status='pending') then raise exception 'You already have a pending offer. Wait for review or withdraw it.'; end if;
 if a.end_time<=clock_timestamp() then raise exception 'Bidding has closed.'; end if;
 insert into khub_bot.barter_offers(auction_id,bidder_id,meat,items,value,request_id)
 values(a.id,p.id,p_meat,contents,total,p_request) returning id into oid;
 update khub_bot.barter_auctions set latest_bid_at=clock_timestamp() where id=a.id;
 return oid;
end; $$;

create function public.review_barter_offer(p_offer uuid,p_decision text,p_rejected integer[] default '{}') returns void
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; a khub_bot.barter_auctions%rowtype; o khub_bot.barter_offers%rowtype;
begin
 p:=khub_bot.require_verified_trader();
 -- Always lock auction before offer, in the same order as submission.
 select b.* into a from khub_bot.barter_auctions b join khub_bot.barter_offers f on f.auction_id=b.id where f.id=p_offer for update of b;
 if not found then raise exception 'Offer not found.'; end if;
 select * into o from khub_bot.barter_offers where id=p_offer for update;
 if a.seller_id<>p.id then raise exception 'Only the host may review offers.'; end if;
 if p_decision is null or p_decision not in ('accepted','rejected','changes_requested') then raise exception 'Invalid decision.'; end if;
 -- Duplicate exact decisions are safe; conflicting decisions cannot overwrite evidence.
 if o.status=p_decision and o.rejected_items=coalesce(p_rejected,'{}') then return; end if;
 if o.status<>'pending' or a.end_time<=clock_timestamp() or a.cancelled_at is not null then raise exception 'This offer is no longer reviewable.'; end if;
 if exists(select 1 from public.profiles b where b.id=o.bidder_id and (b.is_banned or khub_bot.account_is_banned(b.kol_player_id,b.khub_username,b.kol_player_name))) then raise exception 'Bidder is restricted.'; end if;
 if exists(select 1 from public.player_ignores i join public.profiles h on h.id=a.seller_id join public.profiles b on b.id=o.bidder_id
  where (i.user_id=h.id and i.kol_player_id=b.kol_player_id) or (i.user_id=b.id and i.kol_player_id=h.kol_player_id)) then raise exception 'This Direct trade is unavailable.'; end if;
 if p_decision='changes_requested' then
  if coalesce(cardinality(p_rejected),0)=0 then raise exception 'Mark at least one item with an X.'; end if;
  if exists(select 1 from unnest(p_rejected) r where r is null or not exists(select 1 from jsonb_array_elements(o.items) x where (x->>'id')::integer=r)) then raise exception 'Invalid rejected item.'; end if;
 elsif coalesce(cardinality(p_rejected),0)<>0 then raise exception 'Item feedback is only valid when requesting changes.';
 end if;
 update khub_bot.barter_offers set status=p_decision,reviewed_at=clock_timestamp(),rejected_items=coalesce(p_rejected,'{}'),
 accepted_at=case when p_decision='accepted' then clock_timestamp() else null end where id=o.id;
 if p_decision='accepted' then update khub_bot.barter_auctions set current_offer_id=o.id where id=a.id; end if;
end; $$;

create function public.withdraw_barter_offer(p_offer uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a khub_bot.barter_auctions%rowtype;
begin
 perform khub_bot.require_verified_trader();
 select b.* into a from khub_bot.barter_auctions b join khub_bot.barter_offers o on o.auction_id=b.id where o.id=p_offer for update of b;
 if a.end_time<=clock_timestamp() then raise exception 'Bidding has closed.'; end if;
 update khub_bot.barter_offers set status='withdrawn' where id=p_offer and bidder_id=auth.uid() and status='pending';
 if not found then raise exception 'Only your pending offer can be withdrawn.'; end if;
end; $$;

-- Explicit public projections: never reveal pending offers or bidder identities.
create function khub_bot.barter_card(a khub_bot.barter_auctions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',a.id,'sellerId',a.seller_id,'itemId',a.item_id,'item',a.item,'image',a.image,'quantity',a.quantity,
 'marketValue',a.market_value,'minimumValue',a.minimum_value,'createdAt',extract(epoch from a.created_at)*1000,
 'endTime',extract(epoch from a.end_time)*1000,'latestBidAt',extract(epoch from a.latest_bid_at)*1000,
 'cancelled',a.cancelled_at is not null,'currentOfferId',a.current_offer_id,
 'currentBid',coalesce((select value from khub_bot.barter_offers where id=a.current_offer_id),0));
$$;
create function public.read_barter_auctions(p_search text default '',p_sort text default 'ending',p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare rows jsonb; more boolean;
begin
 if p_page is null or p_page not between 1 and 10000 or p_sort is null or p_sort not in ('ending','newest','activity') or length(p_search)>120 then raise exception 'Invalid browse options.'; end if;
 with pool as (
 select a as listing from khub_bot.barter_auctions a where a.cancelled_at is null and a.end_time>statement_timestamp()
 and strpos(lower(a.item),lower(btrim(coalesce(p_search,''))))>0
 and khub_bot.direct_trade_visible(a.seller_id,false)
 order by case when p_sort='ending' then a.end_time end,
 case when p_sort='activity' then a.latest_bid_at end desc nulls last,
 case when p_sort='newest' then a.created_at end desc,a.created_at desc,a.id
 limit 25 offset (p_page-1)*24
 ) select coalesce(jsonb_agg(khub_bot.barter_card(listing) order by
 case when p_sort='ending' then (listing).end_time end,
 case when p_sort='activity' then (listing).latest_bid_at end desc nulls last,
 case when p_sort='newest' then (listing).created_at end desc,(listing).created_at desc,(listing).id),'[]'),count(*)>24 into rows,more from pool;
 return jsonb_build_object('rows',rows-24,'more',more);
end; $$;

create function public.read_barter_detail(p_id uuid,p_history_page integer default 1,p_private_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a khub_bot.barter_auctions%rowtype; result jsonb; history jsonb; offers jsonb; host boolean; viewer public.profiles%rowtype; allowed boolean;
begin
 if p_history_page is null or p_private_page is null or p_history_page not between 1 and 10000 or p_private_page not between 1 and 10000 then raise exception 'Invalid page.'; end if;
 select * into a from khub_bot.barter_auctions where id=p_id;
 if not found or not khub_bot.direct_trade_visible(a.seller_id,false) then return null; end if;
 select * into viewer from public.profiles where id=auth.uid();
 allowed:=viewer.id is not null and not coalesce(viewer.is_banned,true) and not khub_bot.account_is_banned(viewer.kol_player_id,viewer.khub_username,viewer.kol_player_name);
 host:=a.seller_id=auth.uid() and allowed;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'value',o.value,'meat',o.meat,'items',o.items,'acceptedAt',o.accepted_at) order by o.accepted_at desc,o.id),'[]') into history
 from (select * from khub_bot.barter_offers where auction_id=a.id and accepted_at is not null order by accepted_at desc,id limit 21 offset (p_history_page-1)*20) o;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'value',o.value,'meat',o.meat,'items',o.items,'status',o.status,
 'rejectedItems',o.rejected_items,'createdAt',o.created_at,'bidder',b.khub_username,'bidderKolId',b.kol_player_id) order by o.created_at desc,o.id),'[]') into offers
 from (select * from khub_bot.barter_offers where auction_id=a.id and (host or bidder_id=auth.uid()) and allowed
 order by (status='pending') desc,created_at desc,id limit 21 offset (p_private_page-1)*20) o join public.profiles b on b.id=o.bidder_id;
 result:=khub_bot.barter_card(a)||jsonb_build_object('history',history,'offers',offers,'isHost',coalesce(host,false),
 'host',case when allowed then (select khub_username from public.profiles where id=a.seller_id) else 'Host' end,
 'winningOffer',case when allowed and a.end_time<=statement_timestamp() and (host or (select bidder_id=auth.uid() from khub_bot.barter_offers where id=a.current_offer_id)) then
 (select jsonb_build_object('meat',o.meat,'items',o.items,'bidder',b.khub_username,'bidderKolId',b.kol_player_id) from khub_bot.barter_offers o join public.profiles b on b.id=o.bidder_id where o.id=a.current_offer_id) else null end,
 'hostKolId',case when allowed then (select kol_player_id from public.profiles where id=a.seller_id) else null end);
 return result;
end; $$;
create function public.read_barter_pending() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p public.profiles%rowtype;
begin
 select * into p from public.profiles where id=auth.uid();
 if not found or p.is_banned or khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name) then return '[]'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'item',q.item,'count',q.n)) from (
 select a.id,a.item,count(o.id) n from khub_bot.barter_auctions a join khub_bot.barter_offers o on o.auction_id=a.id and o.status='pending'
 where a.seller_id=p.id and a.end_time>statement_timestamp() and a.cancelled_at is null group by a.id order by a.end_time,a.id limit 20) q),'[]');
end; $$;

revoke all on function khub_bot.barter_quote(integer,bigint),khub_bot.barter_card(khub_bot.barter_auctions) from public,anon,authenticated;
revoke all on function public.create_barter_auction(integer,bigint,bigint,integer,timestamptz,uuid),public.submit_barter_offer(uuid,bigint,jsonb,uuid),public.review_barter_offer(uuid,text,integer[]),public.withdraw_barter_offer(uuid),public.read_barter_auctions(text,text,integer),public.read_barter_detail(uuid,integer,integer),public.read_barter_pending() from public,anon,authenticated;
grant execute on function public.read_barter_auctions(text,text,integer),public.read_barter_detail(uuid,integer,integer) to anon,authenticated;
grant execute on function public.create_barter_auction(integer,bigint,bigint,integer,timestamptz,uuid),public.submit_barter_offer(uuid,bigint,jsonb,uuid),public.review_barter_offer(uuid,text,integer[]),public.withdraw_barter_offer(uuid),public.read_barter_pending() to authenticated;
notify pgrst, 'reload schema';
commit;
