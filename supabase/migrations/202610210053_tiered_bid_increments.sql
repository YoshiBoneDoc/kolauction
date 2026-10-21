-- Apply after 052. Applies to future bids on all active Direct/Escrow auctions.
-- Accepted bids, existing prices, deadlines and frozen financial records remain unchanged.
begin;
-- Finish in-flight bids before switching both trading methods together.
select pg_advisory_xact_lock(3888760);
create function khub_bot.bid_increment(p_current bigint) returns bigint
language sql immutable strict set search_path='' as $$
    select case
        when p_current<1000 then 10
        when p_current<10000 then 100
        when p_current<100000 then 1000
        when p_current<1000000 then 10000
        when p_current<10000000 then 100000
        when p_current<100000000 then 1000000
        when p_current<1000000000 then 10000000
        when p_current<10000000000 then 100000000
        else ceil(p_current::numeric/100)::bigint end;
$$;
create function khub_bot.minimum_auction_bid(p_minimum bigint,p_current bigint) returns bigint
language sql immutable strict set search_path='' as $$
    select greatest(p_minimum,case when p_current>0 then p_current+khub_bot.bid_increment(p_current) else p_minimum end);
$$;
revoke all on function khub_bot.bid_increment(bigint),khub_bot.minimum_auction_bid(bigint,bigint) from public,anon,authenticated,service_role;

create or replace function public.legacy_place_bid(p_auction_id uuid,p_amount bigint) returns void
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_username text; v_auction public.auctions%rowtype; required bigint;
begin
    if v_user is null then raise exception 'Please log in to place a bid.'; end if;
    if p_amount is null or p_amount<1 or p_amount>9007199254740991 then
        raise exception 'Enter a positive whole Meat amount that can be represented exactly.';
    end if;
    select khub_username into v_username from public.profiles where id=v_user;
    if not found then raise exception 'Your user profile could not be found.'; end if;
    select * into v_auction from public.auctions where id=p_auction_id for update;
    if not found then raise exception 'Auction not found.'; end if;
    if v_auction.status<>'active' or v_auction.end_time<=clock_timestamp() then raise exception 'This auction has ended or was cancelled.'; end if;
    if v_auction.seller_id=v_user then raise exception 'You cannot bid on your own auction.'; end if;
    -- An exact buyout remains valid even when below the normal next bid. Keep
    -- the verified-trader/ban wrappers and server-owned buyout amount checks.
    if v_auction.instant_purchase_price is not null and p_amount>=v_auction.instant_purchase_price then
        perform public.purchase_auction(p_auction_id); return;
    end if;
    if v_auction.highest_bidder_id=v_user then raise exception 'You are already the highest bidder.'; end if;
    required:=khub_bot.minimum_auction_bid(v_auction.min_bid_meat,v_auction.current_bid);
    if required>9007199254740991 then raise exception 'The maximum supported bid has been reached.'; end if;
    if p_amount<required then raise exception 'Your bid must be at least % Meat. Please check the latest price.',khub_bot.format_message_number(required); end if;
    insert into public.bids(auction_id,bidder_id,bidder_username,amount) values(p_auction_id,v_user,v_username,p_amount);
    update public.auctions set current_bid=p_amount,highest_bidder_id=v_user,highest_bidder_username=v_username where id=p_auction_id;
end; $$;

-- Preserve all layered intake validation, restriction checks, deduplication,
-- receipt bodies and financial queue behavior. Rejected funded bids must enter
-- the normal refund ledger, rather than throwing away the intake transaction.
do $$ declare definition text;
    predicate text:='meat<a.min_bid_meat or meat<=a.current_bid or meat>9007199254740991';
    message text:='reason:=''Send the full bid, meeting the minimum and exceeding the current bid.'';';
    buy_check text:='elsif cmd=''buy'' and meat<a.instant_purchase_price then reason:=''The attached Meat does not meet the instant purchase price.'';';
    buy_missing text:='elsif cmd=''buy'' and a.instant_purchase_price is null then reason:=''This listing has no instant purchase price.'';';
begin
    definition:=pg_get_functiondef('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure);
    if strpos(definition,predicate)=0 or strpos(definition,message)=0 or strpos(definition,buy_check)=0 or strpos(definition,buy_missing)=0 then raise exception 'Unexpected escrow bidding implementation; migration not applied.'; end if;
    definition:=replace(definition,buy_check,'');
    definition:=replace(definition,buy_missing,buy_missing||E'\n            '||buy_check);
    definition:=replace(definition,predicate,
        'meat<a.min_bid_meat or meat<=a.current_bid or meat>9007199254740991 or '
        ||'((a.instant_purchase_price is null or meat<a.instant_purchase_price) and meat<khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid))');
    definition:=replace(definition,message,
        'reason:=case when khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid)>9007199254740991 then ''The maximum supported bid has been reached.'' else '
        ||'''Send your full bid of at least ''||khub_bot.format_message_number(least(khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid),coalesce(a.instant_purchase_price,khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid))))||'' Meat. Bid increases depend on the current highest bid.'' end;');
    execute definition;
end; $$;

-- Preserve all existing friendly rejection translations, but don't hide the
-- exact next minimum generated by the new bidding checks behind a generic error.
alter function khub_bot.friendly_reason(text) rename to friendly_reason_before_bid_increments;
create function khub_bot.friendly_reason(p_reason text) returns text
language sql immutable set search_path='' as $$
    select case when p_reason ~ '^Send your full bid of at least [0-9][0-9,]* Meat[.] Bid increases depend on the current highest bid[.]$'
        or p_reason='The maximum supported bid has been reached.' then p_reason
        else khub_bot.friendly_reason_before_bid_increments(p_reason) end;
$$;
revoke all on function khub_bot.friendly_reason(text),khub_bot.friendly_reason_before_bid_increments(text) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
