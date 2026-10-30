-- ONE-TIME OPERATION: run manually in Supabase SQL Editor as postgres.
-- Screenshot: #1161, teres Minor, 1 dense meat stack, ToastPancake bidding 1 Meat.
-- Stops bidding; the running bot performs its normal inbox check and settlement.
-- Does not manually send anything or fabricate settlement/payment records.
begin;
select pg_advisory_xact_lock(3888760);

do $operation$
declare
    a public.auctions%rowtype;
    accepted_at timestamptz;
    cutoff timestamptz;
begin
    select * into strict a from public.auctions where auction_number=1161 for update;
    if a.status<>'active' or a.auction_kind<>'sell' or not a.escrow_mode
        or a.item_escrowed_at is null or a.escrow_buyout_received_at is not null
        or a.item<>'dense meat stack' or a.quantity<>1 or a.current_bid<>1
        or a.highest_bidder_id is null then
        raise exception 'Auction #1161 no longer matches the active, funded 1-Meat test auction. Nothing changed.';
    end if;
    if not exists (select 1 from public.profiles p where p.id=a.seller_id
        and (lower(p.kol_player_name)='teres minor' or lower(regexp_replace(p.khub_username,'^KH_','','i'))='teres minor'))
        or not exists (select 1 from public.profiles p where p.id=a.highest_bidder_id
        and (lower(p.kol_player_name)='toastpancake' or lower(regexp_replace(p.khub_username,'^KH_','','i'))='toastpancake')) then
        raise exception 'Seller or winning bidder differs from the screenshot. Nothing changed.';
    end if;

    select r.received_at into accepted_at
    from public.bids b
    join khub_bot.bid_receipts br on br.bid_id=b.id
    join khub_bot.receipts r on r.mail_id=br.receipt_id
    where b.auction_id=a.id and b.bidder_id=a.highest_bidder_id and b.amount=a.current_bid
    order by b.created_at desc limit 1;
    if accepted_at is null then
        raise exception 'Cannot verify the accepted escrow bid receipt. Nothing changed.';
    end if;
    -- Close just after this accepted bid's receipt so later in-flight bids cannot
    -- replace the requested winner. Keep the original bid and receipt untouched.
    cutoff:=accepted_at+interval '1 microsecond';
    if cutoff<=a.created_at or cutoff>=clock_timestamp() or cutoff>=a.end_time then
        raise exception 'Cannot safely shorten the deadline to the accepted bid. Nothing changed.';
    end if;
    update public.auctions set end_time=cutoff where id=a.id;
    raise notice 'Auction #1161 closed to further bids. Expected winner: ToastPancake, 1 Meat. Old deadline: %, new cutoff: %. The bot will settle using its normal inbox checks.',a.end_time,cutoff;
end;
$operation$;
commit;

select auction_number,status,current_bid,highest_bidder_username,end_time,
    winner_username,final_price
from public.auctions where auction_number=1161;
