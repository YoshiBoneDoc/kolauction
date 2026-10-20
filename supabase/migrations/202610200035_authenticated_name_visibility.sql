-- Apply after 034. Browsing remains available; account names require a signed-in, unrestricted viewer.
begin;
create function khub_bot.can_view_usernames() returns boolean
language sql stable security definer set search_path='' as $$
    select exists(select 1 from public.profiles p join auth.users u on u.id=p.id where p.id=auth.uid()
        and not p.is_banned and (u.banned_until is null or u.banned_until<=now())
        and not khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name));
$$;
revoke all on function khub_bot.can_view_usernames() from public,anon,authenticated;

create or replace function khub_bot.is_administrator(p_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
    select exists(select 1 from public.profiles p where p.id=p_user
        and p.kol_verified_at is not null and p.kol_player_id is not null
        and exists(select 1 from auth.users u where u.id=p.id and (u.banned_until is null or u.banned_until<=now()))
        and not p.is_banned and not khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name)
        and (p.kol_player_id=3552305 or exists(select 1 from khub_bot.administrators a where a.user_id=p.id)));
$$;
create or replace function khub_bot.public_auction(
    a public.auctions, p_bid_count bigint, p_highest_label text, p_winner_label text
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
    viewer uuid := auth.uid();
    show_names boolean := khub_bot.can_view_usernames();
    participant boolean := not a.escrow_mode and a.finalized_at is not null
        and a.status in ('awaiting_trade','completed') and a.winner_id is not null
        and (viewer=a.seller_id or viewer=a.winner_id);
    reveal boolean := participant and show_names;
    public_winner boolean := show_names and a.finalized_at is not null and a.winner_id is not null
        and a.status in ('awaiting_trade','settling','completed');
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
        'usernames_visible',show_names,
        'id',a.id,'auction_number',a.auction_number,'seller_id',a.seller_id,
        'seller_username',case when show_names then coalesce((select khub_username from public.profiles where id=a.seller_id),a.seller_username) else 'Seller' end,
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
        'winner_public',public_winner,
        'winner_id',case when public_winner or a.winner_id=viewer or reveal then a.winner_id end,
        'winner_username',case when a.winner_id is null then null when not show_names then 'Winner'
            when public_winner then coalesce((select khub_username from public.profiles where id=a.winner_id),a.winner_username)
            when reveal then a.winner_username
            when a.winner_id=viewer then 'You' else coalesce(p_winner_label,'Anonymous bidder') end,
        'final_price',a.final_price,'finalized_at',a.finalized_at,
        'seller_confirmed_at',a.seller_confirmed_at,'buyer_confirmed_at',a.buyer_confirmed_at,
        'own_trade_report',case when participant then (select 'B-'||b.report_number from khub_bot.trade_reports t join khub_bot.bug_reports b on b.id=t.report_id where t.auction_id=a.id and t.reporter_id=viewer) end,
        'own_trade_report_withdrawn',case when participant then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_id=viewer and t.withdrawn_at is not null) end,
        'trade_reported',case when participant then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.withdrawn_at is null) end,
        'completed_at',a.completed_at,'cancelled_at',a.cancelled_at,'settlement_contacts',contacts
    );
end; $$;
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
    select p.id,case when khub_bot.can_view_usernames() then p.khub_username else 'Player profile' end as username,
        khub_bot.can_view_usernames() as usernames_visible,
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
        ) || khub_bot.profile_feedback(p.id) as stats
    from public.profiles p left join seller_lots a on a.seller_id=p.id
    where p_view='seller' and p.id=p_id and (exists(select 1 from seller_lots)
        or exists(select 1 from public.auctions w where w.winner_id=p.id and w.finalized_at is not null
            and w.status in ('awaiting_trade','settling','completed')))
    group by p.id,p.khub_username
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
create or replace function public.khub_wall_of_shame(p_offset integer default 0,p_limit integer default 24)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if p_offset is null or p_offset<0 or p_offset>100000
       or p_limit is null or p_limit<1 or p_limit>48 then
        raise exception 'Invalid gallery page.';
    end if;
    with published as (
        select p.id,case when khub_bot.can_view_usernames() then p.kol_player_name else 'Banned player' end as kol_player_name,
            case when khub_bot.can_view_usernames() then b.kol_player_id end as kol_player_id,
            case when khub_bot.can_view_usernames() then p.public_reason else 'Log in with an unrestricted account to view this reviewed ban.' end as public_reason,p.banned_at,p.expires_at
        from khub_bot.ban_publications p join khub_bot.account_bans b on b.id=p.ban_id
        where b.active and b.kol_player_id is not null and p.published_at<=now()
            and (p.expires_at is null or p.expires_at>now())
    ), page as (
        select * from published order by banned_at desc,id limit p_limit offset p_offset
    )
    select jsonb_build_object('usernames_visible',khub_bot.can_view_usernames(),'total',(select count(*) from published),
        'entries',coalesce((select jsonb_agg(to_jsonb(page) order by banned_at desc,id) from page),'[]'::jsonb)) into result;
    return result;
end; $$;
notify pgrst,'reload schema';
commit;
