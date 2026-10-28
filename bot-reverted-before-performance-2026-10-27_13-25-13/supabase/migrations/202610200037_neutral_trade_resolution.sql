-- Apply after 036, before deploying the new withdrawal confirmation dialog.
-- A new withdrawal acknowledges completion without awarding positive feedback.
-- Existing withdrawals keep their original meaning and are not backfilled.
begin;
alter table public.auctions add column seller_resolved_at timestamptz,
    add column buyer_resolved_at timestamptz;
alter table public.auctions drop constraint auction_completed_confirmations;
alter table public.auctions add constraint auction_completed_confirmations check (
    status<>'completed' or (completed_at is not null and (
        (escrow_mode and settled_at is not null)
        or (not escrow_mode and coalesce(seller_confirmed_at,seller_resolved_at) is not null
            and coalesce(buyer_confirmed_at,buyer_resolved_at) is not null)
    ))
);

create function khub_bot.complete_resolved_trade() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if not new.escrow_mode and new.status='awaiting_trade'
        and coalesce(new.seller_confirmed_at,new.seller_resolved_at) is not null
        and coalesce(new.buyer_confirmed_at,new.buyer_resolved_at) is not null then
        update public.auctions set status='completed',completed_at=clock_timestamp() where id=new.id;
    end if;
    return new;
end; $$;
revoke all on function khub_bot.complete_resolved_trade() from public,anon,authenticated;
create trigger auctions_complete_resolved_trade
    after update of seller_confirmed_at,buyer_confirmed_at,seller_resolved_at,buyer_resolved_at on public.auctions
    for each row execute function khub_bot.complete_resolved_trade();

create or replace function public.withdraw_trade_rating(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare t khub_bot.trade_reports%rowtype; a public.auctions%rowtype; recipient public.profiles%rowtype;
    actor_name text; body text; delivery uuid; resolved_time timestamptz:=clock_timestamp();
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    select * into t from khub_bot.trade_reports where auction_id=p_auction_id and reporter_id=auth.uid() for update;
    if t.report_id is null or a.escrow_mode or a.finalized_at is null then raise exception 'Only the author can withdraw this negative response.'; end if;
    if t.withdrawn_at is not null then return; end if;
    insert into khub_bot.trade_rating_withdrawals(report_id,withdrawn_by,previous_counted)
        values(t.report_id,auth.uid(),t.counts_negative);
    update khub_bot.trade_reports set counts_negative=false,withdrawn_at=resolved_time where report_id=t.report_id;
    update khub_bot.bug_reports set status='resolved',resolution_kind='participant_resolved',resolved_by=auth.uid(),resolved_at=resolved_time where id=t.report_id;
    -- Separate timestamps preserve neutral completion. Positive counts and
    -- positive-notice triggers use only seller_confirmed_at/buyer_confirmed_at.
    update public.auctions set
        seller_resolved_at=case when t.reporter_role='seller' then resolved_time else seller_resolved_at end,
        buyer_resolved_at=case when t.reporter_role='buyer' then resolved_time else buyer_resolved_at end
        where id=a.id;
    select * into recipient from public.profiles where id=case when t.reporter_role='seller' then a.winner_id else a.seller_id end;
    select khub_username into actor_name from public.profiles where id=auth.uid();
    if recipient.kol_player_id is not null and recipient.kol_verified_at is not null then
        body:='Auction #'||coalesce(a.auction_number::text,a.id::text)||E'\n\n'
            ||khub_bot.escape_report_kmail(actor_name)||' withdrew their incomplete report and confirmed that the issue was resolved and the trade was successfully completed.'
            ||E'\nTheir negative rating has been removed from your profile. No positive rating was added.';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('rating-withdrawal:'||a.id||':'||auth.uid(),recipient.kol_player_id,'notice',body,body,'') returning id into delivery;
        update khub_bot.trade_reports set withdrawal_delivery_id=delivery where report_id=t.report_id;
    end if;
end; $$;

create or replace function public.confirm_auction_trade(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    if a.escrow_mode then raise exception 'Escrow delivery is confirmed by the bot, not by participants.'; end if;
    if (auth.uid()=a.seller_id and a.seller_resolved_at is not null)
        or (auth.uid()=a.winner_id and a.buyer_resolved_at is not null) then
        raise exception 'You already confirmed this trade complete by withdrawing an incomplete report. No positive rating can be added.';
    end if;
    if exists(select 1 from khub_bot.trade_reports where auction_id=p_auction_id and reporter_id=auth.uid() and withdrawn_at is null) then
        raise exception 'You already reported a trade issue. An administrator must review any correction.';
    end if;
    perform public.legacy_confirm_auction_trade(p_auction_id);
end; $$;

-- Preserve name/contact privacy while sharing both responses with participants.
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
        'seller_resolved_at',a.seller_resolved_at,'buyer_resolved_at',a.buyer_resolved_at,
        'seller_reported_incomplete',case when reveal then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_role='seller' and t.withdrawn_at is null) end,
        'buyer_reported_incomplete',case when reveal then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_role='buyer' and t.withdrawn_at is null) end,
        'own_trade_report',case when participant then (select 'B-'||b.report_number from khub_bot.trade_reports t join khub_bot.bug_reports b on b.id=t.report_id where t.auction_id=a.id and t.reporter_id=viewer) end,
        'own_trade_report_withdrawn',case when participant then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_id=viewer and t.withdrawn_at is not null) end,
        'trade_reported',case when participant then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.withdrawn_at is null) end,
        'completed_at',a.completed_at,'cancelled_at',a.cancelled_at,'settlement_contacts',contacts
    );
