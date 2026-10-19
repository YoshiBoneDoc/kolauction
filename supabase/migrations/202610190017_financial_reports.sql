-- Read-only, owner-only lifetime reports. Normally apply after 016.
-- Compatible with existing escrow/short-auction-number schemas (004 + 006);
-- does not require 015's mail-policy table. Safe to rerun this report migration.
begin;
create or replace function khub_bot.report_donations() returns setof khub_bot.receipts
language sql stable set search_path='' as $$
    select r.* from khub_bot.receipts r
    where r.result='donation'
      and (r.payload#>>'{raw,type}'='giftshop'
        or (r.payload#>>'{raw,type}'='normal'
            and coalesce(r.payload#>>'{raw,message}','') ~* '^[[:space:]]*DONATE[[:space:]]*(<|$)'));
$$;

create or replace function public.bot_financial_stats() returns jsonb
language sql stable security definer set search_path='' as $$
    with donations as (select * from khub_bot.report_donations()),
    sales as (select * from public.auctions where escrow_mode and status='completed'
        and highest_bidder_id is not null and current_bid>0),
    items as (
        select (x->>'id')::integer id,sum((x->>'quantity')::numeric) quantity
        from donations r cross join lateral jsonb_array_elements(r.payload->'items') x
        where r.payload#>>'{raw,type}'='normal' group by (x->>'id')::integer
    )
    select jsonb_build_object(
        'generated_at',statement_timestamp(),
        'donations',jsonb_build_object(
            'receipts',(select count(*)::text from donations),
            'meat',(select coalesce(sum((payload->>'meat')::numeric),0)::text from donations where payload#>>'{raw,type}'='normal'),
            'gift_packages',(select count(*)::text from donations where payload#>>'{raw,type}'='giftshop'),
            'items',coalesce((select jsonb_agg(jsonb_build_object('item_id',i.id,'name',coalesce(c.name,'Item #'||i.id),'quantity',i.quantity::text)
                order by coalesce(c.name,'Item #'||i.id),i.id) from items i left join khub_bot.catalog c on c.id=i.id),'[]'::jsonb)),
        'sales',jsonb_build_object(
            'completed',(select count(*)::text from sales),
            'trade_meat',(select coalesce(sum(current_bid::numeric),0)::text from sales),
            'commission_meat',(select coalesce(sum(fee_meat::numeric),0)::text from sales),
            'seller_proceeds_meat',(select coalesce(sum(current_bid::numeric-fee_meat),0)::text from sales)));
$$;

create or replace function public.bot_financial_history(p_kind text,p_offset bigint default 0,p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare rows jsonb;
begin
    if p_offset is null or p_offset<0 or p_limit is null or p_limit<1 or p_limit>100 then
        raise exception 'Use a nonnegative offset and a limit between 1 and 100.';
    end if;
    if p_kind='donations' then
        select coalesce(jsonb_agg(jsonb_build_object(
            'mail_id',r.mail_id,'received_at',r.received_at,'sender_id',r.sender_id::text,
            'sender_name',r.payload->>'sender_name',
            'kind',case when r.payload#>>'{raw,type}'='giftshop' then 'gift_package' else 'normal' end,
            'meat',case when r.payload#>>'{raw,type}'='normal' then coalesce(r.payload->>'meat','0') else '0' end,
            'items',case when r.payload#>>'{raw,type}'='giftshop' then '[]'::jsonb else
                coalesce((select jsonb_agg(jsonb_build_object('item_id',(x->>'id')::integer,
                    'name',coalesce(c.name,'Item #'||(x->>'id')),'quantity',x->>'quantity') order by (x->>'id')::integer)
                    from jsonb_array_elements(r.payload->'items') x left join khub_bot.catalog c on c.id=(x->>'id')::integer),'[]'::jsonb) end)
            order by r.received_at desc,r.mail_id desc),'[]'::jsonb) into rows
        from (select * from khub_bot.report_donations() order by received_at desc,mail_id desc limit p_limit offset p_offset) r;
    elsif p_kind='sales' then
        select coalesce(jsonb_agg(jsonb_build_object(
            'auction_id',a.id,'auction_number',a.auction_number::text,'completed_at',a.completed_at,
            'item',a.item,'quantity',a.quantity::text,'sale_meat',a.current_bid::text,
            'fee_bps',a.fee_bps,'commission_meat',a.fee_meat::text,
            'seller_proceeds_meat',(a.current_bid-a.fee_meat)::text)
            order by a.completed_at desc,a.id desc),'[]'::jsonb) into rows
        from (select * from public.auctions where escrow_mode and status='completed'
            and highest_bidder_id is not null and current_bid>0
            order by completed_at desc,id desc limit p_limit offset p_offset) a;
    else raise exception 'Use donations or sales for financial history.';
    end if;
    return jsonb_build_object('kind',p_kind,'offset',p_offset,'limit',p_limit,'records',rows);
end; $$;
revoke all on function khub_bot.report_donations() from public,anon,authenticated;
revoke all on function public.bot_financial_stats(),public.bot_financial_history(text,bigint,integer) from public,anon,authenticated;
grant execute on function public.bot_financial_stats(),public.bot_financial_history(text,bigint,integer) to service_role;
notify pgrst,'reload schema';
commit;
