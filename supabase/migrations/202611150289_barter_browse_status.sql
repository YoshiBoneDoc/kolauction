-- Apply after 288, then deploy the website. No settlement/accounting changes.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';
drop function public.read_barter_auctions(text,text,integer);
create function public.read_barter_auctions(p_search text default '',p_sort text default 'ending',p_page integer default 1,p_status text default 'active') returns jsonb
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
 when (listing).current_offer_id is not null then 'awaiting_trade' else 'expired' end,
 'cancelledAt', (listing).cancelled_at)
 order by case when p_sort='ending' then (listing).end_time end,
 case when p_sort='ended-desc' then coalesce((listing).cancelled_at,(listing).end_time) end desc,
 case when p_sort='activity' then (listing).latest_bid_at end desc nulls last,
 case when p_sort='newest' then (listing).created_at end desc,(listing).created_at desc,(listing).id),'[]'),count(*)>24 into rows,more from pool;
 return jsonb_build_object('rows',rows-24,'more',more);
end; $$;
revoke all on function public.read_barter_auctions(text,text,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.read_barter_auctions(text,text,integer,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
