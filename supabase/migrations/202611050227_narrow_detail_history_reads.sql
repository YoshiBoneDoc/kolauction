-- Apply after 226. Read-only optimization; preserve visibility, names and history cursors.
begin;
set local lock_timeout='2s';
do $$ declare source text; anchor text; f record; begin
 source:=pg_get_functiondef('public.read_auction_bid_history(uuid,bigint,uuid,bigint)'::regprocedure);
 anchor:='select public.read_auction_viewer_context(p_id=>p_id) as context';
 if strpos(source,anchor)=0 then raise exception 'Unexpected history authorization'; end if;
 execute replace(source,anchor,$narrow$
 select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',a.id)),'[]'::jsonb)) as context
 from public.auctions a where a.id=p_id
 and khub_bot.direct_trade_visible(a.seller_id,a.escrow_mode)
 and (not khub_bot.is_abandoned_escrow_draft(a) or khub_bot.is_administrator(auth.uid()))
 and (a.status<>'pending_escrow' or a.seller_id=auth.uid() or khub_bot.is_administrator(auth.uid()))
 $narrow$);
 -- Delay activity subqueries until after pagination unless activity orders the page.
 -- Apply only to definitions which still have the unbounded expression.
 anchor:='greatest((select max(b.created_at) from public.bids b where b.auction_id=a.id),(select max(f.created_at) from khub_bot.buy_fulfillments f where f.auction_id=a.id)) as latest_bid_at';
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('read_auction_page','read_auction_detail_static','read_auction_viewer_context')
 loop
  source:=pg_get_functiondef(f.oid);
  if strpos(source,anchor)>0 then
   if strpos(source,'''latest_bid_at'',p.latest_bid_at')=0 then raise exception 'Unexpected activity projection: %',f.oid::regprocedure; end if;
   source:=replace(source,anchor,'case when p_sort=''activity'' then greatest((select max(b.created_at) from public.bids b where b.auction_id=a.id),(select max(f.created_at) from khub_bot.buy_fulfillments f where f.auction_id=a.id)) end as latest_bid_at');
   source:=replace(source,'''latest_bid_at'',p.latest_bid_at','''latest_bid_at'',coalesce(p.latest_bid_at,greatest((select max(b.created_at) from public.bids b where b.auction_id=a.id),(select max(f.created_at) from khub_bot.buy_fulfillments f where f.auction_id=a.id)))');
   execute source;
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
