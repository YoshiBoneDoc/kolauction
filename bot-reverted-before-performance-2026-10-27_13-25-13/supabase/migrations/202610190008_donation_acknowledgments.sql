-- Run once after 007 with all bots stopped. Packages remain unopened/undeleted.
begin;

create function public.bot_ingest_donation(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare mid text:=p_mail->>'id'; sid bigint:=(p_mail->>'sender_id')::bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    if mid is null or mid!~'^[1-9][0-9]*$' or sid is null or sid<=0 or sid=3888760
       or p_mail#>>'{raw,type}' is distinct from 'giftshop'
       or p_mail#>>'{command,type}' is distinct from 'donation'
       or p_mail->'meat' is distinct from '0'::jsonb
       or p_mail->'items' is distinct from '[]'::jsonb then
        raise exception 'Invalid normalized donation KMail.';
    end if;
    if exists(select 1 from khub_bot.receipts where mail_id=mid) then
        if (select payload from khub_bot.receipts where mail_id=mid) <> p_mail then
            raise exception 'KMail ID payload changed; reconcile before continuing.';
        end if;
        return 'duplicate';
    end if;
    insert into khub_bot.receipts(mail_id,sender_id,received_at,payload,result)
        values(mid,sid,(p_mail->>'received_at')::timestamptz,p_mail,'donation');
    perform khub_bot.queue('donation-thanks:'||mid,null,mid,sid,'notice',0,'[]',
        'Thank you for your donation! Your support helps keep kHub running.');
    return 'accepted';
end; $$;

create or replace function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare a public.auctions%rowtype; details text:=''; reason text; amount text;
begin
    if d.auction_id is not null then
        select * into a from public.auctions where id=d.auction_id;
        details:=E'\n\n'||a.item||' × '||a.quantity||E'\nAuction #'||a.auction_number;
    end if;
    if d.dedupe_key like 'donation-thanks:%' then
        return E'Thank you for your donation!\n\nYour support helps keep kHub running.';
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

revoke all on function public.bot_ingest_donation(jsonb) from public,anon,authenticated;
grant execute on function public.bot_ingest_donation(jsonb) to service_role;
notify pgrst,'reload schema';
commit;
