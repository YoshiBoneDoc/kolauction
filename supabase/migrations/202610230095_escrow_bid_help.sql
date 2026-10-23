-- Apply after 094, then upload/rebuild the matching Oracle worker bundle.
-- Common text-only bid mistakes receive one durable instructional reply.
-- No existing bids, receipts, frozen messages or financial obligations are changed.
begin;
alter function public.bot_ingest_mail(jsonb) rename to ingest_mail_before_bid_help;
alter function public.ingest_mail_before_bid_help(jsonb) set schema khub_bot;
revoke all on function khub_bot.ingest_mail_before_bid_help(jsonb) from public,anon,authenticated,service_role;
create function public.bot_ingest_mail(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare
    mid text:=p_mail->>'id';
    sid bigint:=(p_mail->>'sender_id')::bigint;
    meat bigint:=(p_mail->>'meat')::bigint;
    attachments jsonb:=p_mail->'items';
    cmd text:=p_mail#>>'{command,type}';
    prior khub_bot.receipts%rowtype;
    target text;
    body text;
    profile public.profiles%rowtype;
begin
    if cmd is distinct from 'bid_help' and not (cmd='bid' and meat=0 and attachments='[]'::jsonb) then
        return khub_bot.ingest_mail_before_bid_help(p_mail);
    end if;
    perform pg_advisory_xact_lock(3888760);
    if mid is null or mid!~'^[1-9][0-9]*$' or sid is null or sid<=0 or sid=3888760
        or meat is null or meat<0 or meat>9007199254740991
        or jsonb_typeof(attachments) is distinct from 'array'
        or p_mail#>>'{raw,type}' is distinct from 'normal'
        or p_mail#>>'{raw,id}' is distinct from mid
        or p_mail#>>'{raw,fromid}' is distinct from p_mail->>'sender_id'
        or p_mail#>>'{raw,fromname}' is distinct from p_mail->>'sender_name'
        or p_mail->>'received_at' is null then
        raise exception 'Invalid normalized bid-help KMail.';
    end if;
    if exists(select 1 from jsonb_array_elements(attachments) x
        where (x->>'id') is null or (x->>'id')::integer<=0
            or (x->>'quantity') is null or (x->>'quantity')::bigint not between 1 and 5000000000)
        or (select count(*) from jsonb_array_elements(attachments))<>
           (select count(distinct x->>'id') from jsonb_array_elements(attachments) x) then
        raise exception 'Invalid bid-help attachments.';
    end if;
    if cmd='bid' then
        if not exists(select 1 from khub_bot.inbox_bid_mail where mail_id=mid and payload=p_mail) then
            raise exception 'Bid intake requires a complete staged inbox scan; upgrade the worker.';
        end if;
        -- This has no funds and cannot affect the winner. Release its durable
        -- queue entry without advancing the accepted-bid ordering cursor.
        update khub_bot.inbox_bid_mail set processed=true where mail_id=mid;
    end if;
    select * into prior from khub_bot.receipts where mail_id=mid;
    if found then
        if prior.payload<>p_mail then raise exception 'KMail ID payload changed; reconcile before continuing.';end if;
        return 'duplicate';
    end if;
    select * into profile from public.profiles where kol_player_id=sid;
    if khub_bot.account_is_banned(sid,profile.khub_username,p_mail->>'sender_name') then
        perform khub_bot.account_reply(p_mail,
            'Your kHub account is restricted. Any attached assets are returned. Contact support for review.','account_rejected');
        return 'Account restricted.';
    end if;
    target:=p_mail#>>'{command,auction_number}';
    if not (case when target~'^[1-9][0-9]{0,18}$' then target::numeric<=9223372036854775807 else false end) then
        target:=p_mail#>>'{command,auction_id}';
        if target is null or target!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then target:='1234';end if;
    end if;
    body:=E'Your message did not place a bid.\n\nTo bid on an Escrow sell auction:\n'
        ||E'1. Check the auction page is still active and check its current minimum bid.\n'
        ||E'2. Send a normal KMail to kHub (#3888760).\n'
        ||'3. Put only BID '||target||E' in the message. Do not type the bid amount after the auction number.\n'
        ||E'4. Attach the FULL amount of Meat you want to bid using the KMail Meat field. Do not send items.\n\n'
        ||'For example, to bid 51,000 Meat on auction '||target||', send BID '||target
        ||E' with 51,000 Meat actually attached. Typing an amount in the message does not attach Meat or place a bid.\n\n'
        ||E'If you raise your own bid, send the full new amount, not just the increase. Your previous bid will be returned.\n'
        ||E'Direct auctions use the website bid form instead.'
        ||case when meat>0 or jsonb_array_length(attachments)>0 then E'\n\nYour attached assets are being returned; they were not accepted as a bid.' else '' end;
    -- Reuse the existing receipt, split refund queue, frozen message and recovery path.
    perform khub_bot.account_reply(p_mail,body,'bid_help');
    return 'bid_help';
end; $$;
revoke all on function public.bot_ingest_mail(jsonb) from public,anon,authenticated;
grant execute on function public.bot_ingest_mail(jsonb) to service_role;
-- Delete only our handled help mail, and only after its reply/refunds are sent.
alter function public.bot_mail_cleanup(text[]) rename to mail_cleanup_before_bid_help;
alter function public.mail_cleanup_before_bid_help(text[]) set schema khub_bot;
revoke all on function khub_bot.mail_cleanup_before_bid_help(text[]) from public,anon,authenticated,service_role;
create function public.bot_mail_cleanup(p_mail_ids text[]) returns jsonb
language sql security definer set search_path='' as $$
select khub_bot.mail_cleanup_before_bid_help(p_mail_ids)||coalesce((
    select jsonb_agg(r.mail_id order by r.mail_id) from khub_bot.receipts r
    where r.mail_id=any(p_mail_ids) and r.result='bid_help'
        and r.payload#>>'{raw,type}'='normal' and r.payload#>>'{command,type}' in ('bid','bid_help')
        and exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id)
        and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id and d.state<>'sent')
        and not exists(select 1 from khub_bot.closet_transfers c where c.receipt_id=r.mail_id and c.state<>'moved')
),'[]'::jsonb);
$$;
revoke all on function public.bot_mail_cleanup(text[]) from public,anon,authenticated;
grant execute on function public.bot_mail_cleanup(text[]) to service_role;
notify pgrst,'reload schema';
commit;
