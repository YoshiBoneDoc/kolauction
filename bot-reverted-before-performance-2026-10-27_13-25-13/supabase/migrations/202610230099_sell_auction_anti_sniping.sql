-- Apply after 098. No bot rebuild is needed for this database-only bidding rule.
-- Future accepted bids can extend active Sell auctions; past bids are unchanged.
begin;
select pg_advisory_xact_lock(3888760);
create table khub_bot.auction_bid_extensions (
    bid_id uuid primary key references public.bids(id),
    auction_id uuid not null references public.auctions(id),
    receipt_id text references khub_bot.receipts(mail_id),
    received_at timestamptz not null,
    previous_end_time timestamptz not null,
    new_end_time timestamptz not null,
    recorded_at timestamptz not null default clock_timestamp(),
    check(new_end_time>previous_end_time and new_end_time=received_at+interval '60 seconds')
);
create index auction_bid_extensions_history on khub_bot.auction_bid_extensions(auction_id,recorded_at,bid_id);
alter table khub_bot.auction_bid_extensions enable row level security;
revoke all on khub_bot.auction_bid_extensions from public,anon,authenticated,service_role;

create function khub_bot.extend_sell_auction(p_auction uuid,p_bid uuid,p_received timestamptz,p_receipt text default null)
returns void language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype; b public.bids%rowtype; next_end timestamptz;
begin
    -- Match the common intake/website/finalization lock order.
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction for update;
    if a.id is null or a.auction_kind<>'sell' or a.status<>'active'
        or a.escrow_buyout_received_at is not null or a.instant_purchased_at is not null
        or p_received is null or not isfinite(p_received)
        or p_received>=a.end_time or p_received<a.end_time-interval '60 seconds' then return;end if;
    select * into b from public.bids where id=p_bid and auction_id=a.id;
    if b.id is null or b.amount<>a.current_bid or b.bidder_id is distinct from a.highest_bidder_id
        or (a.instant_purchase_price is not null and b.amount>=a.instant_purchase_price)
        or exists(select 1 from khub_bot.auction_bid_extensions where bid_id=b.id) then return;end if;
    if a.escrow_mode and not exists(select 1 from khub_bot.bid_receipts br
        join khub_bot.receipts r on r.mail_id=br.receipt_id where br.bid_id=b.id and br.receipt_id=p_receipt
        and r.received_at=p_received) then raise exception 'Escrow extension requires the original bid receipt.';end if;
    next_end:=p_received+interval '60 seconds';
    if next_end<=a.end_time then return;end if;
    insert into khub_bot.auction_bid_extensions(bid_id,auction_id,receipt_id,received_at,previous_end_time,new_end_time)
        values(b.id,a.id,p_receipt,p_received,a.end_time,next_end);
    update public.auctions set end_time=next_end where id=a.id;
end;$$;
revoke all on function khub_bot.extend_sell_auction(uuid,uuid,timestamptz,text) from public,anon,authenticated,service_role;

-- Capture Direct bid time AFTER acquiring the row lock, use it for both
-- eligibility and extension, and preserve all existing account/price guards.
do $$declare d text;
    declaration text:='required bigint;';
    locked text:='select * into v_auction from public.auctions where id=p_auction_id for update;';
    cutoff text:='v_auction.end_time<=clock_timestamp()';
    bid_insert text:='insert into public.bids(auction_id,bidder_id,bidder_username,amount) values(p_auction_id,v_user,v_username,p_amount);';
    updated text:='update public.auctions set current_bid=p_amount,highest_bidder_id=v_user,highest_bidder_username=v_username where id=p_auction_id;';
begin
    d:=pg_get_functiondef('public.legacy_place_bid(uuid,bigint)'::regprocedure);
    if strpos(d,declaration)=0 or strpos(d,locked)=0 or strpos(d,cutoff)=0 or strpos(d,bid_insert)=0 or strpos(d,updated)=0 then raise exception 'Unexpected Direct bid writer; anti-sniping migration not applied.';end if;
    d:=replace(d,declaration,declaration||' bid_received timestamptz; accepted_bid uuid;');
    d:=replace(d,locked,locked||' bid_received:=clock_timestamp();');
    d:=replace(d,cutoff,'v_auction.end_time<=bid_received');
    d:=replace(d,bid_insert,substring(bid_insert from 1 for length(bid_insert)-1)||' returning id into accepted_bid;');
    d:=replace(d,updated,updated||' perform khub_bot.extend_sell_auction(p_auction_id,accepted_bid,bid_received);');
    execute d;
end;$$;

-- Escrow, including opened gift deposits, uses actual KoL receipt time and the
-- existing exact bid/receipt link. Invalid or duplicate mail never reaches here.
do $$declare d text;
    updated text:='update public.auctions set current_bid=accepted,highest_bidder_id=u.id,highest_bidder_username=u.khub_username,highest_bidder_kol_id=sid where id=aid;';
begin
    d:=pg_get_functiondef('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure);
    if strpos(d,updated)=0 then raise exception 'Unexpected Escrow bid writer; anti-sniping migration not applied.';end if;
    execute replace(d,updated,updated||' perform khub_bot.extend_sell_auction(aid,(select bid_id from khub_bot.bid_receipts where receipt_id=mid),(p_mail->>''received_at'')::timestamptz,mid);');
end;$$;
notify pgrst,'reload schema';
commit;
