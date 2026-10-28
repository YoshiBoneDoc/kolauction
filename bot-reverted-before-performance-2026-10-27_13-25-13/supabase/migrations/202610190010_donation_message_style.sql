-- Apply once after 009. Stop the bot, apply this migration, then deploy the updated worker.
-- Existing sent/uncertain messages remain untouched; new donations use the updated thank-you.
begin;
alter table khub_bot.deliveries add column display_footer text;

create or replace function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare a public.auctions%rowtype; details text:=''; reason text; amount text;
begin
    if d.auction_id is not null then
        select * into a from public.auctions where id=d.auction_id;
        details:=E'\n\n'||a.item||' × '||a.quantity||E'\nAuction #'||a.auction_number;
    end if;
    if d.dedupe_key like 'donation-help:%' then
        return E'How to donate\n\nSend a normal KMail to kHub with DONATE as the message and attach the Meat or items you would like to donate.\n\nGift packages are also accepted as donations. Thank you for supporting kHub!';
    elsif d.dedupe_key like 'donation-thanks:%' then
        return $donation$~ * ~ Thank you for supporting kHub ~ * ~

It’s support from players like you that makes projects like this possible. We really appreciate you pitching in!

Rest assured, 100% of your donation will go toward keeping kHub running. Except for the part we spend on booze. That’s a business expense.$donation$;
    elsif d.kind='sale_item' then
        return 'You won!'||details||E'\n\nYour auction winnings are attached. Thank you for using kHub.';
    elsif d.kind='sale_meat' then
        return 'Your auction sold'||details||E'\n\nYour payment is attached.'
            ||case when a.fee_meat>0 then E'\nTotal seller fee: '||to_char(a.fee_meat,'FM999,999,999,999,999,999,990')||' Meat.' else '' end;
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
        return 'Your previous bid has been returned'||details
            ||E'\n\nYour previous bid is being returned. Please see the attached Meat.';
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

create or replace function public.bot_claim_delivery(p_message_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; begin
    if p_message_version is distinct from 2 then raise exception 'Update the bot to message format version 2 before sending.'; end if;
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.deliveries where state in ('sending','unknown')) then raise exception 'Uncertain delivery requires reconciliation. No automatic resend.'; end if;
    select * into d from khub_bot.deliveries where state='pending' order by created_at,id limit 1 for update;
    if not found then return null; end if;
    update khub_bot.deliveries set state='sending',attempt=gen_random_uuid(),
        -- Freeze the footer with the body. Previously claimed deliveries retain their exact text.
        display_footer=case when display_message is null and dedupe_key like 'donation-thanks:%'
            then $footer$If this donation was sent in error, please KMail teres minor (#3552305) with the reference ID above.$footer$ else display_footer end,
        display_message=coalesce(display_message,khub_bot.friendly_message(d))
        where id=d.id returning * into d;
    return khub_bot.delivery_details(d);
end; $$;

notify pgrst,'reload schema';
commit;
