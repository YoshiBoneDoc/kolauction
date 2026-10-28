-- Profile-only read projection. Does not change Buy fulfillment or payment processing.
-- Buy fulfillment history is intentionally capped, so aggregate the signed-in
-- account's successful quantity alongside its existing successful Meat total.
-- The current bidder receives only a private yes/no status, not another bidder's ID.
begin;
do $patch$
declare
    -- Migration 086 renamed the Buy projection; 091/093/096 subsequently
    -- wrapped it. Patch the original projection without bypassing those wrappers.
    target regprocedure := coalesce(
        to_regprocedure('khub_bot.auction_before_buy_reservations(public.auctions,bigint,text,text)'),
        to_regprocedure('khub_bot.public_auction(public.auctions,bigint,text,text)'));
    definition text;
    old_auction_kind text := $old$'auction_kind',a.auction_kind)$old$;
    new_auction_kind text := $new$'auction_kind',a.auction_kind,'viewer_is_highest_bidder',case when a.highest_bidder_id is null then null else auth.uid() is not null and a.highest_bidder_id=auth.uid() end)$new$;
    old_meat text := $old$'my_sale_meat',coalesce((select sum(f.payment_meat) from khub_bot.buy_fulfillments f where f.auction_id=a.id and f.seller_id=auth.uid() and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id and d.dedupe_key like 'buy-fill-payment:%' and d.state<>'sent')),0),$old$;
    new_totals text := $new$'my_sale_meat',coalesce((select sum(f.payment_meat) from khub_bot.buy_fulfillments f where f.auction_id=a.id and f.seller_id=auth.uid() and f.seller_kol_id=(select p.kol_player_id from public.profiles p where p.id=auth.uid() and p.kol_verified_at is not null) and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id and d.dedupe_key like 'buy-fill-payment:%' and d.state<>'sent')),0),
        'my_sale_quantity',coalesce((select sum(f.quantity) from khub_bot.buy_fulfillments f where f.auction_id=a.id and f.seller_id=auth.uid() and f.seller_kol_id=(select p.kol_player_id from public.profiles p where p.id=auth.uid() and p.kol_verified_at is not null) and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id and d.dedupe_key like 'buy-fill-payment:%' and d.state<>'sent')),0),$new$;
begin
    if target is null then raise exception 'Buy auction projection is missing.'; end if;
    definition:=pg_get_functiondef(target);
    if strpos(definition,old_meat)=0 and strpos(definition,new_totals)=0 then
        raise exception 'Unexpected Buy profile projection; inspect % before applying.',target;
    end if;
    if strpos(definition,old_auction_kind)=0 and strpos(definition,new_auction_kind)=0 then
        raise exception 'Unexpected auction status projection; inspect % before applying.',target;
    end if;
    definition:=replace(definition,old_meat,new_totals);
    execute replace(definition,old_auction_kind,new_auction_kind);
end;
$patch$;
notify pgrst,'reload schema';
commit;
