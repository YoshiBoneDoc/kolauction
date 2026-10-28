-- Apply after 040. Format generated amounts and quantities with fixed English commas.
-- Keep identifiers, raw ledger/attachment values and existing frozen messages unchanged.
begin;
create function khub_bot.format_message_number(p_value bigint) returns text
language sql immutable strict set search_path='' as $$
    select to_char(p_value,'FM999,999,999,999,999,999,990');
$$;
revoke all on function khub_bot.format_message_number(bigint) from public,anon,authenticated;

create or replace function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare a public.auctions%rowtype; details text:=''; reason text; amount text; proceeds bigint; previous_bid bigint; commission text;
begin
    if d.auction_id is not null then
        select * into a from public.auctions where id=d.auction_id;
        details:=E'\n\nAuction #'||a.auction_number||E'\n'||a.item||' × '||khub_bot.format_message_number(a.quantity);
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

create or replace function khub_bot.queue_rating_notice(p_auction uuid,p_actor uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype; recipient public.profiles%rowtype; actor_name text;
    v_positive boolean; v_role text; delivery uuid; body text;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction;
    if a.id is null or a.escrow_mode or a.finalized_at is null or a.winner_id is null
        or a.seller_id=a.winner_id or a.status not in ('awaiting_trade','completed')
        or p_actor is null or p_actor not in (a.seller_id,a.winner_id) then return null; end if;
    v_positive:=case when p_actor=a.seller_id then a.seller_confirmed_at is not null else a.buyer_confirmed_at is not null end;
    if not v_positive and not exists(select 1 from khub_bot.trade_reports t
        where t.auction_id=a.id and t.reporter_id=p_actor and t.counts_negative and t.withdrawn_at is null) then return null; end if;
    select delivery_id into delivery from khub_bot.rating_notifications where auction_id=a.id and actor_id=p_actor and positive=v_positive;
    if found then return delivery; end if;
    select * into recipient from public.profiles where id=case when p_actor=a.seller_id then a.winner_id else a.seller_id end;
    -- Never guess a recipient number from a username or send to an unverified identity.
    if recipient.kol_player_id is null or recipient.kol_verified_at is null then return null; end if;
    select khub_username into actor_name from public.profiles where id=p_actor;
    v_role:=case when p_actor=a.seller_id then 'buyer' else 'seller' end;
    body:='Auction #'||coalesce(a.auction_number::text,a.id::text)
        ||E'\n'||khub_bot.format_message_number(a.quantity)||' x '||khub_bot.escape_report_kmail(left(a.item,80))
        ||E'\nAgreed total: '||khub_bot.format_message_number(a.final_price)||' Meat'
        ||E'\n\n'||khub_bot.escape_report_kmail(actor_name)
        ||case when v_positive then ' marked the trade Confirmed Complete: they received your side of the exchange.'
            else ' marked the trade Reported Incomplete: they reported that you did not complete your side of the exchange.' end
        ||E'\n\nThis records trade completion only and does not change your feedback score.'
        ||case when v_positive then E'\nThe sale completes once both parties confirm completion.'
            else E'\nPlease contact the other party to resolve the issue. They can use Mark Trade Complete on the auction page after the exchange is completed.'
                ||E'\nUse Contact an Administrator on the auction page if you need to clarify something.' end
        ||E'\n\nView this auction and your profile on kHub for the current status and rating totals.';
    insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
        values('rating-notice:'||a.id||':'||p_actor||':'||case when v_positive then 'positive' else 'negative' end,recipient.kol_player_id,'notice',body,body,'') returning id into delivery;
    insert into khub_bot.rating_notifications(auction_id,actor_id,recipient_id,positive,recipient_role,delivery_id)
        values(a.id,p_actor,recipient.id,v_positive,v_role,delivery);
    return delivery;
end; $$;

create or replace function public.submit_trade_report(p_request_id uuid,p_auction_id uuid,p_body text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    a public.auctions%rowtype; prior khub_bot.trade_reports%rowtype; actor public.profiles%rowtype; r khub_bot.bug_reports%rowtype;
    v_body text:=btrim(coalesce(p_body,''),E' \t\r\n'); stored_body text;
    parts text[]:='{}'; part text:=''; encoded text; message text; delivery uuid; i integer;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into actor from public.profiles where id=auth.uid();
    select * into a from public.auctions where id=p_auction_id for update;
    if actor.id is null or actor.kol_verified_at is null or a.id is null or a.escrow_mode
        or a.finalized_at is null or a.winner_id is null or a.seller_id=a.winner_id
        or actor.id not in (a.seller_id,a.winner_id) then
        raise exception 'Only the seller or winning buyer of a closed direct sale can report a trade.';
    end if;
    if p_request_id is null or char_length(v_body)>2000 then
        raise exception 'Keep the optional explanation within 2,000 characters.';
    end if;
    stored_body:=case when v_body='' then 'No explanation provided.' else v_body end;
    perform pg_advisory_xact_lock(hashtextextended('khub-bug-report:'||actor.id::text,0));
    select * into r from khub_bot.bug_reports where id=p_request_id;
    if found then
        if r.reporter_id<>actor.id or r.body<>stored_body or not exists(select 1 from khub_bot.trade_reports t where t.report_id=r.id and t.auction_id=a.id and t.has_explanation=(v_body<>'')) then
            raise exception 'This report request cannot be reused. Please try a new submission.';
        end if;
        return jsonb_build_object('reference','B-'||r.report_number,'notification',case when v_body='' then 'not_queued' else 'queued' end);
    end if;
    if a.status<>'awaiting_trade' then raise exception 'This trade is not awaiting settlement.'; end if;
    if (actor.id=a.seller_id and a.seller_confirmed_at is not null)
        or (actor.id=a.winner_id and a.buyer_confirmed_at is not null) then
        raise exception 'You already confirmed this trade. Contact an administrator to request a reviewed correction.';
    end if;
    select * into prior from khub_bot.trade_reports where auction_id=a.id and reporter_id=actor.id;
    if found then raise exception 'You already submitted a trade report. Contact an administrator to add information.'; end if;
    if v_body<>'' and exists(select 1 from khub_bot.bug_reports b where b.reporter_id=actor.id and b.created_at>clock_timestamp()-interval '1 minute' and not exists(select 1 from khub_bot.trade_reports t where t.report_id=b.id and not t.has_explanation)) then
        raise exception 'Please wait a minute before sending another report.';
    end if;
    if v_body<>'' and (select count(*) from khub_bot.bug_reports b where b.reporter_id=actor.id and b.created_at>clock_timestamp()-interval '1 hour' and not exists(select 1 from khub_bot.trade_reports t where t.report_id=b.id and not t.has_explanation))>=5 then
        raise exception 'You have sent several reports recently. Please try again later.';
    end if;
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category)
        values(p_request_id,actor.id,actor.khub_username,actor.kol_player_id,stored_body,'trade') returning * into r;
    insert into khub_bot.trade_reports(auction_id,reporter_id,reporter_role,report_id,has_explanation)
        values(a.id,actor.id,case when actor.id=a.seller_id then 'seller' else 'buyer' end,r.id,v_body<>'');

    -- Silent thumbs-downs are inbox records without KMail notifications.
    if v_body='' then
        return jsonb_build_object('reference','B-'||r.report_number,'notification','not_queued');
    end if;

    -- Escape user text for KoL display. Split before the transport's normal
    -- delivery marker, without cutting HTML entities or truncating the report.
    for i in 1..char_length(v_body) loop
        encoded:=khub_bot.escape_report_kmail(substr(v_body,i,1));
        if char_length(part)+char_length(encoded)>1000 then
            parts:=array_append(parts,part); part:='';
        end if;
        part:=part||encoded;
    end loop;
    parts:=array_append(parts,part);
    for i in 1..array_length(parts,1) loop
        message:='Trade report B-'||r.report_number||' ('||i||'/'||array_length(parts,1)||')'
            ||E'\nAuction #'||a.auction_number||' ('||a.id||')'
            ||E'\nAgreed total: '||khub_bot.format_message_number(a.final_price)||' Meat'
            ||E'\nFrom: '||khub_bot.escape_report_kmail(left(actor.khub_username,60))||' (#'||actor.kol_player_id||')'
            ||E'\n\n'||parts[i]||E'\n\nAdministrator inbox: /admin/inbox?category=trade';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('trade-report:'||r.id||':'||i,3552305,'notice',message,message,'') returning id into delivery;
        insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,delivery);
    end loop;
    return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
end; $$;

notify pgrst,'reload schema';
commit;
