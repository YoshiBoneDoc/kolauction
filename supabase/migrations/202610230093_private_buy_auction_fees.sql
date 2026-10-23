-- Apply after 092. Buy-auction costs are for the creator and administrator only.
-- Read-only projection change; no fee amounts, payments or worker changes.
begin;
alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to auction_before_private_buy_costs;
revoke all on function khub_bot.auction_before_private_buy_costs(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    result:=khub_bot.auction_before_private_buy_costs(a,p_bid_count,p_highest_label,p_winner_label);
    if a.auction_kind<>'buy' or (khub_bot.can_view_usernames()
        and (auth.uid()=a.seller_id or khub_bot.is_administrator(auth.uid()))) then return result;end if;
    result:=result-array['fee_meat','fee_bps','fee_policy','funding_required','balance_meat','purchase_meat',
        'buy_commission_meat','refunded_meat','gift_meat','gift_funding_needed','reservation_audit'];
    return result||jsonb_build_object('fulfillments',coalesce((select jsonb_agg(f.value-'commission_meat' order by f.position)
        from jsonb_array_elements(coalesce(result->'fulfillments','[]'::jsonb)) with ordinality f(value,position)),'[]'::jsonb));
end; $$;
revoke all on function khub_bot.public_auction(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
