-- Apply after 014 with all workers stopped, then restart the matching worker.
-- Normal mail needs an explicit DONATE command; gift-shop packages remain donations.
-- Legacy implicit donations are held for safe refund, never blindly moved/withdrawn.
begin;
create table khub_bot.mail_policy_reviews (
    receipt_id text primary key references khub_bot.receipts(mail_id),
    reason text not null, refund_queued boolean not null default false,
    created_at timestamptz not null default clock_timestamp(), queued_at timestamptz
);
alter table khub_bot.mail_policy_reviews enable row level security;
grant all on khub_bot.mail_policy_reviews to service_role;
insert into khub_bot.mail_policy_reviews(receipt_id,reason)
    select r.mail_id,'Normal mail was incorrectly accepted as a donation without DONATE.'
    from khub_bot.receipts r where r.result='donation' and r.payload#>>'{raw,type}'='normal'
    and coalesce(r.payload#>>'{raw,message}','') !~* '^[[:space:]]*DONATE[[:space:]]*(<|$)';

-- Only unattempted support notices/closet plans may be cancelled. Unknown writes
-- retain their original evidence and require normal operator reconciliation.
alter table khub_bot.deliveries drop constraint deliveries_state_check;
alter table khub_bot.deliveries add constraint deliveries_state_check
    check (state in ('pending','sending','sent','unknown','cancelled'));
alter table khub_bot.deliveries add constraint delivery_cancelled_notice_only
    check (state<>'cancelled' or (kind='notice' and meat=0 and quantity=0));
alter table khub_bot.closet_transfers drop constraint closet_transfers_state_check;
alter table khub_bot.closet_transfers add constraint closet_transfers_state_check
    check (state in ('pending','moving','moved','unknown','cancelled'));

create function khub_bot.suppress_previous_donation_plans() returns void
language sql set search_path='' as $$
    update khub_bot.deliveries d set state='cancelled',evidence='Implicit donation policy corrected; do not send this unattempted thank-you.'
    where d.state='pending' and d.kind='notice' and d.meat=0 and d.quantity=0
      and d.dedupe_key like 'donation-thanks:%'
      and exists(select 1 from khub_bot.mail_policy_reviews r where r.receipt_id=d.receipt_id);
    update khub_bot.closet_transfers c set state='cancelled',evidence='Implicit donation policy corrected; assets are due back to sender.'
    where c.state='pending' and exists(select 1 from khub_bot.mail_policy_reviews r where r.receipt_id=c.receipt_id);
$$;
select khub_bot.suppress_previous_donation_plans();

-- Preserve original payloads. A newly normalized blank/invalid request may match
-- an old implicit donation except for its command classification.
alter function public.bot_ingest_mail(jsonb) set schema khub_bot;
alter function khub_bot.bot_ingest_mail(jsonb) rename to ingest_mail_before_invalid_refunds;
create function public.bot_ingest_mail(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if p_mail#>>'{command,type}'='unknown' and exists(
        select 1 from khub_bot.receipts r join khub_bot.mail_policy_reviews v on v.receipt_id=r.mail_id
        where r.mail_id=p_mail->>'id' and r.payload-'command'=p_mail-'command') then
        if (select refund_queued from khub_bot.mail_policy_reviews where receipt_id=p_mail->>'id') then return 'duplicate'; end if;
        return 'previous_donation_review';
    end if;
    return khub_bot.ingest_mail_before_invalid_refunds(p_mail);
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
       or meat is null or meat<0 or meat>20000000000
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

create or replace function public.bot_liabilities() returns jsonb language sql security definer set search_path='' as $$
    with holdings as (
        select item_id,quantity,0::bigint meat from public.auctions where escrow_mode and status='active' and item_escrowed_at is not null
        union all select null,0,current_bid from public.auctions where escrow_mode and status='active'
        union all select item_id,quantity,meat from khub_bot.deliveries where state not in ('sent','cancelled')
        union all select null,0,(r.payload->>'meat')::bigint
            from khub_bot.receipts r join khub_bot.mail_policy_reviews v on v.receipt_id=r.mail_id where not v.refund_queued
        union all select (x->>'id')::integer,(x->>'quantity')::bigint,0
            from khub_bot.receipts r join khub_bot.mail_policy_reviews v on v.receipt_id=r.mail_id
            cross join lateral jsonb_array_elements(r.payload->'items') x where not v.refund_queued
    ), items as (select item_id,sum(quantity) quantity from holdings where item_id is not null group by item_id)
    select jsonb_build_object('meat',(select coalesce(sum(meat),0)::text from holdings),
        'items',coalesce((select jsonb_object_agg(item_id,quantity::text) from items),'{}'));
$$;

create function public.bot_queue_previous_donation_refunds(p_snapshot jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare held jsonb; x record; r khub_bot.receipts%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.deliveries where state in ('sending','unknown'))
       or exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown')) then
        raise exception 'Reconcile uncertain operations before returning previously misclassified mail.';
    end if;
    perform khub_bot.suppress_previous_donation_plans();
    held:=public.bot_liabilities();
    if coalesce((p_snapshot->>'meat')::bigint,-1)<(held->>'meat')::bigint then
        raise exception 'Previous donation refunds need their Meat in inventory, in addition to all other escrow obligations.';
    end if;
    for x in select * from jsonb_each_text(held->'items') loop
        if coalesce((p_snapshot#>>array['items',x.key])::bigint,0)<x.value::bigint then
            raise exception 'Previous donation refunds need item #% in inventory; reconcile/withdraw closeted assets manually first.',x.key;
        end if;
    end loop;
    for r in select a.* from khub_bot.receipts a join khub_bot.mail_policy_reviews v on v.receipt_id=a.mail_id
        where not v.refund_queued order by a.mail_id for update of v
    loop
        perform khub_bot.queue('policy-refund:'||r.mail_id,null,r.mail_id,r.sender_id,'refund',
            (r.payload->>'meat')::bigint,r.payload->'items','Invalid command: returning previously misclassified donation.');
        update khub_bot.mail_policy_reviews set refund_queued=true,queued_at=clock_timestamp() where receipt_id=r.mail_id;
    end loop;
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
    when 'Send the full bid, meeting the minimum and exceeding the current bid, up to 20 billion Meat.' then 'Please check the current price and send your full bid. It must meet the minimum, exceed the current bid, and be no more than 20 billion Meat.'
    when 'The attached Meat does not meet the instant purchase price.' then 'Please attach the full Instant Purchase Price shown on the listing.'
    when 'Unknown command. Use VERIFY <code>, LIST <auction-id>, BID <auction-id>, or BUY <auction-id>.' then 'Invalid command. Please copy the correct KMail command from the website and try again. For donations, send DONATE or a gift package.'
    else 'We could not process your request. Please check the listing or contact support.'
end;
$$;

create or replace function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare a public.auctions%rowtype; details text:=''; reason text; amount text; proceeds bigint; previous_bid bigint; commission text;
begin
    if d.auction_id is not null then
        select * into a from public.auctions where id=d.auction_id;
        details:=E'\n\nAuction #'||a.auction_number||E'\n'||repeat('-',length('Auction #'||a.auction_number))||E'\n'||a.item||' × '||a.quantity;
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

create or replace function public.bot_claim_delivery(p_message_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; begin
    if p_message_version is distinct from 2 then raise exception 'Update the bot to message format version 2 before sending.'; end if;
    perform pg_advisory_xact_lock(3888760);
    perform khub_bot.suppress_previous_donation_plans();
    if exists(select 1 from khub_bot.deliveries where state in ('sending','unknown')) then raise exception 'Uncertain delivery requires reconciliation. No automatic resend.'; end if;
    if exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown')) then raise exception 'Uncertain closet transfer requires reconciliation.'; end if;
    select * into d from khub_bot.deliveries where state='pending' order by created_at,id limit 1 for update;
    if not found then return null; end if;
    update khub_bot.deliveries set state='sending',attempt=gen_random_uuid(),
        -- Freeze the footer with the body. Previously claimed deliveries retain their exact text.
        display_footer=case when display_message is null and dedupe_key like 'donation-thanks:%'
            then $footer$
*If this donation was sent in error, please KMail teres minor (#3552305) with the reference ID above.$footer$ else display_footer end,
        display_message=coalesce(display_message,khub_bot.friendly_message(d))
        where id=d.id returning * into d;
    return khub_bot.delivery_details(d);
end; $$;

create or replace function public.bot_claim_closet_transfer(p_snapshot jsonb,p_reserve bigint,p_review_meat bigint,p_review_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d khub_bot.closet_transfers%rowtype; liabilities jsonb; inv bigint; held bigint; amount bigint; closet bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    perform khub_bot.suppress_previous_donation_plans();
    if p_reserve is null or p_reserve<0 or p_review_meat is null or p_review_meat<0 then raise exception 'Invalid protected Meat.'; end if;
    if exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown'))
       or exists(select 1 from khub_bot.deliveries where state in ('sending','unknown')) then
        raise exception 'Resolve uncertain operations before moving assets.';
    end if;
    select * into d from khub_bot.closet_transfers where state='pending' order by created_at,id limit 1 for update;
    if not found then return null; end if;
    liabilities:=public.bot_liabilities();
    if d.item_id is null then
        inv:=(p_snapshot->>'meat')::bigint; closet:=(p_snapshot->>'closetMeat')::bigint;
        held:=(liabilities->>'meat')::bigint+p_reserve+p_review_meat; amount:=d.meat;
    else
        inv:=coalesce((p_snapshot#>>array['items',d.item_id::text])::bigint,0);
        closet:=coalesce((p_snapshot#>>array['closetItems',d.item_id::text])::bigint,0);
        held:=coalesce((liabilities#>>array['items',d.item_id::text])::bigint,0)
              +coalesce((p_review_items->>d.item_id::text)::bigint,0); amount:=d.quantity;
    end if;
    if inv is null or closet is null or inv<0 or closet<0 or held<0 then raise exception 'Invalid closet snapshot.'; end if;
    if inv-held<amount then raise exception 'Not enough unencumbered inventory for closet transfer C-%. Protect escrow, review mail, and operating reserve.',d.reference_number; end if;
    update khub_bot.closet_transfers set state='moving',attempt=gen_random_uuid(),
        before_state=jsonb_build_object('inventory',inv::text,'closet',closet::text)
        where id=d.id returning * into d;
    return to_jsonb(d)||jsonb_build_object('closet_reference','C-'||d.reference_number);
end; $$;

create or replace function public.bot_mail_cleanup(p_mail_ids text[]) returns jsonb
language sql security definer set search_path='' as $$
    select coalesce(jsonb_agg(r.mail_id order by r.mail_id),'[]'::jsonb) from khub_bot.receipts r
    where r.mail_id=any(p_mail_ids) and r.payload#>>'{raw,type}'='normal'
      and r.payload#>>'{command,type}' in ('verify','list','bid','buy','donation')
      and not exists(select 1 from khub_bot.mail_policy_reviews v where v.receipt_id=r.mail_id)
      and r.result in ('accepted','donation','donation_help')
      and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id and d.state<>'sent')
      and not exists(select 1 from khub_bot.closet_transfers c where c.receipt_id=r.mail_id and c.state<>'moved');
$$;

create or replace function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
    select jsonb_build_object('deliveryCounts',(select jsonb_object_agg(state,n) from (select state,count(*) n from khub_bot.deliveries group by state)s),
        'attention',(select coalesce(jsonb_agg(khub_bot.delivery_details(d)),'[]') from khub_bot.deliveries d where state in ('sending','unknown')),
        'closetCounts',(select jsonb_object_agg(state,n) from (select state,count(*) n from khub_bot.closet_transfers group by state)s),
        'closetAttention',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('closet_reference','C-'||c.reference_number)),'[]')
            from khub_bot.closet_transfers c where state in ('moving','unknown')),
        'mailPolicyAttention',(select coalesce(jsonb_agg(to_jsonb(v)),'[]') from khub_bot.mail_policy_reviews v where not refund_queued),
        'receipts',(select count(*) from khub_bot.receipts),'settings',(select to_jsonb(s) from khub_bot.settings s where id));
$$;

revoke all on function khub_bot.ingest_mail_before_invalid_refunds(jsonb),khub_bot.suppress_previous_donation_plans() from public,anon,authenticated,service_role;
revoke all on function public.bot_ingest_mail(jsonb),public.bot_queue_previous_donation_refunds(jsonb) from public,anon,authenticated;
grant execute on function public.bot_ingest_mail(jsonb),public.bot_queue_previous_donation_refunds(jsonb) to service_role;
notify pgrst,'reload schema';
commit;
