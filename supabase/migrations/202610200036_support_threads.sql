-- Apply after 035, before deploying the grouped administrator inbox.
-- Existing reports, rating counts and delivery queues are preserved.
begin;

create function public.read_support_threads(p_category text default 'all',p_status text default 'open',p_page integer default 1)
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
        select r.*,coalesce(t.auction_id,q.auction_id) as auction_id,
            coalesce(t.auction_id,q.auction_id,r.id) as thread_id,
            (t.auction_id is not null or q.auction_id is not null) as is_trade
        from khub_bot.bug_reports r
        left join khub_bot.trade_reports t on t.report_id=r.id
        left join khub_bot.trade_queries q on q.report_id=r.id
    ), grouped as (
        select thread_id,is_trade,max(created_at) as updated_at,max(report_number) as latest_number,
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
                'seller',jsonb_build_object('name',coalesce(s.khub_username,a.seller_username),'player_id',s.kol_player_id,'confirmed_at',a.seller_confirmed_at),
                'buyer',jsonb_build_object('name',coalesce(b.khub_username,a.winner_username),'player_id',b.kol_player_id,'confirmed_at',a.buyer_confirmed_at)
            ) end,
            'messages',(select jsonb_agg(jsonb_build_object(
                'id',r.id,'reference','B-'||r.report_number,'category',r.category,'body',r.body,
                'status',r.status,'resolution_kind',r.resolution_kind,'created_at',r.created_at,
                'reporter_username',r.reporter_username,'reporter_kol_id',r.reporter_kol_id,
                'reporter_role',coalesce(t.reporter_role,case when r.reporter_id=a.seller_id then 'seller' when r.reporter_id=a.winner_id then 'buyer' end),
                'message_type',case when t.report_id is not null then 'trade_rating' when q.report_id is not null then 'trade_query' else 'general' end,
                'negative_counted',t.counts_negative,'feedback_withdrawn',t.withdrawn_at is not null,
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

create function public.update_support_thread(p_thread_id uuid,p_is_trade boolean,p_status text default null,p_category text default null)
returns void language plpgsql security definer set search_path='' as $$
declare r khub_bot.bug_reports%rowtype; found_thread boolean:=false;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_thread_id is null or p_is_trade is null or (p_status is null)=(p_category is null) then
        raise exception 'Choose one inbox update.';
    end if;
    if p_status is not null and p_status not in ('open','resolved') then raise exception 'Choose a valid report status.'; end if;
    if p_category is not null and p_category not in ('bug','trade','appeal','other') then raise exception 'Choose a valid inbox category.'; end if;
    -- Match the submission/withdrawal lock order; resolving a thread never
    -- partially resolves its messages or races a new message for that auction.
    perform pg_advisory_xact_lock(3888760);
    if p_is_trade then perform 1 from public.auctions where id=p_thread_id for update; end if;
    for r in select br.* from khub_bot.bug_reports br where
        (p_is_trade and (exists(select 1 from khub_bot.trade_reports t where t.report_id=br.id and t.auction_id=p_thread_id)
            or exists(select 1 from khub_bot.trade_queries q where q.report_id=br.id and q.auction_id=p_thread_id)))
        or (not p_is_trade and br.id=p_thread_id
            and not exists(select 1 from khub_bot.trade_reports t where t.report_id=br.id)
            and not exists(select 1 from khub_bot.trade_queries q where q.report_id=br.id))
        order by br.id for update
    loop
        found_thread:=true;
        if p_category is not null then
            perform public.set_support_category(r.id,p_category);
        elsif r.resolution_kind is distinct from 'participant_resolved' then
            -- Preserve author withdrawals and their resolution attribution.
            perform public.set_bug_report_status(r.id,p_status);
        end if;
    end loop;
    if not found_thread then raise exception 'Conversation not found.'; end if;
end; $$;

revoke all on function public.read_support_threads(text,text,integer),public.update_support_thread(uuid,boolean,text,text) from public,anon,authenticated;
grant execute on function public.read_support_threads(text,text,integer),public.update_support_thread(uuid,boolean,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
