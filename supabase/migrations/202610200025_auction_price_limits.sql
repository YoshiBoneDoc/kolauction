-- Apply once after 024, with workers stopped. Deploy the matching website/bot,
-- then restart the existing worker. This script does not change saved amounts,
-- fee snapshots, receipts, transfer states or frozen message bodies.
-- Remove the arbitrary 10/20-billion business limits. Retain only the exact
-- integer boundary of the current JavaScript/JSON transport (2^53-1) so that a
-- larger typed bid can never be rounded into a different amount in transit.
begin;

alter table public.auctions
    drop constraint auctions_min_bid_meat_check,
    add constraint auctions_min_bid_meat_check check (min_bid_meat between 1 and 9007199254740991),
    drop constraint auctions_current_bid_check,
    add constraint auctions_current_bid_check check (current_bid between 0 and 9007199254740991),
    drop constraint auctions_final_price_check,
    add constraint auctions_final_price_check check (final_price between 1 and 9007199254740991),
    drop constraint auction_instant_purchase_price,
    add constraint auction_instant_purchase_price check (
        instant_purchase_price is null or instant_purchase_price between min_bid_meat and 9007199254740991
    );
alter table public.bids drop constraint bids_amount_check,
    add constraint bids_amount_check check (amount between 1 and 9007199254740991);

