-- Run after 202610190004_kmail_escrow.sql. Read-only RPC; existing RLS applies.
begin;

create function public.read_auction_page(
    p_view text default 'browse', p_id uuid default null,
    p_search text default '', p_status text default 'active',
    p_sort text default 'ending', p_page integer default 1
) returns jsonb language sql stable security invoker set search_path = '' as $$
with matching as materialized (
    select a.*,
        (select count(*) from public.bids b where b.auction_id=a.id) as bid_count
    from public.auctions a
    where
        (p_view='detail' and a.id=p_id)
        or (p_view='profile' and auth.uid() is not null and (
            a.seller_id=auth.uid() or a.winner_id=auth.uid()
            or exists(select 1 from public.bids b where b.auction_id=a.id and b.bidder_id=auth.uid())
        ))
        or (p_view in ('home','browse')
            and strpos(lower(a.item),lower(btrim(coalesce(p_search,''))))>0
            and case when p_view='home' then a.status='active' and a.end_time>statement_timestamp()
                when p_status='all' then true
                when p_status='ended' then a.status<>'pending_escrow'
                    and (a.status<>'active' or a.end_time<=statement_timestamp())
                when p_status='completed' then a.status='completed'
                else a.status='active' and a.end_time>statement_timestamp() end)
), page as materialized (
    select m.* from matching m
    order by
        case when p_view='home' then m.bid_count end desc,
        case when p_view='home' or p_sort='ending' then m.end_time end asc,
        case when p_sort='newest' then m.created_at end desc,
        case when p_sort='price-asc' then coalesce(m.final_price,nullif(m.current_bid,0),m.min_bid_meat) end asc,
        case when p_sort='price-desc' then coalesce(m.final_price,nullif(m.current_bid,0),m.min_bid_meat) end desc,
        m.created_at desc,m.id asc
    limit case when p_view='home' then 4 when p_view='browse' then 24 else null end
    offset case when p_view='browse' then (greatest(1,least(coalesce(p_page,1),1000000))-1)*24 else 0 end
)
select jsonb_build_object(
    'rows',coalesce((select jsonb_agg(to_jsonb(p)) from page p),'[]'::jsonb),
    'total',(select count(*) from matching),
    'bids',coalesce((select jsonb_agg(to_jsonb(b) order by b.amount,b.id)
        from public.bids b where b.auction_id in (select id from page)
        and (p_view='detail' or (p_view='profile' and b.bidder_id=auth.uid()))),'[]'::jsonb)
);
$$;
revoke all on function public.read_auction_page(text,uuid,text,text,text,integer) from public;
grant execute on function public.read_auction_page(text,uuid,text,text,text,integer) to anon,authenticated;
notify pgrst,'reload schema';
commit;
