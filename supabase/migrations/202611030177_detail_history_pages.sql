-- After 176. Preserve legacy readers for open clients; new readers separate
-- identity context/static data from bounded, keyset-paginated history.
begin;
set local lock_timeout='2s';
-- Existing UNIQUE(auction_id,amount) supports backward keyset scans; no
-- redundant write-heavy history index is needed.
do $patch$
declare d text; original_body text; point_body text; history text; start_at integer; end_at integer; target text;
begin
 foreach target in array array['read_auction_detail_context','read_auction_page'] loop
 d:=pg_get_functiondef(('public.'||target||'(text,uuid,text,text,text,integer)')::regprocedure);
 start_at:=strpos(d,'''bids'',coalesce((select jsonb_agg(');
 end_at:=strpos(substring(d from start_at),'''seller'',');
 if start_at=0 or end_at=0 then raise exception 'Unexpected detail history layout: %',target; end if;
 if target='read_auction_page' then
    history:=substring(d from start_at+length('''bids'',coalesce((select jsonb_agg('));
    end_at:=strpos(history,' order by b.amount,b.id)');
    if end_at=0 then raise exception 'Unexpected bid projection'; end if;
    history:=replace(substring(history for end_at-1),'p_view',quote_literal('detail'));
    -- The extracted projection preserves admin references and giveaway winners.
    execute $sql$create function public.read_auction_bid_history(p_id uuid,p_before_amount bigint default null,p_before_id uuid default null,p_known_revision bigint default null)
    returns jsonb language sql stable security definer set search_path='' as $body$
    with authorized as materialized (
        select public.read_auction_viewer_context(p_id=>p_id) as context
    ), version as materialized (
        select case when a.status='active' then a.display_bid_revision end as display_bid_revision from public.auctions a where a.id=p_id
        and exists(select 1 from authorized,jsonb_array_elements(context->'rows') r where r->>'id'=p_id::text)
    ), recent as materialized (
        select b.* from public.bids b where b.auction_id=p_id
        and exists(select 1 from authorized,jsonb_array_elements(context->'rows') r where r->>'id'=p_id::text)
        and (p_known_revision is null or p_known_revision is distinct from (select display_bid_revision from version) or khub_bot.is_administrator(auth.uid()))
        and (p_before_amount is null or (b.amount,b.id)<(p_before_amount,p_before_id))
        order by b.amount desc,b.id desc limit 51
    ), labels as not materialized (
        select auction_id,bidder_id,'Bidder '||ordinal::text as label from khub_bot.auction_bidder_labels where auction_id=p_id
    ) select jsonb_build_object('privacy_version',1,'revision',(select display_bid_revision::text from version),
    'unchanged',coalesce(p_known_revision=(select display_bid_revision from version),false) and not khub_bot.is_administrator(auth.uid()),'visible',exists(select 1 from authorized,jsonb_array_elements(context->'rows') r where r->>'id'=p_id::text),'has_more',(select count(*)>50 from recent),
    'next_cursor',(select jsonb_build_object('amount',amount::text,'id',id) from recent order by amount desc,id desc offset 49 limit 1),
    'bids',coalesce((select jsonb_agg($sql$||history||$sql$ order by b.amount,b.id)
        from (select * from recent order by amount desc,id desc limit 50) b
        join labels l using(auction_id,bidder_id)),'[]'::jsonb));
    $body$ $sql$;
 end if;
 -- Find the complete bids field again after extracting its projection.
 start_at:=strpos(d,'''bids'',coalesce((select jsonb_agg(');
 end_at:=strpos(substring(d from start_at),'''seller'',');
 d:=substring(d for start_at-1)||'''bids'',''[]''::jsonb,'||substring(d from start_at+end_at-1);
 if target='read_auction_detail_context' then
    d:=replace(d,'''id'',a.id,','''id'',a.id,''current_bid'',a.current_bid,');
 end if;
 d:=replace(d,'FUNCTION public.'||target||'(', 'FUNCTION public.'||case when target='read_auction_page' then 'read_auction_detail_static' else 'read_auction_viewer_context' end||'(');
 execute d;
 -- These new RPCs are detail-only. Filter by UUID before evaluating visibility:
 -- SECURITY DEFINER SETOF visible_auctions() cannot be inlined/pushed down and
 -- otherwise materializes the whole market even for a single auction lookup.
 target:=case when target='read_auction_page' then 'read_auction_detail_static' else 'read_auction_viewer_context' end;
 select prosrc into original_body from pg_proc where oid=('public.'||target||'(text,uuid,text,text,text,integer)')::regprocedure;
 if strpos(original_body,'from khub_bot.visible_auctions() a')=0 then raise exception 'Unexpected detail visibility source'; end if;
 point_body:=replace(replace(original_body,'p_view',quote_literal('detail')),
   'from khub_bot.visible_auctions() a',
   'from (select * from public.auctions point_auction where point_auction.id=p_id and khub_bot.direct_trade_visible(point_auction.seller_id,point_auction.escrow_mode)) a');
 d:=pg_get_functiondef(('public.'||target||'(text,uuid,text,text,text,integer)')::regprocedure);
 execute replace(d,original_body,point_body);
 end loop;
end;$patch$;
revoke all on function public.read_auction_detail_static(text,uuid,text,text,text,integer),public.read_auction_viewer_context(text,uuid,text,text,text,integer),public.read_auction_bid_history(uuid,bigint,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.read_auction_detail_static(text,uuid,text,text,text,integer),public.read_auction_viewer_context(text,uuid,text,text,text,integer),public.read_auction_bid_history(uuid,bigint,uuid,bigint) to anon,authenticated;
notify pgrst,'reload schema';
commit;
