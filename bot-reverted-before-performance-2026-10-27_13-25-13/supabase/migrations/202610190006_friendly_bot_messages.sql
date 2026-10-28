-- Run once after the previous migrations, with ALL bot processes stopped.
-- UUIDs and original ledger messages stay intact. Friendly bodies freeze on claim.
begin;

alter table public.auctions add column auction_number bigint generated always as identity (start with 1001) unique;
alter table khub_bot.deliveries
    add column reference_number bigint generated always as identity (start with 1001) unique,
    add column display_message text;
grant usage on sequence khub_bot.deliveries_reference_number_seq to service_role;

create function khub_bot.friendly_reason(p_reason text) returns text
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
    when 'Send the full bid, meeting the minimum and exceeding the current bid, up to 20 billion Meat.' then 'Please check the current price and send your full bid. It must meet the minimum, exceed the current bid, and be no more than 20 billion Meat.'
    when 'The attached Meat does not meet the instant purchase price.' then 'Please attach the full Instant Purchase Price shown on the listing.'
    when 'Unknown command. Use VERIFY <code>, LIST <auction-id>, BID <auction-id>, or BUY <auction-id>.' then 'We could not recognize your message. Please copy the KMail command from the website and try again.'
    else 'We could not process your request. Please check the listing or contact support.'
end;
$$;

create function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare a public.auctions%rowtype; details text:=''; reason text; amount text;
begin
    if d.auction_id is not null then
        select * into a from public.auctions where id=d.auction_id;
        details:=E'\n\n'||a.item||' × '||a.quantity||E'\nAuction #'||a.auction_number;
    end if;
    if d.kind='sale_item' then
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

create function khub_bot.delivery_details(d khub_bot.deliveries) returns jsonb
language sql stable set search_path='' as $$
    select to_jsonb(d)||jsonb_build_object(
        'delivery_reference','D-'||d.reference_number,
        'reference_marker',case when d.display_message is null then '[kHub delivery '||d.id||']'
            else 'Reference: D-'||d.reference_number end);
$$;

-- Require a new worker so an older transport cannot send a UUID marker while
-- the database records that the short-reference format was used.
drop function public.bot_claim_delivery();
create function public.bot_claim_delivery(p_message_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; begin
    if p_message_version is distinct from 2 then raise exception 'Update the bot to message format version 2 before sending.'; end if;
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.deliveries where state in ('sending','unknown')) then raise exception 'Uncertain delivery requires reconciliation. No automatic resend.'; end if;
    select * into d from khub_bot.deliveries where state='pending' order by created_at,id limit 1 for update;
    if not found then return null; end if;
    update khub_bot.deliveries set state='sending',attempt=gen_random_uuid(),
        display_message=coalesce(display_message,khub_bot.friendly_message(d))
        where id=d.id returning * into d;
    return khub_bot.delivery_details(d);
end; $$;

create or replace function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
    select jsonb_build_object('deliveryCounts',(select jsonb_object_agg(state,n) from (select state,count(*) n from khub_bot.deliveries group by state)s),
        'attention',(select coalesce(jsonb_agg(khub_bot.delivery_details(d)),'[]') from khub_bot.deliveries d where state in ('sending','unknown')),
        'receipts',(select count(*) from khub_bot.receipts),'settings',(select to_jsonb(s) from khub_bot.settings s where id));
$$;

create function public.bot_lookup_delivery(p_reference text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; v text:=upper(btrim(p_reference)); begin
    if v ~ '^D-[0-9]{1,19}$' then
        select * into d from khub_bot.deliveries where reference_number::numeric=substring(v from 3)::numeric;
    elsif v ~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$' then
        select * into d from khub_bot.deliveries where id=v::uuid;
    else raise exception 'Use a delivery reference such as D-1042 or a full delivery UUID.'; end if;
    if not found then raise exception 'Delivery reference not found.'; end if;
    return khub_bot.delivery_details(d);
end; $$;

revoke all on function khub_bot.friendly_reason(text),khub_bot.friendly_message(khub_bot.deliveries),khub_bot.delivery_details(khub_bot.deliveries) from public,anon,authenticated;
revoke all on function public.bot_lookup_delivery(text) from public,anon,authenticated;
grant execute on function public.bot_lookup_delivery(text) to service_role;
revoke all on function public.bot_claim_delivery(integer) from public,anon,authenticated;
grant execute on function public.bot_claim_delivery(integer) to service_role;
notify pgrst,'reload schema';
commit;