-- CREATE OR REPLACE keeps the existing browser/service-role permission boundaries.
-- The verified-trader wrappers from 024 and banned-account/mail-policy wrappers
-- remain in place; update only their existing private implementations.
create or replace function public.legacy_place_bid(p_auction_id uuid, p_amount bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_user uuid := auth.uid();
    v_username text;
    v_auction public.auctions%rowtype;
begin
    if v_user is null then raise exception 'Please log in to place a bid.'; end if;
    if p_amount is null or p_amount < 1 or p_amount > 9007199254740991 then
        raise exception 'Enter a positive whole Meat amount that can be represented exactly.';
    end if;
    select khub_username into v_username from public.profiles where id = v_user;
    if not found then raise exception 'Your user profile could not be found.'; end if;
    select * into v_auction from public.auctions where id = p_auction_id for update;
    if not found then raise exception 'Auction not found.'; end if;
    if v_auction.status <> 'active' or v_auction.end_time <= clock_timestamp() then
        raise exception 'This auction has ended or was cancelled.';
    end if;
    if v_auction.seller_id = v_user then raise exception 'You cannot bid on your own auction.'; end if;
    -- This also lets the current high bidder accept the instant price.
    if v_auction.instant_purchase_price is not null and p_amount >= v_auction.instant_purchase_price then
        perform public.purchase_auction(p_auction_id);
        return;
    end if;
    if v_auction.highest_bidder_id = v_user then raise exception 'You are already the highest bidder.'; end if;
    if p_amount < v_auction.min_bid_meat or p_amount <= v_auction.current_bid then
        raise exception 'Your bid must meet the minimum and exceed the current bid. Please check the latest price.';
    end if;
    insert into public.bids (auction_id, bidder_id, bidder_username, amount)
        values (p_auction_id, v_user, v_username, p_amount);
    update public.auctions set current_bid = p_amount, highest_bidder_id = v_user,
        highest_bidder_username = v_username where id = p_auction_id;
end;
$$;

create or replace function khub_bot.ingest_mail_before_invalid_refunds(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare mid text:=p_mail->>'id'; sid bigint:=(p_mail->>'sender_id')::bigint;
    meat bigint:=(p_mail->>'meat')::bigint; attachments jsonb:=p_mail->'items';
    cmd text:=p_mail#>>'{command,type}'; aid uuid; a public.auctions%rowtype; u public.profiles%rowtype;
    tok khub_bot.verifications%rowtype; reason text; accepted bigint; old_sender bigint; old_bid bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    if mid is null or mid!~'^[1-9][0-9]*$' or sid is null or sid<=0 or sid=3888760 or meat is null or meat<0 or meat>9007199254740991
       or jsonb_typeof(attachments) is distinct from 'array' then raise exception 'Invalid normalized KMail.'; end if;
    if exists(select 1 from jsonb_array_elements(attachments) x where (x->>'id') is null or (x->>'quantity') is null or (x->>'id')::integer<=0 or
        (x->>'quantity')::bigint<=0 or (x->>'quantity')::bigint>5000000000) then raise exception 'Invalid attachments.'; end if;
    if exists(select 1 from khub_bot.receipts where mail_id=mid) then
        if (select payload from khub_bot.receipts where mail_id=mid) <> p_mail then raise exception 'KMail ID payload changed; reconcile before continuing.'; end if;
        return 'duplicate';
    end if;
    insert into khub_bot.receipts(mail_id,sender_id,received_at,payload)
        values(mid,sid,(p_mail->>'received_at')::timestamptz,p_mail);
    if cmd='verify' then
        select * into tok from khub_bot.verifications where token=p_mail#>>'{command,token}' and expires_at>clock_timestamp() for update;
        if not found then reason:='Verification code is invalid or expired.';
        elsif meat<>0 or jsonb_array_length(attachments)<>0 then reason:='Verification must not contain items or Meat.';
        elsif sid=3888760 or exists(select 1 from public.profiles where kol_player_id=sid and id<>tok.user_id) then reason:='This KoL player is already linked or is the bot.';
        else
            update public.profiles set kol_player_id=sid,kol_player_name=p_mail->>'sender_name',kol_verified_at=clock_timestamp()
                where id=tok.user_id and kol_player_id is null;
            if not found then reason:='Website account is already linked.';
            else delete from khub_bot.verifications where token=tok.token;
                perform khub_bot.queue('verified:'||mid,null,mid,sid,'notice',0,'[]','Your KoL account is now linked to kHub.');
            end if;
        end if;
    elsif cmd in ('list','bid','buy') then
        -- Resolve a public auction number without rewriting the receipt payload.
        -- UUID commands remain supported for existing instructions and mail.
        if (p_mail->'command') ? 'auction_number' then
            if p_mail#>>'{command,auction_number}' ~ '^[1-9][0-9]{0,18}$' then
                if (p_mail#>>'{command,auction_number}')::numeric <= 9223372036854775807 then
                    select id into aid from public.auctions
                        where auction_number=(p_mail#>>'{command,auction_number}')::bigint;
                end if;
            end if;
        elsif p_mail#>>'{command,auction_id}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
            aid:=(p_mail#>>'{command,auction_id}')::uuid;
        end if;
        select * into a from public.auctions where id=aid for update;
        select * into u from public.profiles where kol_player_id=sid;
        if a.id is null or not a.escrow_mode then reason:='Unknown escrow auction ID.';
        elsif u.id is null then reason:='Link your KoL account on the website before sending deposits or bids.';
        elsif cmd='list' then
            if a.seller_kol_id<>sid then reason:='Only the listing seller can deposit its items.';
            elsif a.status<>'pending_escrow' then reason:='This listing is not waiting for a deposit.';
            elsif not a.start_on_deposit and a.end_time<=clock_timestamp() then reason:='The listing deadline has passed.';
            elsif meat<>0 or attachments<>jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',a.quantity)) then
                reason:='Send exactly the listed item and quantity, with no Meat or extra items.';
            else
                update public.auctions set status='active',item_escrowed_at=clock_timestamp(),
                    end_time=case when start_on_deposit then clock_timestamp()+make_interval(hours=>duration_hours) else end_time end where id=aid;
                perform khub_bot.queue('activated:'||mid,aid,mid,sid,'notice',0,'[]','Auction '||aid||' is active. Your items are held in escrow.');
            end if;
        else
            if a.status<>'active' or a.end_time<=clock_timestamp() then reason:='Bidding is closed.';
            elsif a.seller_kol_id=sid then reason:='Sellers cannot bid on their own auction.';
            elsif jsonb_array_length(attachments)<>0 then reason:='Bids must contain Meat only, without items.';
            elsif cmd='buy' and a.instant_purchase_price is null then reason:='This listing has no instant purchase price.';
            elsif meat<a.min_bid_meat or meat<=a.current_bid or meat>9007199254740991 then reason:='Send the full bid, meeting the minimum and exceeding the current bid.';
            elsif cmd='buy' and meat<a.instant_purchase_price then reason:='The attached Meat does not meet the instant purchase price.';
            else
                accepted:=case when a.instant_purchase_price is not null and meat>=a.instant_purchase_price then a.instant_purchase_price else meat end;
                old_sender:=a.highest_bidder_kol_id; old_bid:=a.current_bid;
                if old_sender is not null then
                    perform khub_bot.queue('outbid:'||mid,aid,mid,old_sender,'refund',old_bid,'[]','Auction '||aid||': your previous bid is refunded in full.');
                end if;
                insert into public.bids(auction_id,bidder_id,bidder_username,amount) values(aid,u.id,u.khub_username,accepted);
                update public.auctions set current_bid=accepted,highest_bidder_id=u.id,highest_bidder_username=u.khub_username,highest_bidder_kol_id=sid where id=aid;
                if meat>accepted then perform khub_bot.queue('excess:'||mid,aid,mid,sid,'refund',meat-accepted,'[]','Auction '||aid||': excess above the instant price is refunded.'); end if;
                if a.instant_purchase_price is not null and accepted=a.instant_purchase_price then perform khub_bot.finish_listing(aid,'instant');
                else perform khub_bot.queue('bid-accepted:'||mid,aid,mid,sid,'notice',0,'[]','Auction '||aid||': your funded bid of '||accepted||' Meat was accepted.'); end if;
            end if;
        end if;
    else reason:='Unknown command. Use VERIFY <code>, LIST <auction-id>, BID <auction-id>, or BUY <auction-id>.';
    end if;
    -- Do not engage other auto-responders in an infinite empty-mail loop.
    if reason is not null and (cmd<>'unknown' or meat>0 or jsonb_array_length(attachments)>0) then
        perform khub_bot.queue('rejected:'||mid,null,mid,sid,'refund',meat,attachments,'KHub could not accept KMail '||mid||': '||reason||' Your attachments are returned.');
    end if;
    update khub_bot.receipts set result=coalesce(reason,'accepted') where mail_id=mid;
    return coalesce(reason,'accepted');
end; $$;

create or replace function public.bot_ingest_donation(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare mid text:=p_mail->>'id'; sid bigint:=(p_mail->>'sender_id')::bigint;
    meat bigint:=(p_mail->>'meat')::bigint; attachments jsonb:=p_mail->'items';
    gift boolean:=p_mail#>>'{raw,type}'='giftshop'; help boolean;
begin
    perform pg_advisory_xact_lock(3888760);
    if mid is null or mid!~'^[1-9][0-9]*$' or sid is null or sid<=0 or sid=3888760
       or p_mail#>>'{raw,type}' is null or p_mail#>>'{raw,type}' not in ('normal','giftshop')
       or p_mail#>>'{command,type}' is distinct from 'donation'
       or meat is null or meat<0 or meat>9007199254740991
       or jsonb_typeof(attachments) is distinct from 'array' then
        raise exception 'Invalid normalized donation KMail.';
    end if;
    if gift and (meat<>0 or attachments<>'[]'::jsonb) then
        raise exception 'Gift contents must stay unopened.';
    end if;
    if exists(select 1 from jsonb_array_elements(attachments) x where (x->>'id') is null or (x->>'quantity') is null
        or (x->>'id')::integer<=0 or (x->>'quantity')::bigint<=0 or (x->>'quantity')::bigint>5000000000) then
        raise exception 'Invalid donation attachments.';
    end if;
    if exists(select 1 from khub_bot.receipts where mail_id=mid) then
        if (select payload from khub_bot.receipts where mail_id=mid) <> p_mail then
            raise exception 'KMail ID payload changed; reconcile before continuing.';
        end if;
        return 'duplicate';
    end if;
    if not gift and coalesce(p_mail#>>'{raw,message}','') !~* '^[[:space:]]*DONATE[[:space:]]*(<|$)' then
        raise exception 'Normal donations require DONATE. Refund blank or invalid funded mail through bot_ingest_mail.';
    end if;
    help:=not gift and meat=0 and jsonb_array_length(attachments)=0;
    insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result)
        values(mid,sid,(p_mail->>'received_at')::timestamptz,p_mail,case when help then 'donation_help' else 'donation' end);
    perform khub_bot.queue((case when help then 'donation-help:' else 'donation-thanks:' end)||mid,
        null,mid,sid,'notice',0,'[]',case when help then 'How to donate' else 'Thank you for your donation! Your support helps keep kHub running.' end);
    return 'accepted';
end; $$;

create or replace function khub_bot.finish_listing(p_id uuid,p_reason text) returns void
language plpgsql set search_path='' as $$
declare a public.auctions%rowtype; fee bigint; outcome text;
begin
    select * into a from public.auctions where id=p_id for update;
    if not found or not a.escrow_mode or a.status<>'active' then return; end if;
    if p_reason='deadline' and a.end_time>clock_timestamp() then return; end if;
    if p_reason='cancel' and a.highest_bidder_id is not null then raise exception 'An auction with bids cannot be cancelled.'; end if;
    outcome:=case when p_reason='cancel' then 'cancelled' when a.highest_bidder_id is null then 'ended_no_bids' else 'completed' end;
    fee:=case when outcome='completed' then floor(a.current_bid::numeric*a.fee_bps/10000)::bigint else 0 end;
    update public.auctions set status='settling',settlement_outcome=outcome,fee_meat=fee,
        finalized_at=clock_timestamp(),winner_id=case when outcome='completed' then highest_bidder_id end,
        winner_username=case when outcome='completed' then highest_bidder_username end,
        final_price=case when outcome='completed' then current_bid end,
        instant_purchased_at=case when p_reason='instant' then clock_timestamp() end
    where id=p_id;
    if outcome='completed' then
        perform khub_bot.queue('sale-item:'||p_id,p_id,null,a.highest_bidder_kol_id,'sale_item',0,
            jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',a.quantity)),'Auction '||p_id||': your winning item(s).');
        if a.current_bid-fee>0 then
            perform khub_bot.queue('sale-meat:'||p_id,p_id,null,a.seller_kol_id,'sale_meat',a.current_bid-fee,'[]',
                'Auction '||p_id||': seller payment; fee '||fee||' Meat.');
        end if;
    else
        perform khub_bot.queue('return-item:'||p_id,p_id,null,a.seller_kol_id,'return_item',0,
            jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',a.quantity)),'Auction '||p_id||': returning your item(s), '||outcome||'.');
    end if;
end; $$;

create or replace function khub_bot.friendly_reason(p_reason text) returns text
language sql immutable set search_path='' as $$
select case p_reason
    when 'Verification code is invalid or expired.' then 'Your verification code has expired or is incorrect. Get a new code from Your Account and try again.'
    when 'Verification must not contain items or Meat.' then 'Please send your verification code without Meat or items.'
    when 'This KoL player is already linked or is the bot.' then 'This KoL account cannot be linked to this website account. Please contact support if you need help.'
    when 'Website account is already linked.' then 'Your website account is already linked to a KoL account.'
    when 'Unknown escrow auction ID.' then 'We could not find that auction. Please copy the command from its listing page.'
    when 'Link your KoL account on the website before sending deposits or bids.' then 'Please link your KoL account on the website before listing or bidding.'
    when 'Only the listing seller can deposit its items.' then 'Please send the item deposit from the seller''s linked KoL account.'
    when 'This listing is not waiting for a deposit.' then 'This auction is not accepting an item deposit.'
    when 'The listing deadline has passed.' then 'The deadline for this auction has passed.'
    when 'Send exactly the listed item and quantity, with no Meat or extra items.' then 'Please attach exactly the listed items and quantity, without Meat or extra items.'
    when 'Bidding is closed.' then 'This auction is no longer accepting bids.'
    when 'Sellers cannot bid on their own auction.' then 'You cannot bid on your own auction.'
    when 'Bids must contain Meat only, without items.' then 'Please send bids with Meat only, without items.'
    when 'This listing has no instant purchase price.' then 'This auction does not offer Instant Purchase. You can place a regular bid instead.'
    when 'Send the full bid, meeting the minimum and exceeding the current bid, up to 20 billion Meat.' then 'Please check the current price and send your full bid. It must meet the minimum and exceed the current bid.'
    when 'Send the full bid, meeting the minimum and exceeding the current bid.' then 'Please check the current price and send your full bid. It must meet the minimum and exceed the current bid.'
    when 'The attached Meat does not meet the instant purchase price.' then 'Please attach the full Instant Purchase Price shown on the listing.'
    when 'Unknown command. Use VERIFY <code>, LIST <auction-id>, BID <auction-id>, or BUY <auction-id>.' then 'Invalid command. Please copy the correct KMail command from the website and try again. For donations, send DONATE or a gift package.'
    else 'We could not process your request. Please check the listing or contact support.'
end;
$$;

notify pgrst,'reload schema';
commit;
