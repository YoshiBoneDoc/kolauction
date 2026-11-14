-- After 279. Return only the latest private bidder offer; retain immutable offer records and public accepted history.
begin;
create or replace function public.read_barter_detail(p_id uuid,p_history_page integer default 1,p_private_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a khub_bot.barter_auctions%rowtype; result jsonb; history jsonb; offers jsonb; host boolean; viewer public.profiles%rowtype; allowed boolean;
begin
 if p_history_page is null or p_private_page is null or p_history_page not between 1 and 10000 or p_private_page not between 1 and 10000 then raise exception 'Invalid page.'; end if;
 select * into a from khub_bot.barter_auctions where id=p_id;
 if not found or not khub_bot.direct_trade_visible(a.seller_id,false) then return null; end if;
 select * into viewer from public.profiles where id=auth.uid();
 allowed:=viewer.id is not null and not coalesce(viewer.is_banned,true) and not khub_bot.account_is_banned(viewer.kol_player_id,viewer.khub_username,viewer.kol_player_name);
 host:=a.seller_id=auth.uid() and allowed;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'value',o.value,'meat',o.meat,'items',(select coalesce(jsonb_agg(x || jsonb_build_object('image','https://images.kingdomofloathing.com/'||case when strpos(c.image,'/')>0 then c.image else 'itemimages/'||c.image end) order by ord),'[]'::jsonb) from jsonb_array_elements(o.items) with ordinality as entries(x,ord) left join khub_bot.catalog c on c.id=(x->>'id')::integer),'acceptedAt',o.accepted_at) order by o.accepted_at desc,o.id),'[]') into history
 from (select * from khub_bot.barter_offers where auction_id=a.id and accepted_at is not null order by accepted_at desc,id limit 21 offset (p_history_page-1)*20) o;
 with bidder_labels as materialized (select bidder_id,row_number() over(order by min(created_at),bidder_id) n from khub_bot.barter_offers where auction_id=a.id group by bidder_id)
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'value',o.value,'meat',o.meat,'items',(select coalesce(jsonb_agg(x || jsonb_build_object('image','https://images.kingdomofloathing.com/'||case when strpos(c.image,'/')>0 then c.image else 'itemimages/'||c.image end) order by ord),'[]'::jsonb) from jsonb_array_elements(o.items) with ordinality as entries(x,ord) left join khub_bot.catalog c on c.id=(x->>'id')::integer),'status',o.status,
 'bidderLabel','Bidder '||l.n,'raiseRequested',o.raise_requested,'rejectedItems',o.rejected_items,'createdAt',o.created_at,'bidder',case when khub_bot.is_administrator(auth.uid()) then b.khub_username else null end,'bidderKolId',case when khub_bot.is_administrator(auth.uid()) then b.kol_player_id else null end) order by o.created_at desc,o.id),'[]') into offers
 from (select * from khub_bot.barter_offers candidate where auction_id=a.id and ((host and status='pending') or (not host and bidder_id=auth.uid() and not exists(select 1 from khub_bot.barter_offers newer where newer.auction_id=candidate.auction_id and newer.bidder_id=candidate.bidder_id and (newer.created_at,newer.id)>(candidate.created_at,candidate.id)))) and allowed
 order by (status='pending') desc,created_at desc,id limit 21 offset (p_private_page-1)*20) o join public.profiles b on b.id=o.bidder_id join bidder_labels l on l.bidder_id=o.bidder_id;
 result:=khub_bot.barter_card(a)||jsonb_build_object('history',history,'offers',offers,'isHost',coalesce(host,false),
 'host',case when allowed then (select khub_username from public.profiles where id=a.seller_id) else 'Host' end,
 'winningOffer',case when allowed and a.end_time<=statement_timestamp() and (host or (select bidder_id=auth.uid() from khub_bot.barter_offers where id=a.current_offer_id)) then
 (select jsonb_build_object('meat',o.meat,'items',o.items,'bidder',b.khub_username,'bidderKolId',b.kol_player_id) from khub_bot.barter_offers o join public.profiles b on b.id=o.bidder_id where o.id=a.current_offer_id) else null end,
 'hostKolId',case when allowed then (select kol_player_id from public.profiles where id=a.seller_id) else null end);
 return result;
end; $$;
notify pgrst,'reload schema';
commit;
