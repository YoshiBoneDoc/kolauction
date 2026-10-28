-- Apply after 059. Message wording only: no financial obligations, delivery
-- states, deduplication keys or previously saved message bodies are changed.
-- Templates freeze on first claim; retries retain their exact saved text.
begin;

create or replace function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare a public.auctions%rowtype; details text:=''; reason text; amount text; proceeds bigint; previous_bid bigint; commission text; raised_own_bid boolean;
begin
    if d.auction_id is not null then
        select * into a from public.auctions where id=d.auction_id;
        details:=E'\n\nAuction #'||a.auction_number||E'\n'||khub_bot.escape_report_kmail(a.item)||' × '||khub_bot.format_message_number(a.quantity);
    end if;
    if d.dedupe_key like 'policy-refund:%' then
        return E'Request not accepted\n\nInvalid command. Your previous message was incorrectly treated as a donation. Your attached Meat or items are being returned with this message or in separate messages.\n\nFor donations, send DONATE or a gift package.';
    elsif d.dedupe_key like 'donation-help:%' then
        return E'How to donate\n\nSend a normal KMail to kHub with DONATE as the message and attach the Meat or items you would like to donate.\n\nGift packages are also accepted as donations. Thank you for supporting kHub!';
    elsif d.dedupe_key like 'donation-thanks:%' then
        return $donation$Thanks so much for pitching in, we really appreciate your support! It’s players like you who make projects like kHub possible.

Rest assured, 100% of your donation will go toward keeping kHub running. Except for the part we spend on booze. That’s a business expense.$donation$;
    elsif d.kind='sale_item' then
        return 'You won!'||details||case when d.quantity<a.quantity then E'\n\nAttached in this message: '||khub_bot.format_message_number(d.quantity)||' × '||khub_bot.escape_report_kmail(a.item)||'. Your winnings are split across multiple messages.' else E'\n\nYour auction winnings are attached.' end||E'\nThank you for using kHub.';
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
            ||details||case when d.quantity<a.quantity then E'\n\nAttached in this message: '||khub_bot.format_message_number(d.quantity)||' × '||khub_bot.escape_report_kmail(a.item)||'. Your item return is split across multiple messages.' else E'\n\nYour deposited items are attached.' end;
    elsif d.dedupe_key like 'verified:%' then
        return E'Account linked\n\nYour KoL account is now linked to kHub. You can start listing items and bidding.';
    elsif d.dedupe_key like 'activated:%' then
        return 'Your auction opened'||details||E'\n\nYour item deposit was accepted and bidding opened. Check the auction page for its current status.';
    elsif d.dedupe_key like 'bid-accepted:%' then
        -- Original accepted amount is frozen in the ledger, unlike the current high bid.
        amount:=substring(d.message from 'funded bid of ([0-9]+) Meat');
        if amount is null then raise exception 'Accepted bid amount missing; inspect delivery before sending.'; end if;
        return 'Bid accepted'||details||E'\n\nYour bid of '||to_char(amount::bigint,'FM999,999,999,999,999,999,990')||' Meat was accepted and funded in escrow. Check the auction page for the current leading bid and status.';
    elsif d.dedupe_key like 'outbid:%' then
        select sum(x.meat) into previous_bid from khub_bot.deliveries x
            where x.receipt_id=d.receipt_id and x.recipient_id=d.recipient_id and x.dedupe_key like 'outbid:%';
        select r.sender_id=d.recipient_id into raised_own_bid from khub_bot.receipts r where r.mail_id=d.receipt_id;
        return case when raised_own_bid then 'Previous bid returned' else 'You’ve been outbid!' end||details
            ||case when previous_bid>d.meat then E'\n\nYour previous bid is being returned across multiple messages. This message contains '
                ||to_char(d.meat,'FM999,999,999,999,999,999,990')||' Meat.'
                else E'\n\nYour previous bid is attached and has been returned in full.' end;
    elsif d.dedupe_key like 'excess:%' then
        return 'Extra Meat returned'||details||E'\n\nYour purchase was accepted at the buyout price. The extra Meat is being returned with this message or in separate messages.';
    elsif d.dedupe_key like 'rejected:%' then
        select r.result into reason from khub_bot.receipts r where r.mail_id=d.receipt_id;
        return E'Request not accepted\n\n'||khub_bot.friendly_reason(reason)
            ||case when exists(select 1 from khub_bot.deliveries x where x.receipt_id=d.receipt_id and (x.meat>0 or x.quantity>0))
                then E'\n\nYour attached Meat or items are being returned with this message or in separate messages.' else '' end;
    end if;
    -- Unknown/custom ledger messages must be reviewed, never silently prettified.
    raise exception 'Unrecognized delivery template; inspect delivery before sending.';
