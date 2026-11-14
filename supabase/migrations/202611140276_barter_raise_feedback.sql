-- After 275. Persist raise-value feedback and add stable anonymous reviewer labels.
begin;
alter table khub_bot.barter_offers add column raise_requested boolean not null default false;
create function public.review_barter_offer_changes(p_offer uuid,p_decision text,p_rejected integer[],p_raise boolean) returns void
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; a khub_bot.barter_auctions%rowtype; o khub_bot.barter_offers%rowtype;
begin
 p:=khub_bot.require_verified_trader();
 -- Always lock auction before offer, in the same order as submission.
 select b.* into a from khub_bot.barter_auctions b join khub_bot.barter_offers f on f.auction_id=b.id where f.id=p_offer for update of b;
 if not found then raise exception 'Offer not found.'; end if;
 select * into o from khub_bot.barter_offers where id=p_offer for update;
 if a.seller_id<>p.id then raise exception 'Only the host may review offers.'; end if;
 if p_raise is null or (p_raise and p_decision<>'changes_requested') then raise exception 'Raise feedback is only valid when requesting changes.'; end if;
 if p_decision is null or p_decision not in ('accepted','rejected','changes_requested') then raise exception 'Invalid decision.'; end if;
 -- Duplicate exact decisions are safe; conflicting decisions cannot overwrite evidence.
 if o.status=p_decision and o.rejected_items=coalesce(p_rejected,'{}') and o.raise_requested=p_raise then return; end if;
 if o.status<>'pending' or a.end_time<=clock_timestamp() or a.cancelled_at is not null then raise exception 'This offer is no longer reviewable.'; end if;
 if exists(select 1 from public.profiles b where b.id=o.bidder_id and (b.is_banned or khub_bot.account_is_banned(b.kol_player_id,b.khub_username,b.kol_player_name))) then raise exception 'Bidder is restricted.'; end if;
 if exists(select 1 from public.player_ignores i join public.profiles h on h.id=a.seller_id join public.profiles b on b.id=o.bidder_id
  where (i.user_id=h.id and i.kol_player_id=b.kol_player_id) or (i.user_id=b.id and i.kol_player_id=h.kol_player_id)) then raise exception 'This Direct trade is unavailable.'; end if;
 if p_decision='changes_requested' then
  if coalesce(cardinality(p_rejected),0)=0 and not p_raise then raise exception 'Mark at least one item with an X.'; end if;
  if exists(select 1 from unnest(p_rejected) r where r is null or not exists(select 1 from jsonb_array_elements(o.items) x where (x->>'id')::integer=r)) then raise exception 'Invalid rejected item.'; end if;
 elsif coalesce(cardinality(p_rejected),0)<>0 then raise exception 'Item feedback is only valid when requesting changes.';
 end if;
 update khub_bot.barter_offers set status=p_decision,reviewed_at=clock_timestamp(),rejected_items=coalesce(p_rejected,'{}'),raise_requested=p_raise,
 accepted_at=case when p_decision='accepted' then clock_timestamp() else null end where id=o.id;
 if p_decision='accepted' then update khub_bot.barter_auctions set current_offer_id=o.id where id=a.id; end if;
end; $$;

create or replace function public.review_barter_offer(p_offer uuid,p_decision text,p_rejected integer[] default '{}') returns void
language sql security definer set search_path='' as $$
 select public.review_barter_offer_changes(p_offer,p_decision,p_rejected,false);
$$;
revoke all on function public.review_barter_offer_changes(uuid,text,integer[],boolean) from public,anon,authenticated;
grant execute on function public.review_barter_offer_changes(uuid,text,integer[],boolean) to authenticated;
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
 from (select * from khub_bot.barter_offers where auction_id=a.id and (host or bidder_id=auth.uid()) and allowed
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
