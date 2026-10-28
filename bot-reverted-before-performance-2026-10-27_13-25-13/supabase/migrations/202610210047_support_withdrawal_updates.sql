-- Apply after 046. Expose durable report-withdrawal events in the administrator conversation.
-- Display history is derived from existing withdrawal records, including reports with no explanation.
-- Preserve old withdrawals that did not confirm completion and keep every mutation unchanged.
begin;
create or replace function public.read_support_threads(p_category text default 'all',p_status text default 'open',p_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_category is null or p_category not in ('all','bug','trade','appeal','other') then
        raise exception 'Choose a valid inbox category.';
    end if;
    if p_status is null or p_status not in ('open','resolved','self_resolved','all') or p_page is null or p_page not between 1 and 1000000 then
        raise exception 'Choose a valid inbox page and status.';
    end if;
    -- Group before filtering/pagination: a trade's history stays together even
    -- when its messages have different categories or resolution states.
    with messages as materialized (
        select r.*,greatest(r.created_at,t.withdrawn_at) as last_activity_at,coalesce(t.auction_id,q.auction_id) as auction_id,
            coalesce(t.auction_id,q.auction_id,r.id) as thread_id,
            (t.auction_id is not null or q.auction_id is not null) as is_trade
        from khub_bot.bug_reports r
        left join khub_bot.trade_reports t on t.report_id=r.id
        left join khub_bot.trade_queries q on q.report_id=r.id
    ), grouped as (
        select thread_id,is_trade,max(last_activity_at) as updated_at,max(report_number) as latest_number,
            bool_or(status='open') as is_open,
            bool_and(status='resolved' and resolution_kind is not distinct from 'participant_resolved') as self_resolved,
            bool_or(p_category='all' or category=p_category) as category_matches
        from messages group by thread_id,is_trade
    ), matching as materialized (
        select * from grouped where category_matches and (p_status='all'
            or (p_status='open' and is_open) or (p_status='resolved' and not is_open)
            or (p_status='self_resolved' and self_resolved))
    ), page as (
        select * from matching order by updated_at desc,latest_number desc limit 20 offset (p_page-1)*20
    )
    select jsonb_build_object('total',(select count(*) from matching),'threads',coalesce((
        select jsonb_agg(jsonb_build_object(
            'id',g.thread_id,'is_trade',g.is_trade,'updated_at',g.updated_at,
            'status',case when g.is_open then 'open' else 'resolved' end,
            'resolution_kind',case when g.self_resolved then 'participant_resolved' when not g.is_open then 'administrator' end,
            'auction',case when a.id is not null then jsonb_build_object(
                'id',a.id,'number',a.auction_number,'item',a.item,'quantity',a.quantity,'image',a.image,
                'price',a.final_price,'escrow',a.escrow_mode,'status',a.status,
                'seller',jsonb_build_object('name',coalesce(s.khub_username,a.seller_username),'player_id',s.kol_player_id,'confirmed_at',a.seller_confirmed_at,'resolved_at',a.seller_resolved_at),
                'buyer',jsonb_build_object('name',coalesce(b.khub_username,a.winner_username),'player_id',b.kol_player_id,'confirmed_at',a.buyer_confirmed_at,'resolved_at',a.buyer_resolved_at)
            ) end,
            'messages',(select jsonb_agg(jsonb_build_object(
                'id',r.id,'reference','B-'||r.report_number,'category',r.category,'body',r.body,
                'status',r.status,'resolution_kind',r.resolution_kind,'created_at',r.created_at,
                'reporter_username',r.reporter_username,'reporter_kol_id',r.reporter_kol_id,
                'reporter_role',coalesce(t.reporter_role,case when r.reporter_id=a.seller_id then 'seller' when r.reporter_id=a.winner_id then 'buyer' end),
                'message_type',case when t.report_id is not null then 'trade_rating' when q.report_id is not null then 'trade_query' else 'general' end,
                'negative_counted',t.counts_negative,'feedback_withdrawn',t.withdrawn_at is not null,
                'withdrawn_at',t.withdrawn_at,
                'withdrawal_confirmed_complete',coalesce(t.withdrawn_at is not null and
                    case t.reporter_role when 'seller' then a.seller_resolved_at else a.buyer_resolved_at end=t.withdrawn_at,false),
                'target_username',case t.reporter_role when 'buyer' then coalesce(s.khub_username,a.seller_username) when 'seller' then coalesce(b.khub_username,a.winner_username) end,
                'rating_reviews',(select coalesce(jsonb_agg(jsonb_build_object(
                    'counted',v.counted,'reason',v.reason,'created_at',v.created_at,'reviewer',p.khub_username
                ) order by v.id),'[]'::jsonb) from khub_bot.trade_rating_reviews v
                    left join public.profiles p on p.id=v.administrator_id where v.report_id=r.id)
            ) order by r.created_at,r.report_number) from messages r
                left join khub_bot.trade_reports t on t.report_id=r.id
                left join khub_bot.trade_queries q on q.report_id=r.id
                where r.thread_id=g.thread_id and r.is_trade=g.is_trade)
        ) order by g.updated_at desc,g.latest_number desc)
        from page g left join public.auctions a on g.is_trade and a.id=g.thread_id
        left join public.profiles s on s.id=a.seller_id
        left join public.profiles b on b.id=a.winner_id
    ),'[]'::jsonb)) into result;
    return result;
end; $$;

notify pgrst,'reload schema';
commit;