end; $$;

-- Translate newer rejection reasons without changing intake validation or the
-- exact tiered minimum supplied by migration 053.
create or replace function khub_bot.friendly_reason(p_reason text) returns text
language sql immutable set search_path='' as $$
    select case
        when p_reason ~ '^Send your full bid of at least [0-9][0-9,]* Meat[.] Bid increases depend on the current highest bid[.]$'
            or p_reason='The maximum supported bid has been reached.' then p_reason
        when p_reason='This listing has no instant purchase price.' then 'This auction has no buyout price. You can place a regular bid instead.'
        when p_reason='The attached Meat does not meet the instant purchase price.' then 'Please attach the full buyout price shown on the auction page.'
        when p_reason='Bidding and deposits are closed for this restricted seller.' then 'This seller is restricted. The auction is not accepting new bids or item deposits.'
        when p_reason='Link your KoL account on the website before sending deposits or bids.' then 'Register a kHub account from this KoL character before sending item deposits or bids. See the registration page for instructions.'
        when p_reason='Verification code is invalid or expired.' then 'Your verification code has expired or is incorrect. Open your account page using your username in the navigation bar to request a new code.'
        else khub_bot.friendly_reason_before_bid_increments(p_reason) end;
$$;

-- Change text-only fragments in existing functions, retaining their grants,
-- layered guards and retry behavior. Abort if a required fragment has changed.
do $$
declare patch record; definition text;
begin
    for patch in select * from (values
        ('public.bot_finish_account_job(text)',
            'You can change this password from Your Account.',
            'Change this temporary password after logging in: click your username in the navigation bar, then select Change password.'),
        ('public.bot_finish_account_job(text)',
            $text$||login
        ||case$text$,
            $text$||khub_bot.escape_report_kmail(login)
        ||case$text$),
        ('public.bot_finish_account_job(text)',
            $text$else E'\nLegacy email login: '||j.login_email end$text$,
            $text$else E'\nLegacy email login: '||khub_bot.escape_report_kmail(j.login_email) end$text$),
        ('public.bot_prepare_account_mail(jsonb,text)',
            'Your attachments are returned. ', ''),
        ('public.bot_ingest_mail(jsonb)',
            'Your attached assets are returned. ', ''),
        ('khub_bot.account_reply(jsonb,text,text)',
            $text$begin
    insert into khub_bot.receipts$text$,
            $text$begin
    if (p_mail->>'meat')::bigint>0 or jsonb_array_length(p_mail->'items')>0 then
        p_body:=p_body||E'\n\nYour attached Meat or items are being returned with this message or in separate messages.';
    end if;
    insert into khub_bot.receipts$text$),
        ('khub_bot.queue_rating_notice(uuid,uuid)',
            'they reported that you did not complete your side of the exchange.',
            'they reported that you failed to honor the trade.'),
        ('khub_bot.queue_rating_notice(uuid,uuid)',
            'The sale completes once both parties confirm completion.',
            'A direct trade counts as complete only after both parties confirm completion.'),
        ('khub_bot.queue_rating_notice(uuid,uuid)',
            'View this auction and your profile on kHub for the current status and rating totals.',
            'This notice records their response when submitted. View the auction page on kHub for the current trade status.')
    ) as changes(signature,old_text,new_text)
    loop
        definition:=pg_get_functiondef(patch.signature::regprocedure);
        if strpos(definition,patch.old_text)=0 then
            raise exception 'Unexpected message template for %; migration not applied.',patch.signature;
        end if;
        execute replace(definition,patch.old_text,patch.new_text);
    end loop;
end; $$;

revoke all on function khub_bot.friendly_reason(text) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
