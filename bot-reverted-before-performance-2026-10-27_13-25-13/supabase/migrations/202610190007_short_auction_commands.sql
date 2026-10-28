-- Run once AFTER 202610190006_friendly_bot_messages.sql, with all bots stopped.
-- Accept short website auction numbers as well as existing UUID commands.
begin;

create or replace function public.bot_ingest_mail(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare mid text:=p_mail->>'id'; sid bigint:=(p_mail->>'sender_id')::bigint;
    meat bigint:=(p_mail->>'meat')::bigint; attachments jsonb:=p_mail->'items';
    cmd text:=p_mail#>>'{command,type}'; aid uuid; a public.auctions%rowtype; u public.profiles%rowtype;
    tok khub_bot.verifications%rowtype; reason text; accepted bigint; old_sender bigint; old_bid bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    if mid is null or mid!~'^[1-9][0-9]*$' or sid is null or sid<=0 or sid=3888760 or meat is null or meat<0 or meat>20000000000
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
            elsif meat<a.min_bid_meat or meat<=a.current_bid or meat>20000000000 then reason:='Send the full bid, meeting the minimum and exceeding the current bid, up to 20 billion Meat.';
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

revoke all on function public.bot_ingest_mail(jsonb) from public,anon,authenticated;
grant execute on function public.bot_ingest_mail(jsonb) to service_role;
notify pgrst,'reload schema';
commit;
