-- Host-only revision follow-up, independent of the pending review queue.
begin;
create function public.read_barter_revisions(p_id uuid,p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a khub_bot.barter_auctions%rowtype; viewer public.profiles%rowtype; allowed boolean; host boolean; offers jsonb;
begin
 if p_page is null or p_page not between 1 and 10000 then raise exception 'Invalid page.'; end if;
 select * into a from khub_bot.barter_auctions where id=p_id;
 if not found or not khub_bot.direct_trade_visible(a.seller_id,false) then raise exception 'Barter unavailable.'; end if;
 select * into viewer from public.profiles where id=auth.uid();
 allowed:=viewer.id is not null and not coalesce(viewer.is_banned,true) and not khub_bot.account_is_banned(viewer.kol_player_id,viewer.khub_username,viewer.kol_player_name);
 host:=a.seller_id=auth.uid() and allowed;
 if not coalesce(host,false) then raise exception 'Host required.'; end if;
 with bidder_labels as materialized (select bidder_id,row_number() over(order by min(created_at),bidder_id) n from khub_bot.barter_offers where auction_id=a.id group by bidder_id)
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'value',o.value,'meat',o.meat,'items',(select coalesce(jsonb_agg(x || jsonb_build_object('image','https://images.kingdomofloathing.com/'||case when strpos(c.image,'/')>0 then c.image else 'itemimages/'||c.image end) order by ord),'[]'::jsonb) from jsonb_array_elements(o.items) with ordinality as entries(x,ord) left join khub_bot.catalog c on c.id=(x->>'id')::integer),'status',o.status,
 'bidderLabel','Bidder '||l.n,'raiseRequested',o.raise_requested,'rejectedItems',o.rejected_items,'createdAt',o.created_at,'bidder',case when khub_bot.is_administrator(auth.uid()) then b.khub_username else null end,'bidderKolId',case when khub_bot.is_administrator(auth.uid()) then b.kol_player_id else null end) order by o.created_at desc,o.id),'[]') into offers
 from (select * from khub_bot.barter_offers where auction_id=a.id and (status='changes_requested' or (status='withdrawn' and (raise_requested or cardinality(rejected_items)>0))) order by created_at desc,id limit 21 offset (p_page-1)*20) o join public.profiles b on b.id=o.bidder_id join bidder_labels l on l.bidder_id=o.bidder_id;
 return offers;
end; $$;
revoke all on function public.read_barter_revisions(uuid,integer) from public,anon;
grant execute on function public.read_barter_revisions(uuid,integer) to authenticated;
notify pgrst,'reload schema';
commit;
