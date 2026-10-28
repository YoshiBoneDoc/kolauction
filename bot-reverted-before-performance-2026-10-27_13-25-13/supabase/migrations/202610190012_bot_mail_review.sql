-- Apply after 011 with every bot stopped, then deploy the matching worker.
begin;

-- Delete only recognized source mail whose immediate replies/refunds are confirmed.
-- Unrelated, gift, malformed, and unresolved messages stay in the KoL inbox.
create function public.bot_mail_cleanup(p_mail_ids text[]) returns jsonb
language sql security definer set search_path='' as $$
    select coalesce(jsonb_agg(r.mail_id order by r.mail_id),'[]'::jsonb)
    from khub_bot.receipts r
    where r.mail_id=any(p_mail_ids)
      and r.payload#>>'{raw,type}'='normal'
      and r.payload#>>'{command,type}' in ('verify','list','bid','buy','donation')
      and r.result in ('accepted','donation','donation_help')
      and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id and d.state<>'sent');
$$;

-- A separate, narrowly scoped claim can send an asset-free support notice while
-- transfers are blocked. The notice itself is tracked and NEVER retried blindly.
create function public.bot_claim_review_notice() returns jsonb
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; blocked khub_bot.deliveries%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.deliveries where dedupe_key like 'manual-review:%' and state in ('sending','unknown')) then
        return null;
    end if;
    for blocked in select * from khub_bot.deliveries
        where state in ('sending','unknown') and dedupe_key not like 'manual-review:%'
        order by created_at,id
    loop
        -- No auction/receipt relation: a support notice must not change settlement
        -- completion or cause the original source mail to be deleted.
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message)
        values('manual-review:'||blocked.id,blocked.recipient_id,'notice',
            'Manual review for delivery '||blocked.id,
            E'Your delivery needs a manual check\n\nWe could not confirm the outcome of delivery D-'||blocked.reference_number||
            E'. It may already have arrived. We have paused automatic transfers while we check it.\n\nPlease do not resend your payment or items. We are waiting for manual resolution. If you need help, KMail teres minor (#3552305) with the delivery reference above.')
        on conflict(dedupe_key) do nothing;
    end loop;
    select * into d from khub_bot.deliveries
        where dedupe_key like 'manual-review:%' and state='pending'
          and kind='notice' and meat=0 and quantity=0 and item_id is null
        order by created_at,id limit 1 for update;
    if not found then return null; end if;
    update khub_bot.deliveries set state='sending',attempt=gen_random_uuid() where id=d.id returning * into d;
    return khub_bot.delivery_details(d);
end; $$;

revoke all on function public.bot_mail_cleanup(text[]),public.bot_claim_review_notice() from public,anon,authenticated;
grant execute on function public.bot_mail_cleanup(text[]),public.bot_claim_review_notice() to service_role;
notify pgrst,'reload schema';
commit;
