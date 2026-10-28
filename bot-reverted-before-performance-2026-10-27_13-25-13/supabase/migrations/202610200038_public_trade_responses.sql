-- Apply after 037. Closed direct-trade response statuses are public.
-- Usernames keep the existing unrestricted-login requirement. Contacts, report
-- references, report bodies and participant-only controls remain private.
begin;

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
    closed_direct boolean := not a.escrow_mode and a.finalized_at is not null
        and a.winner_id is not null and a.status in ('awaiting_trade','completed');
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
        'seller_reported_incomplete',case when closed_direct then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_role='seller' and t.withdrawn_at is null) end,
        'buyer_reported_incomplete',case when closed_direct then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_role='buyer' and t.withdrawn_at is null) end,
        'own_trade_report',case when participant then (select 'B-'||b.report_number from khub_bot.trade_reports t join khub_bot.bug_reports b on b.id=t.report_id where t.auction_id=a.id and t.reporter_id=viewer) end,
        'own_trade_report_withdrawn',case when participant then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_id=viewer and t.withdrawn_at is not null) end,
        'trade_reported',case when closed_direct then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.withdrawn_at is null) end,
        'completed_at',a.completed_at,'cancelled_at',a.cancelled_at,'settlement_contacts',contacts
    );
end; $$;

notify pgrst,'reload schema';
commit;
