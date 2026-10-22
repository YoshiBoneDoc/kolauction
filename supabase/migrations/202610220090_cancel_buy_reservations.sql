-- Seller-owned reservation cancellation, serialized with fulfillment and escrow.
-- Apply after 089. No worker restart required.
begin;
alter table khub_bot.buy_reservations drop constraint buy_reservations_state_check;
alter table khub_bot.buy_reservations add constraint buy_reservations_state_check
    check(state in ('active','fulfilled','expired','cancelled'));

create function public.cancel_buy_reservation(p_reservation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r khub_bot.buy_reservations%rowtype; reason text;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into r from khub_bot.buy_reservations where id=p_reservation_id and seller_id=auth.uid() for update;
    if not found then raise exception 'Reservation not found for your account.' using errcode='42501';end if;
    -- Retries and requests racing an accepted fulfillment never undo a purchase.
    if r.state<>'active' then return jsonb_build_object('id',r.id,'state',r.state);end if;
    if exists(select 1 from khub_bot.inbox_bid_mail m where not m.processed
        and m.payload#>>'{command,reservation_id}'=r.id::text) then
        raise exception 'Items have already arrived for this reservation. Please wait for verification before canceling.';
    end if;
    update khub_bot.buy_reservations set state='cancelled',resolved_at=clock_timestamp() where id=r.id;
    insert into khub_bot.buy_order_events(auction_id,kind,reservation_id,details)
        values(r.auction_id,'reservation_cancelled',r.id,jsonb_build_object('quantity',r.quantity,'seller_id',r.seller_id));
    perform khub_bot.rebalance_buy_order(r.auction_id);
    select close_reason into reason from khub_bot.buy_orders where auction_id=r.auction_id;
    perform khub_bot.finish_buy_order(r.auction_id,coalesce(reason,'filled'));
    return jsonb_build_object('id',r.id,'state','cancelled');
end; $$;
revoke all on function public.cancel_buy_reservation(uuid) from public,anon,authenticated;
grant execute on function public.cancel_buy_reservation(uuid) to authenticated;

-- Keep the existing reservation hint consistent with the new cancel action.
do $patch$
declare definition text; updated text;
begin
    definition:=pg_get_functiondef('public.reserve_buy_quantity(uuid,bigint)'::regprocedure);
    updated:=replace(definition,'Complete it or wait for it to expire.','Complete it, cancel it, or wait for it to expire.');
    if updated=definition then raise exception 'Unexpected reserve_buy_quantity definition.';end if;
    execute updated;
end; $patch$;
notify pgrst,'reload schema';
commit;
