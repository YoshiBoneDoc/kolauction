-- Display-only shared snapshot. Never use this RPC to authorize a bid or payment.
-- Apply after 149, then deploy both Workers and rebuild the website.
begin;
create function public.read_public_auction_detail_state(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_build_object('privacy_version',1,'server_time',statement_timestamp(),
        'rows',coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object(
            'bid_deadline',case when a.escrow_mode then coalesce(a.escrow_buyout_received_at,a.end_time) else a.end_time end,
            'bid_count',(select count(*) from public.bids b where b.auction_id=a.id))), '[]'::jsonb),
        'bids','[]'::jsonb,'total',count(*))
    from public.auctions a
    where a.id=p_id and a.status<>'pending_escrow' and not khub_bot.is_abandoned_escrow_draft(a);
$$;
-- Return only explicitly approved public fields, even to direct RPC callers.
do $$ declare definition text; fields text;
begin
    fields := '''id'',''auction_number'',''auction_kind'',''item'',''item_id'',''quantity'',''image'',''min_bid_meat'',''current_bid'',''duration_hours'',''created_at'',''end_time'',''status'',''escrow_mode'',''instant_purchase_price'',''instant_purchased_at'',''final_price'',''finalized_at'',''completed_at'',''cancelled_at'',''expired_at'',''closure_reason'',''bundle_items''';
    definition:=pg_get_functiondef('public.read_public_auction_detail_state(uuid)'::regprocedure);
    definition:=replace(definition,'to_jsonb(a)', '(select jsonb_object_agg(key,value) from jsonb_each(to_jsonb(a)) where key in ('||fields||'))');
    execute definition;
end;$$;
revoke all on function public.read_public_auction_detail_state(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_public_auction_detail_state(uuid) to anon,authenticated;
notify pgrst,'reload schema';
commit;
