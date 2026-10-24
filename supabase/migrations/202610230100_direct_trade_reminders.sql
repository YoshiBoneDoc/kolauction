-- Apply after 099. Uses the existing worker/notice queue; no bot rebuild required.
-- Only newly concluded Direct Sell auctions are enrolled. No historical mail blast.
begin;
select pg_advisory_xact_lock(3888760);

create table khub_bot.direct_trade_reminders (
    auction_id uuid not null references public.auctions(id),
    phase text not null check(phase in ('conclusion','24_hours')),
    recipient_role text not null check(recipient_role in ('seller','buyer')),
    recipient_id uuid not null references public.profiles(id),
    counterpart_id uuid not null references public.profiles(id),
    closed_at timestamptz not null,
    due_at timestamptz not null,
    deadline_at timestamptz not null,
    delivery_id uuid unique references khub_bot.deliveries(id),
    suppressed_at timestamptz,
    suppression_reason text,
    created_at timestamptz not null default clock_timestamp(),
    primary key(auction_id,phase,recipient_role),
    check(recipient_id<>counterpart_id),
    check(deadline_at=closed_at+interval '48 hours'),
    check(due_at=closed_at+case when phase='conclusion' then interval '0 hours' else interval '24 hours' end)
);
create index direct_trade_reminders_due on khub_bot.direct_trade_reminders(due_at,auction_id)
    where delivery_id is null and suppressed_at is null;
alter table khub_bot.direct_trade_reminders enable row level security;
revoke all on khub_bot.direct_trade_reminders from public,anon,authenticated,service_role;

