-- Apply after 086. Display only: no monetary amounts, commitments or previously
-- frozen delivery messages change. Install the matching worker report formatter.
begin;
create function khub_bot.effective_fee_percent(p_fee bigint,p_price bigint) returns text
language plpgsql immutable set search_path='' as $$
declare scaled numeric;fraction text;
begin
    if coalesce(p_fee,0)<0 or coalesce(p_price,0)<0 then raise exception 'Fee amounts must be nonnegative.';end if;
    if coalesce(p_fee,0)=0 or coalesce(p_price,0)=0 then return '0%';end if;
    scaled:=floor((p_fee::numeric*1000000+floor(p_price::numeric/2))/p_price);
    if scaled=0 then return '<0.0001%';end if;
    fraction:=rtrim(lpad(mod(scaled,10000)::text,4,'0'),'0');
    return floor(scaled/10000)::text||case when fraction='' then '' else '.'||fraction end||'%';
end; $$;
alter function khub_bot.friendly_message(khub_bot.deliveries) rename to message_before_effective_fees;
create function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare body text;a public.auctions%rowtype;o khub_bot.buy_orders%rowtype;f khub_bot.buy_fulfillments%rowtype;fee bigint;basis bigint;label text;
begin
    body:=khub_bot.message_before_effective_fees(d);
    select * into a from public.auctions where id=d.auction_id;
    if a.auction_kind='sell' and d.kind='sale_meat' then
        label:=case when a.fee_policy='tiered_v1' then 'Tiered Fee' else 'Fee' end||' ('||khub_bot.effective_fee_percent(a.fee_meat,a.final_price)||'): ';
        return regexp_replace(body,E'Commission \\([^\\n]*\\): ',label);
    end if;
    if a.auction_kind='buy' and d.recipient_id=a.seller_kol_id then
        select * into o from khub_bot.buy_orders where auction_id=a.id;
        if d.dedupe_key like 'buy-funded:%' then
            basis:=a.min_bid_meat*a.quantity;
            fee:=floor(khub_bot.buy_fee_numerator(a.min_bid_meat)*a.quantity/10000)::bigint;
            return body||E'\n\nPurchase funds: '||khub_bot.format_message_number(basis)||' Meat'
                ||E'\nEstimated Tiered Fee ('||khub_bot.effective_fee_percent(fee,basis)||'): '||khub_bot.format_message_number(fee)||' Meat'
                ||E'\nCommission reserve ('||khub_bot.effective_fee_percent(o.funding_required-basis,basis)||'): '||khub_bot.format_message_number(o.funding_required-basis)||' Meat. Unused reserve is refunded; actual fees are charged per fulfillment.';
        end if;
        if d.kind='sale_item' or d.dedupe_key like 'buy-fill-accepted:%' or d.dedupe_key like 'buy-order-refund:%' then
            select * into f from khub_bot.buy_fulfillments where receipt_id=d.receipt_id;
            fee:=coalesce(f.commission_meat,o.commission_meat);basis:=coalesce(f.payment_meat,o.purchase_meat);
            return body||E'\n\nTiered Fee ('||khub_bot.effective_fee_percent(fee,basis)||'): '||khub_bot.format_message_number(fee)||' Meat'
                ||case when f.receipt_id is null then E'\nGift delivery expenses (separate): '||khub_bot.format_message_number(o.gift_meat)||' Meat' else '' end;
        end if;
    end if;
    return body;
end; $$;
-- The buyer also sees the actual fee for each fulfillment in website history.
do $$
declare definition text;
begin
    definition:=pg_get_functiondef('khub_bot.sell_financial_history(text,bigint,integer)'::regprocedure);
    execute replace(definition,$old$'fee_bps',a.fee_bps,$old$,$new$'fee_policy',a.fee_policy,'fee_bps',a.fee_bps,$new$);
    definition:=pg_get_functiondef('khub_bot.buy_history(uuid)'::regprocedure);
    execute replace(definition,$old$'payment_meat',f.payment_meat,$old$,
        $new$'payment_meat',f.payment_meat,'commission_meat',case when auth.uid()=a.seller_id or khub_bot.is_administrator(auth.uid()) then f.commission_meat end,$new$);
end; $$;
revoke all on function khub_bot.effective_fee_percent(bigint,bigint),khub_bot.message_before_effective_fees(khub_bot.deliveries),khub_bot.friendly_message(khub_bot.deliveries) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