end; $$;

create or replace function public.read_pending_trades(p_page integer default 1) returns jsonb
language sql stable security definer set search_path='' as $$
with matching as materialized (
    select a.* from public.auctions a
    where auth.uid() is not null and not a.escrow_mode and a.status='awaiting_trade'
        and a.finalized_at is not null and a.winner_id is not null
        and not exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_id=auth.uid() and t.withdrawn_at is null)
        and ((a.seller_id=auth.uid() and coalesce(a.seller_confirmed_at,a.seller_resolved_at) is null)
          or (a.winner_id=auth.uid() and coalesce(a.buyer_confirmed_at,a.buyer_resolved_at) is null))
), page as (
    select * from matching order by finalized_at,id limit 12
    offset (greatest(1,least(coalesce(p_page,1),1000000))-1)*12
)
select jsonb_build_object('privacy_version',1,'total',(select count(*) from matching),
    'rows',coalesce((select jsonb_agg(khub_bot.public_auction(a,
        (select count(*) from public.bids b where b.auction_id=a.id),'Anonymous bidder','Anonymous bidder')
        order by a.finalized_at,a.id) from page a),'[]'::jsonb));
$$;

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

create or replace function khub_bot.queue_rating_notice(p_auction uuid,p_actor uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype; recipient public.profiles%rowtype; actor_name text;
    v_positive boolean; v_role text; delivery uuid; body text;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction;
    if a.id is null or a.escrow_mode or a.finalized_at is null or a.winner_id is null
        or a.seller_id=a.winner_id or a.status not in ('awaiting_trade','completed')
        or p_actor is null or p_actor not in (a.seller_id,a.winner_id) then return null; end if;
    v_positive:=case when p_actor=a.seller_id then a.seller_confirmed_at is not null else a.buyer_confirmed_at is not null end;
    if not v_positive and not exists(select 1 from khub_bot.trade_reports t
        where t.auction_id=a.id and t.reporter_id=p_actor and t.counts_negative and t.withdrawn_at is null) then return null; end if;
    select delivery_id into delivery from khub_bot.rating_notifications where auction_id=a.id and actor_id=p_actor and positive=v_positive;
    if found then return delivery; end if;
    select * into recipient from public.profiles where id=case when p_actor=a.seller_id then a.winner_id else a.seller_id end;
    -- Never guess a recipient number from a username or send to an unverified identity.
    if recipient.kol_player_id is null or recipient.kol_verified_at is null then return null; end if;
    select khub_username into actor_name from public.profiles where id=p_actor;
    v_role:=case when p_actor=a.seller_id then 'buyer' else 'seller' end;
    body:='Auction #'||coalesce(a.auction_number::text,a.id::text)
        ||E'\n'||a.quantity||' x '||khub_bot.escape_report_kmail(left(a.item,80))
        ||E'\nAgreed total: '||a.final_price||' Meat'
        ||E'\n\n'||khub_bot.escape_report_kmail(actor_name)
        ||case when v_positive then ' marked the trade Confirmed Complete: they received your side of the exchange.'
            else ' marked the trade Reported Incomplete: they reported that you did not complete your side of the exchange.' end
        ||E'\n\nA '||case when v_positive then 'Positive' else 'Negative' end
        ||' rating has been added to your profile as a '||v_role||'. It contributes to your overall reputation.'
        ||case when v_positive then E'\nThis records their response; the sale completes only after both parties confirm.'
            else E'\nPlease contact the other party and try to resolve this with them. Once the issue is resolved and the trade completed, they can use Withdraw Incomplete Report on the auction page. This removes the negative rating without adding a positive rating.'
                ||E'\nAs a last resort, use Contact an Administrator on the auction page to send a private Trade query about your concerns.' end
        ||E'\n\nView this auction and your profile on kHub for the current status and rating totals.';
    insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
        values('rating-notice:'||a.id||':'||p_actor||':'||case when v_positive then 'positive' else 'negative' end,recipient.kol_player_id,'notice',body,body,'') returning id into delivery;
    insert into khub_bot.rating_notifications(auction_id,actor_id,recipient_id,positive,recipient_role,delivery_id)
        values(a.id,p_actor,recipient.id,v_positive,v_role,delivery);
    return delivery;
end; $$;

notify pgrst,'reload schema';
commit;
