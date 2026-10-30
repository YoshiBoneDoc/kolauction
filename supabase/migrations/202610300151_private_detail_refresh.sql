-- Apply after 150. Reuse the installed reader's visibility and bid-label rules.
begin;
do $patch$
declare body text; anchor text := 'khub_bot.public_auction(a,p.bid_count,h.label,w.label)';
begin
    select prosrc into body from pg_proc where oid='public.read_auction_page(text,uuid,text,text,text,integer)'::regprocedure;
    if strpos(body,anchor)=0 then raise exception 'Unexpected detail reader projection'; end if;
    -- Keep the installed visibility filters, bid aliases and administrator bid
    -- references, but never invoke the full auction projection for this read.
    body:=replace(body,'p_view',quote_literal('detail'));
    body:=replace(body,anchor,$projection$jsonb_build_object(
        'id',a.id,
        '_detail_full_required',a.status<>'active' or a.auction_kind='buy',
        'usernames_visible',khub_bot.can_view_usernames() or khub_bot.is_administrator(auth.uid()),
        'seller_username',case when khub_bot.can_view_usernames() or khub_bot.is_administrator(auth.uid())
            then coalesce((select khub_username from public.profiles where id=a.seller_id),a.seller_username) else 'Seller' end,
        'highest_bidder_id',case when a.highest_bidder_id=auth.uid() or khub_bot.is_administrator(auth.uid()) then a.highest_bidder_id end,
        'highest_bidder_username',case when a.highest_bidder_id is null then null
            when khub_bot.is_administrator(auth.uid()) then coalesce((select khub_username from public.profiles where id=a.highest_bidder_id),a.highest_bidder_username)
            when a.highest_bidder_id=auth.uid() then 'You' else coalesce(h.label,'Anonymous bidder') end,
        'viewer_is_highest_bidder',case when a.highest_bidder_id is null then null else auth.uid() is not null and a.highest_bidder_id=auth.uid() end,
        'bidding_restricted',a.status='active' and khub_bot.profile_is_restricted(a.seller_id),
        'escrow_timing_review',a.escrow_timing_review
    )$projection$);
    -- Bid history already supplies the count; the public live snapshot owns it.
    body:=replace(body,'(select count(*) from public.bids b where b.auction_id=a.id) as bid_count','0::bigint as bid_count');
    execute 'create function public.read_auction_detail_context(p_view text default ''detail'',p_id uuid default null,p_search text default '''',p_status text default ''active'',p_sort text default ''ending'',p_page integer default 1) returns jsonb language sql stable security definer set search_path='''' as '||quote_literal(body);
end; $patch$;
revoke all on function public.read_auction_detail_context(text,uuid,text,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_auction_detail_context(text,uuid,text,text,text,integer) to anon,authenticated;
notify pgrst,'reload schema';
commit;
