-- Apply with workers stopped, immediately after 187, before accepting promotional
-- settlements. Snapshot once; toggling never expands this grandfathered cohort.
begin;
select pg_advisory_xact_lock(3888760);
alter table khub_bot.buy_orders add column promotional_remaining_free boolean not null default false;
update khub_bot.buy_orders o set promotional_remaining_free=true
from public.auctions a where a.id=o.auction_id and a.status in ('active','on_hold')
    and o.purchased_quantity>0;

create function khub_bot.settle_buy_escrow_fee(p_key text,p_user uuid,p_price bigint,p_original bigint,p_free boolean)
returns bigint language plpgsql set search_path='' as $$
declare fee bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    fee:=khub_bot.settle_escrow_fee(p_key,p_user,p_price,p_original);
    if p_free and (select enabled from khub_bot.escrow_promotion_config where id) then
        -- The shared helper has already validated identity and recorded volume.
        -- Override only this transaction's commission, within the same transaction.
        update khub_bot.promotional_escrow_volume set fee=0 where transaction_key=p_key;
        return 0;
    end if;
    return fee;
end; $$;
revoke all on function khub_bot.settle_buy_escrow_fee(text,uuid,bigint,bigint,boolean) from public,anon,authenticated,service_role;
do $$
declare d text; old text:='khub_bot.settle_escrow_fee(''buy:''||mid,a.seller_id,payment,floor(khub_bot.buy_fee_numerator(a.min_bid_meat)*accepted/10000)::bigint)';
begin
    d:=pg_get_functiondef('khub_bot.ingest_before_buy_reservations(jsonb)'::regprocedure);
    if strpos(d,old)=0 then raise exception 'Promotional Buy fee anchor missing'; end if;
    execute replace(d,old,'khub_bot.settle_buy_escrow_fee(''buy:''||mid,a.seller_id,payment,floor(khub_bot.buy_fee_numerator(a.min_bid_meat)*accepted/10000)::bigint,o.promotional_remaining_free)');
end; $$;
notify pgrst,'reload schema';
commit;