create function khub_bot.maintain_direct_trade_reminders(p_auction uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare notice_record khub_bot.direct_trade_reminders%rowtype; auction_record public.auctions%rowtype;
    recipient public.profiles%rowtype; counterpart public.profiles%rowtype;
    body text; other_name text; details text; delivery uuid; checked_at timestamptz; confirmed boolean;
begin
    perform pg_advisory_xact_lock(3888760);
    checked_at:=clock_timestamp();
    -- Only definitely unsent notices may be canceled. In-flight/uncertain sends
    -- retain their original bodies and normal Sent Mail recovery obligations.
    update khub_bot.direct_trade_reminders n set suppressed_at=checked_at,
        suppression_reason=case when a.status='completed' or
            (coalesce(a.seller_confirmed_at,a.seller_resolved_at) is not null and
             coalesce(a.buyer_confirmed_at,a.buyer_resolved_at) is not null) then 'Trade already completed'
            when checked_at>=n.deadline_at then 'Trade deadline already passed'
            when n.phase='conclusion' and checked_at>=n.closed_at+interval '24 hours' then 'Replaced by current 24-hour reminder'
            else 'Trade no longer eligible' end
        from public.auctions a where a.id=n.auction_id and n.suppressed_at is null
        and (p_auction is null or n.auction_id=p_auction)
        and (n.delivery_id is null or exists(select 1 from khub_bot.deliveries d where d.id=n.delivery_id and d.state='pending'))
        and (a.escrow_mode or a.auction_kind<>'sell' or a.winner_id is null
            or a.status in ('completed','cancelled','voided','expired','ended_no_bids')
            or (coalesce(a.seller_confirmed_at,a.seller_resolved_at) is not null and
                coalesce(a.buyer_confirmed_at,a.buyer_resolved_at) is not null)
            or checked_at>=n.deadline_at
            or n.phase='conclusion' and checked_at>=n.closed_at+interval '24 hours');
    update khub_bot.deliveries d set state='cancelled',evidence=n.suppression_reason
        from khub_bot.direct_trade_reminders n where n.delivery_id=d.id and n.suppressed_at is not null
        and (p_auction is null or n.auction_id=p_auction)
        and d.state='pending' and d.kind='notice' and d.meat=0 and d.quantity=0;

    for notice_record in select r.* from khub_bot.direct_trade_reminders r
        join public.auctions a on a.id=r.auction_id
        where r.delivery_id is null and r.suppressed_at is null and r.due_at<=checked_at and r.deadline_at>checked_at
        and (p_auction is null or r.auction_id=p_auction)
        and a.status='awaiting_trade' and not a.escrow_mode and a.auction_kind='sell'
        order by r.due_at,r.auction_id,r.phase,r.recipient_role limit 200 for update of r,a
    loop
        select * into auction_record from public.auctions where id=notice_record.auction_id;
        select * into recipient from public.profiles where id=notice_record.recipient_id;
        select * into counterpart from public.profiles where id=notice_record.counterpart_id;
        -- Do not infer KoL numbers from usernames or misdirect counterpart details.
        if recipient.kol_player_id is null or recipient.kol_verified_at is null
            or counterpart.kol_player_id is null or counterpart.kol_verified_at is null then continue;end if;
        other_name:=khub_bot.escape_report_kmail(left(coalesce(counterpart.kol_player_name,counterpart.khub_username),80))
            ||' (#'||counterpart.kol_player_id||')';
        details:=khub_bot.format_message_number(auction_record.quantity)||' x '||khub_bot.escape_report_kmail(left(auction_record.item,80));
        confirmed:=case when notice_record.recipient_role='seller' then coalesce(auction_record.seller_confirmed_at,auction_record.seller_resolved_at) is not null
            else coalesce(auction_record.buyer_confirmed_at,auction_record.buyer_resolved_at) is not null end;
        body:=case when notice_record.phase='conclusion' then 'Your Direct Trade auction has ended' else 'Direct Trade: 24-hour reminder' end
            ||E'\n\nAuction #'||coalesce(auction_record.auction_number::text,auction_record.id::text)
            ||E'\n'||details||E'\nAgreed total: '||khub_bot.format_message_number(auction_record.final_price)||' Meat'
            ||E'\nTrading with: '||other_name
            ||E'\nkHub username: '||khub_bot.escape_report_kmail(left(counterpart.khub_username,80))
            ||case when notice_record.recipient_role='seller' then E'\n\nYou are the seller. Arrange an in-game trade with '||other_name
                ||': send '||details||' in exchange for '||khub_bot.format_message_number(auction_record.final_price)||' Meat.'
                else E'\n\nYou are the buyer. Arrange an in-game trade with '||other_name
                ||': send '||khub_bot.format_message_number(auction_record.final_price)||' Meat in exchange for '||details||'.' end
            ||E'\nDo not send these items or Meat to kHub; this is a Direct Trade.'
            ||case when notice_record.phase='conclusion' then E'\n\nBoth parties have 48 hours from the auction ending to complete the exchange.'
                else E'\n\nYour trade is still awaiting completion. This reminder is scheduled with 24 hours remaining; delivery may be delayed.' end
            ||E'\nComplete by: '||to_char(notice_record.deadline_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS')||' UTC.'
            ||case when confirmed then E'\nYour receipt is already confirmed; the other player’s confirmation is still outstanding.'
                else E'\nAfter receiving your items or Meat, open this auction on kHub and mark the trade complete.' end
            ||E'\nThe trade is complete on kHub once both parties confirm. If already exchanged, please make sure both confirmations are recorded.';
        insert into khub_bot.deliveries(dedupe_key,auction_id,recipient_id,kind,message,display_message,display_footer)
            values('direct-trade-reminder:'||auction_record.id||':'||notice_record.phase||':'||notice_record.recipient_role,auction_record.id,recipient.kol_player_id,'notice',body,body,'')
            on conflict(dedupe_key) do nothing returning id into delivery;
        if delivery is null then select id into delivery from khub_bot.deliveries
            where dedupe_key='direct-trade-reminder:'||auction_record.id||':'||notice_record.phase||':'||notice_record.recipient_role;end if;
        update khub_bot.direct_trade_reminders set delivery_id=delivery
            where auction_id=notice_record.auction_id and phase=notice_record.phase and recipient_role=notice_record.recipient_role;
    end loop;
end;$$;

create function khub_bot.schedule_direct_trade_reminders() returns trigger
language plpgsql security definer set search_path='' as $$
declare closed timestamptz;
begin
    if old.finalized_at is not null or new.finalized_at is null or new.escrow_mode
        or new.auction_kind<>'sell' or new.status<>'awaiting_trade' or new.winner_id is null
        or new.seller_id=new.winner_id then return new;end if;
    -- Natural close uses the latest anti-sniping deadline; a buyout uses its
    -- actual early close. Delayed processing never restarts the 48-hour clock.
    closed:=least(new.end_time,new.finalized_at,coalesce(new.instant_purchased_at,new.finalized_at));
    insert into khub_bot.direct_trade_reminders(auction_id,phase,recipient_role,recipient_id,counterpart_id,closed_at,due_at,deadline_at)
        select new.id,p.phase,r.role,r.recipient,r.counterpart,closed,closed+p.after_close,closed+interval '48 hours'
        from (values('conclusion',interval '0 hours'),('24_hours',interval '24 hours')) p(phase,after_close)
        cross join (values('seller',new.seller_id,new.winner_id),('buyer',new.winner_id,new.seller_id)) r(role,recipient,counterpart)
        on conflict do nothing;
    perform khub_bot.maintain_direct_trade_reminders(new.id);
    return new;
end;$$;
create trigger auctions_schedule_direct_trade_reminders after update of finalized_at on public.auctions
    for each row execute function khub_bot.schedule_direct_trade_reminders();

-- Keep existing escrow, Buy, receipt-time and recovery maintenance intact.
alter function public.bot_tick() rename to tick_before_direct_reminders;
alter function public.tick_before_direct_reminders() set schema khub_bot;
create function public.bot_tick() returns void language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    perform khub_bot.tick_before_direct_reminders();
    perform khub_bot.maintain_direct_trade_reminders();
end;$$;

-- Check again immediately before claiming a notice, even if completion happened
-- after bot_tick. Never reset sending/unknown notices or bypass dispatch guards.
alter function public.bot_claim_delivery(integer) rename to claim_before_direct_reminders;
alter function public.claim_before_direct_reminders(integer) set schema khub_bot;
create function public.bot_claim_delivery(p_message_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
    perform khub_bot.maintain_direct_trade_reminders();
    return khub_bot.claim_before_direct_reminders(p_message_version);
end;$$;
alter function public.bot_inspect() rename to inspect_before_direct_reminders;
alter function public.inspect_before_direct_reminders() set schema khub_bot;
create function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
    select khub_bot.inspect_before_direct_reminders()||jsonb_build_object('directTradeRemindersVersion',1);
$$;

revoke all on function khub_bot.maintain_direct_trade_reminders(uuid),khub_bot.schedule_direct_trade_reminders(),
    khub_bot.tick_before_direct_reminders(),khub_bot.claim_before_direct_reminders(integer),khub_bot.inspect_before_direct_reminders()
    from public,anon,authenticated,service_role;
revoke all on function public.bot_tick(),public.bot_claim_delivery(integer),public.bot_inspect() from public,anon,authenticated;
grant execute on function public.bot_tick(),public.bot_claim_delivery(integer),public.bot_inspect() to service_role;
notify pgrst,'reload schema';
commit;
