-- Apply after 017. Template-only change; safe to rerun.
-- Existing sent/claimed messages retain their frozen bodies and reference markers.
-- New messages keep Auction # above the item without decorative dash underlines.
begin;

create or replace function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare a public.auctions%rowtype; details text:=''; reason text; amount text; proceeds bigint; previous_bid bigint; commission text;
begin
    if d.auction_id is not null then
        select * into a from public.auctions where id=d.auction_id;
        details:=E'\n\nAuction #'||a.auction_number||E'\n'||a.item||' × '||a.quantity;
    end if;
    if d.dedupe_key like 'policy-refund:%' then
        return E'Request not accepted\n\nInvalid command. Your previous message was incorrectly treated as a donation. Your attached Meat or items are being returned with this message or in separate messages.\n\nFor donations, send DONATE or a gift package.';
    elsif d.dedupe_key like 'donation-help:%' then
        return E'How to donate\n\nSend a normal KMail to kHub with DONATE as the message and attach the Meat or items you would like to donate.\n\nGift packages are also accepted as donations. Thank you for supporting kHub!';
    elsif d.dedupe_key like 'donation-thanks:%' then
        return $donation$Thanks so much for pitching in, we really appreciate your support! It’s players like you who make projects like kHub possible.

Rest assured, 100% of your donation will go toward keeping kHub running. Except for the part we spend on booze. That’s a business expense.$donation$;
    elsif d.kind='sale_item' then
        return 'You won!'||details||E'\n\nYour auction winnings are attached. Thank you for using kHub.';
    elsif d.kind='sale_meat' then
        proceeds:=a.final_price-a.fee_meat;
        commission:=rtrim(rtrim(to_char(a.fee_bps::numeric/100,'FM990.00'),'0'),'.');
        return 'Your auction has sold!'||details
            ||E'\n\nSale Price: '||to_char(a.final_price,'FM999,999,999,999,999,999,990')||' Meat'
            ||E'\nCommission ('||commission||'%): '||to_char(a.fee_meat,'FM999,999,999,999,999,999,990')||' Meat'
            ||E'\nYour Proceeds: '||to_char(proceeds,'FM999,999,999,999,999,999,990')||' Meat'
            ||case when d.meat<proceeds then E'\nAttached in this message: '||to_char(d.meat,'FM999,999,999,999,999,999,990')
                ||E' Meat (your proceeds are split across multiple messages).\n\nThis portion of your proceeds is attached. Enjoy!'
                else E'\n\nYour proceeds are attached. Enjoy!' end
            ||E'\nThanks for using kHub. We hope to see you again soon!';
    elsif d.kind='return_item' then
        return case when a.settlement_outcome='cancelled' then 'Auction cancelled' else 'Auction ended without bids' end
            ||details||E'\n\nYour items are attached and have been returned to you.';
    elsif d.dedupe_key like 'verified:%' then
        return E'Account linked\n\nYour KoL account is now linked to kHub. You can start listing items and bidding.';
    elsif d.dedupe_key like 'activated:%' then
        return 'Your auction is live'||details||E'\n\nWe have received your items and are holding them safely until the auction ends.';
    elsif d.dedupe_key like 'bid-accepted:%' then
        -- Original accepted amount is frozen in the ledger, unlike the current high bid.
        amount:=substring(d.message from 'funded bid of ([0-9]+) Meat');
        if amount is null then raise exception 'Accepted bid amount missing; inspect delivery before sending.'; end if;
        return 'Bid accepted'||details||E'\n\nYour bid of '||to_char(amount::bigint,'FM999,999,999,999,999,999,990')||' Meat was accepted. We are holding your bid in escrow.';
    elsif d.dedupe_key like 'outbid:%' then
        select sum(x.meat) into previous_bid from khub_bot.deliveries x
            where x.receipt_id=d.receipt_id and x.recipient_id=d.recipient_id and x.dedupe_key like 'outbid:%';
        return 'You’ve been outbid!'||details
            ||case when previous_bid>d.meat then E'\n\nYour previous bid has been returned in full across multiple messages. This message contains '
                ||to_char(d.meat,'FM999,999,999,999,999,999,990')||' Meat.'
                else E'\n\nYour previous bid is attached and has been returned in full.' end;
    elsif d.dedupe_key like 'excess:%' then
        return 'Extra Meat returned'||details||E'\n\nYour purchase was accepted at the Instant Purchase Price. The extra Meat you sent is attached.';
    elsif d.dedupe_key like 'rejected:%' then
        select r.result into reason from khub_bot.receipts r where r.mail_id=d.receipt_id;
        return E'Request not accepted\n\n'||khub_bot.friendly_reason(reason)
            ||case when exists(select 1 from khub_bot.deliveries x where x.receipt_id=d.receipt_id and (x.meat>0 or x.quantity>0))
                then E'\n\nYour attached Meat or items are being returned with this message or in separate messages.' else '' end;
    end if;
    -- Unknown/custom ledger messages must be reviewed, never silently prettified.
    raise exception 'Unrecognized delivery template; inspect delivery before sending.';
end; $$;

notify pgrst,'reload schema';
commit;
