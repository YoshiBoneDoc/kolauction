-- Apply after 022, then deploy the matching website. No auction/escrow state changes.
begin;

-- Browser reads must use the projection below, not raw identities on these tables.
revoke select on public.auctions, public.bids from public, anon, authenticated;

create function khub_bot.public_auction(
    a public.auctions, p_bid_count bigint, p_highest_label text, p_winner_label text
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
    viewer uuid := auth.uid();
    reveal boolean := not a.escrow_mode and a.finalized_at is not null
        and a.status in ('awaiting_trade','completed') and a.winner_id is not null
        and (viewer=a.seller_id or viewer=a.winner_id);
    contacts jsonb;
begin
    if reveal then
        select jsonb_build_object(
            'seller',jsonb_build_object('username',s.khub_username,
                'kol_name',case when s.kol_verified_at is not null then s.kol_player_name end,
                'kol_player_id',case when s.kol_verified_at is not null then s.kol_player_id end),
            'buyer',jsonb_build_object('username',b.khub_username,
                'kol_name',case when b.kol_verified_at is not null then b.kol_player_name end,
                'kol_player_id',case when b.kol_verified_at is not null then b.kol_player_id end)
        ) into contacts from public.profiles s,public.profiles b
        where s.id=a.seller_id and b.id=a.winner_id;
    end if;
    -- Explicit fields prevent future private columns from becoming public by default.
    return jsonb_build_object(
        'id',a.id,'auction_number',a.auction_number,'seller_id',a.seller_id,
        'seller_username',coalesce((select khub_username from public.profiles where id=a.seller_id),a.seller_username),
        'item',a.item,'item_id',a.item_id,'quantity',a.quantity,'image',a.image,
        'min_bid_meat',a.min_bid_meat,'current_bid',a.current_bid,'bid_count',p_bid_count,
        'duration_hours',a.duration_hours,'created_at',a.created_at,'end_time',a.end_time,'status',a.status,
        'escrow_mode',a.escrow_mode,'start_on_deposit',a.start_on_deposit,
        'item_escrowed_at',a.item_escrowed_at,'settled_at',a.settled_at,
        'settlement_outcome',a.settlement_outcome,'fee_bps',a.fee_bps,'fee_meat',a.fee_meat,
        'instant_purchase_price',a.instant_purchase_price,'instant_purchased_at',a.instant_purchased_at,
        'has_winner',a.winner_id is not null,
        'highest_bidder_id',case when a.highest_bidder_id=viewer or reveal then a.highest_bidder_id end,
        'highest_bidder_username',case when a.highest_bidder_id is null then null
            when reveal then a.highest_bidder_username when a.highest_bidder_id=viewer then 'You'
            else coalesce(p_highest_label,'Anonymous bidder') end,
        'winner_id',case when a.winner_id=viewer or reveal then a.winner_id end,
        'winner_username',case when a.winner_id is null then null when reveal then a.winner_username
            when a.winner_id=viewer then 'You' else coalesce(p_winner_label,'Anonymous bidder') end,
        'final_price',a.final_price,'finalized_at',a.finalized_at,
        'seller_confirmed_at',a.seller_confirmed_at,'buyer_confirmed_at',a.buyer_confirmed_at,
        'completed_at',a.completed_at,'cancelled_at',a.cancelled_at,'settlement_contacts',contacts
    );
end; $$;
revoke all on function khub_bot.public_auction(public.auctions,bigint,text,text) from public,anon,authenticated;

create or replace function public.read_auction_page(
    p_view text default 'browse', p_id uuid default null,
    p_search text default '', p_status text default 'active',
    p_sort text default 'ending', p_page integer default 1
) returns jsonb language sql stable security definer set search_path='' as $$
with matching as materialized (
    select a.*, (select count(*) from public.bids b where b.auction_id=a.id) as bid_count
    from public.auctions a
    where (a.status<>'pending_escrow' or a.seller_id=auth.uid()) and (
        (p_view='detail' and a.id=p_id)
        or (p_view='profile' and auth.uid() is not null and (
            a.seller_id=auth.uid() or a.winner_id=auth.uid()
            or exists(select 1 from public.bids b where b.auction_id=a.id and b.bidder_id=auth.uid())))
        or (p_view in ('home','browse','seller')
            and (p_view<>'seller' or (a.seller_id=p_id and a.status<>'pending_escrow'))
            and strpos(lower(a.item),lower(btrim(coalesce(p_search,''))))>0
            and case when p_view='home' then a.status='active' and a.end_time>statement_timestamp()
                when p_status='all' then true
                when p_status='ended' then a.status<>'pending_escrow'
                    and (a.status<>'active' or a.end_time<=statement_timestamp())
                when p_status='completed' then a.status='completed'
                else a.status='active' and a.end_time>statement_timestamp() end)
    )
), page as materialized (
    select m.* from matching m order by
        case when p_view='home' then m.bid_count end desc,
        case when p_view='home' or p_sort='ending' then m.end_time end asc,
        case when p_sort='newest' then m.created_at end desc,
        case when p_sort='price-asc' then coalesce(m.final_price,nullif(m.current_bid,0),m.min_bid_meat) end asc,
        case when p_sort='price-desc' then coalesce(m.final_price,nullif(m.current_bid,0),m.min_bid_meat) end desc,
        m.created_at desc,m.id asc
    limit case when p_view='home' then 4 when p_view in ('browse','seller') then 24 else null end
    offset case when p_view in ('browse','seller') then (greatest(1,least(coalesce(p_page,1),1000000))-1)*24 else 0 end
), labels as materialized (
    -- The same person keeps an alias within this auction only. No account UUID
    -- or deterministic hash can be used to correlate bidders between auctions.
    select b.auction_id,b.bidder_id,
        'Bidder '||row_number() over(partition by b.auction_id order by min(b.created_at),b.bidder_id)::text as label
    from public.bids b where b.auction_id in (select id from page) group by b.auction_id,b.bidder_id
), seller_lots as materialized (
    select a.* from public.auctions a where p_view='seller' and a.seller_id=p_id and a.status<>'pending_escrow'
), seller_summary as (
    select p.id,p.khub_username as username,
        jsonb_build_object(
            'active',count(*) filter(where a.status='active' and a.end_time>statement_timestamp()),
            'pending',count(*) filter(where a.status in ('settling','awaiting_trade')),
            'unsold',count(*) filter(where a.status='ended_no_bids'),
            'cancelled',count(*) filter(where a.status='cancelled'),
            'escrow_sales',count(*) filter(where a.status='completed' and a.escrow_mode and a.winner_id is not null),
            'escrow_value',coalesce(sum(a.final_price) filter(where a.status='completed' and a.escrow_mode and a.winner_id is not null),0)::text,
            'escrow_units',coalesce(sum(a.quantity) filter(where a.status='completed' and a.escrow_mode and a.winner_id is not null),0)::text,
            'legacy_sales',count(*) filter(where a.status='completed' and not a.escrow_mode and a.winner_id is not null),
            'legacy_value',coalesce(sum(a.final_price) filter(where a.status='completed' and not a.escrow_mode and a.winner_id is not null),0)::text
        ) as stats
    from public.profiles p join seller_lots a on a.seller_id=p.id where p.id=p_id group by p.id,p.khub_username
)
select jsonb_build_object(
    'privacy_version',1,
    'rows',coalesce((select jsonb_agg(khub_bot.public_auction(a,p.bid_count,h.label,w.label)
        order by p.ordinal) from (select page.*,row_number() over() as ordinal from page) p
        join public.auctions a on a.id=p.id
        left join labels h on h.auction_id=a.id and h.bidder_id=a.highest_bidder_id
        left join labels w on w.auction_id=a.id and w.bidder_id=a.winner_id),'[]'::jsonb),
    'total',(select count(*) from matching),
    'bids',coalesce((select jsonb_agg(jsonb_build_object(
        'id',b.id,'auction_id',b.auction_id,'amount',b.amount,'created_at',b.created_at,
        'bidder_id',case when b.bidder_id=auth.uid() then b.bidder_id end,
        'bidder_username',case when b.bidder_id=auth.uid() then 'You' else l.label end
    ) order by b.amount,b.id) from public.bids b join labels l using(auction_id,bidder_id)
        where p_view='detail' or (p_view='profile' and b.bidder_id=auth.uid())),'[]'::jsonb),
    'seller',(select to_jsonb(s) from seller_summary s)
);
$$;
revoke all on function public.read_auction_page(text,uuid,text,text,text,integer) from public;
grant execute on function public.read_auction_page(text,uuid,text,text,text,integer) to anon,authenticated;

notify pgrst,'reload schema';
commit;
