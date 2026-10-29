-- Read-only presentation changes. No bid, escrow, payment or delivery writes.
begin;
select pg_advisory_xact_lock(3888760);
-- Existing seller fulfillment totals remain byte-for-byte in their function.
alter function khub_bot.buy_profile_totals(uuid) rename to buy_profile_totals_before_created;
create function khub_bot.buy_profile_totals(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
    with orders as materialized (
        select a.id from public.auctions a join khub_bot.buy_orders o on o.auction_id=a.id
        where a.seller_id=p_id and o.funded_meat>0
    ), paid as (
        select f.* from khub_bot.buy_fulfillments f join orders o on o.id=f.auction_id
        where not exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id
            and d.dedupe_key like 'buy-fill-payment:%' and d.state<>'sent')
    )
    select khub_bot.buy_profile_totals_before_created(p_id)||jsonb_build_object(
        'buy_orders_created',(select count(*)::text from orders),
        'buy_orders_bought_units',(select coalesce(sum(quantity),0)::text from paid),
        'buy_orders_spent',(select coalesce(sum(payment_meat::numeric+commission_meat),0)::text from paid));
$$;
revoke all on function khub_bot.buy_profile_totals(uuid) from public,anon,authenticated,service_role;
-- Sort the complete matching pool before pagination, including filtered reads.
do $patch$
declare target regprocedure; definition text; patched integer:=0;
    anchor text:='select m.* from matching m order by';
begin
    for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('read_auction_page','read_filtered_auction_page')
    loop
        definition:=pg_get_functiondef(target);
        if strpos(definition,anchor)>0 then
            definition:=replace(definition,anchor,anchor||$sort$
        case when p_sort='recommended' then case when m.status='active'
            and coalesce(m.escrow_buyout_received_at,m.end_time)>statement_timestamp()
            and coalesce(m.escrow_buyout_received_at,m.end_time)<=statement_timestamp()+interval '24 hours' then 0 else 1 end end asc,
        case when p_sort='recommended' and m.status='active'
            and coalesce(m.escrow_buyout_received_at,m.end_time)>statement_timestamp()
            and coalesce(m.escrow_buyout_received_at,m.end_time)<=statement_timestamp()+interval '24 hours'
            then coalesce(m.escrow_buyout_received_at,m.end_time) end asc,
        case when p_sort='recommended' then m.created_at end desc,
$sort$);
            execute definition; patched:=patched+1;
        end if;
    end loop;
    if patched<3 then raise exception 'Unexpected auction readers; inspect before applying 133.'; end if;
end; $patch$;
notify pgrst,'reload schema';
commit;
