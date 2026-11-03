-- Validated locally with tests/public_listing_projection_database_test.py.
-- Apply after 169. Display-only: no financial functions, locks or writes changed.
-- Public Sell cards do not need the private reservation/contact/identity wrapper
-- chain. Buy cards retain the installed projection until separately validated.
begin;
set local lock_timeout='2s';
create function khub_bot.public_listing_projection(
    a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text
) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
    if a.auction_kind='buy' then
        return khub_bot.public_auction(a,p_bid_count,p_highest_label,p_winner_label);
    end if;
    return (select jsonb_object_agg(key,value) from jsonb_each(to_jsonb(a)) where key in (
        'id','auction_number','auction_kind','item','item_id','quantity','image',
        'min_bid_meat','current_bid','duration_hours','created_at','end_time','status',
        'escrow_mode','start_on_deposit','custom_end_at','instant_purchase_price',
        'instant_purchased_at','final_price','finalized_at','completed_at','cancelled_at',
        'expired_at','closure_reason','bundle_items','giveaway_title','giveaway_win_condition',
        'escrow_timing_review','ban_review_required'))
        ||jsonb_build_object('usernames_visible',false,'bid_count',p_bid_count,
            'has_winner',a.winner_id is not null,'receipt_time_bidding',a.escrow_mode,
            'bid_deadline',case when a.escrow_mode then coalesce(a.escrow_buyout_received_at,a.end_time) else a.end_time end,
            'finalization_not_before',case when a.escrow_mode then coalesce(a.escrow_buyout_received_at,a.end_time)+interval '60 seconds' end,
            'bidding_restricted',a.status='active' and khub_bot.profile_is_restricted(a.seller_id));
end;$$;
revoke all on function khub_bot.public_listing_projection(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;

create function khub_bot.public_home_listing_projection(
    a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text
) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
    if auth.uid() is not null then
        return khub_bot.public_auction(a,p_bid_count,p_highest_label,p_winner_label);
    end if;
    return khub_bot.public_listing_projection(a,p_bid_count,p_highest_label,p_winner_label);
end;$$;
revoke all on function khub_bot.public_home_listing_projection(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;

do $patch$
declare target regprocedure; definition text; anchor text:='khub_bot.public_auction(a,';
begin
    foreach target in array array[
        'khub_bot.public_listing_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text,text)'::regprocedure,
        'public.read_home_auctions_before_site_totals()'::regprocedure
    ] loop
        definition:=pg_get_functiondef(target);
        if strpos(definition,anchor)=0 then raise exception 'Unexpected listing projection in %',target;end if;
        if target='public.read_home_auctions_before_site_totals()'::regprocedure then
            -- Keep the direct authenticated Home projection unchanged.
            definition:=replace(definition,anchor,'khub_bot.public_home_listing_projection(a,');
        else
            definition:=replace(definition,anchor,'khub_bot.public_listing_projection(a,');
        end if;
        execute definition;
    end loop;
end;$patch$;
notify pgrst,'reload schema';
commit;
