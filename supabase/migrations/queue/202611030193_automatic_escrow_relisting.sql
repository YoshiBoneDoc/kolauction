-- Apply after 192 with workers stopped; resume one worker after success.
-- Website must be deployed after this SQL. No bot image change is required.
-- Existing listings are not enrolled. Retry the same auction ID, retaining escrow.
begin;
select pg_advisory_xact_lock(3888760);
create table khub_bot.auction_relist_plans (
 auction_id uuid primary key references public.auctions(id),
 max_relists integer not null check(max_relists between 1 and 3),
 completed integer not null default 0 check(completed between 0 and max_relists),
 reduction_percent integer not null check(reduction_percent between 0 and 99),
 duration interval not null check(duration>interval '0' and duration<=interval '720 hours'),
 cycle_started_at timestamptz
);
create table khub_bot.auction_relist_events (
 auction_id uuid not null references public.auctions(id), attempt integer not null,
 previous_end timestamptz not null, started_at timestamptz not null, end_time timestamptz not null,
 previous_minimum bigint not null, minimum bigint not null, buyout bigint,
 primary key(auction_id,attempt)
);
alter table khub_bot.auction_relist_plans enable row level security;
alter table khub_bot.auction_relist_events enable row level security;
revoke all on khub_bot.auction_relist_plans,khub_bot.auction_relist_events from public,anon,authenticated,service_role;

-- Atomic creation: reuse the existing creators and their identity, catalog,
-- bundle, duration and price checks; a failed plan rolls back the listing too.
create function public.create_relisting_auction(p_listing jsonb,p_relist_count integer,p_reduction_percent integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare aid uuid; a public.auctions%rowtype; ending timestamptz;
begin
 perform pg_advisory_xact_lock(3888760);
 perform khub_bot.require_verified_trader();
 if p_relist_count is null or p_relist_count not between 1 and 3
    or p_reduction_percent is null or p_reduction_percent not between 0 and 99 then
   raise exception 'Choose 1 to 3 relists and a reduction from 1 to 99 percent, or keep the same price.';
 end if;
 if coalesce(p_listing->>'auctionKind','sell')<>'sell'
    or coalesce((p_listing->>'escrowMode')::boolean,false) is not true
    or p_listing ? 'giveawayTitle' then raise exception 'Automatic relisting is only available for ordinary Escrow Sell and Bundle auctions.'; end if;
 ending:=(p_listing->>'customEndAt')::timestamptz;
 if jsonb_array_length(coalesce(p_listing->'bundleItems','[]'::jsonb))>0 then
   select public.create_bundle_auction(p_listing->'bundleItems',(p_listing->>'minBidMeat')::bigint,
     (p_listing->>'auctionTime')::integer,(p_listing->>'instantPurchasePrice')::bigint,true,ending,
     p_listing->>'bundleTitle',(p_listing->>'bundleImageItemId')::integer) into aid;
 elsif ending is not null then
   aid:=public.create_auction(p_listing->>'item',(p_listing->>'quantity')::bigint,(p_listing->>'minBidMeat')::bigint,
     (p_listing->>'auctionTime')::integer,null,(p_listing->>'instantPurchasePrice')::bigint,
     (p_listing->>'itemId')::integer,true,ending);
 else
   aid:=public.create_auction(p_listing->>'item',(p_listing->>'quantity')::bigint,(p_listing->>'minBidMeat')::bigint,
     (p_listing->>'auctionTime')::integer,null,(p_listing->>'instantPurchasePrice')::bigint,
     (p_listing->>'itemId')::integer,true);
 end if;
 select * into strict a from public.auctions where id=aid;
 insert into khub_bot.auction_relist_plans(auction_id,max_relists,reduction_percent,duration)
 values(aid,p_relist_count,p_reduction_percent,case when a.custom_end_at is null
   then make_interval(hours=>a.duration_hours) else a.end_time-a.created_at end);
 return aid;
end; $$;
revoke all on function public.create_relisting_auction(jsonb,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.create_relisting_auction(jsonb,integer,integer) to authenticated;

create function khub_bot.try_relist_auction(p_id uuid,p_reason text) returns boolean
language plpgsql set search_path='' as $$
declare a public.auctions%rowtype; plan khub_bot.auction_relist_plans%rowtype;
 stamp timestamptz:=clock_timestamp(); next_min bigint;
begin
 if p_reason is distinct from 'deadline' then return false; end if;
 perform pg_advisory_xact_lock(3888760);
 select * into plan from khub_bot.auction_relist_plans where auction_id=p_id for update;
 if not found or plan.completed>=plan.max_relists then return false; end if;
 select * into a from public.auctions where id=p_id for update;
 if not found or p_reason<>'deadline' or not a.escrow_mode or a.auction_kind<>'sell'
   or a.giveaway_title is not null or a.status<>'active' or a.end_time>stamp
   or a.item_escrowed_at is null or a.highest_bidder_id is not null or a.current_bid<>0
   or a.escrow_timing_review or a.escrow_buyout_received_at is not null
   or khub_bot.profile_is_restricted(a.seller_id)
   or exists(select 1 from public.bids where auction_id=a.id)
   or exists(select 1 from khub_bot.deliveries where auction_id=a.id and kind in ('return_item','sale_item','sale_meat'))
 then return false; end if;
 -- Independently require the same post-deadline complete scan as settlement.
 if not exists(select 1 from khub_bot.escrow_close_authorizations c
   join khub_bot.inbox_scans s on s.id=c.scan_id where c.auction_id=a.id
   and s.completed_at is not null and s.started_at>=a.end_time+interval '60 seconds') then return false; end if;
 next_min:=greatest(1,floor(a.min_bid_meat::numeric*(100-plan.reduction_percent)/100)::bigint);
 update public.auctions set min_bid_meat=next_min,end_time=stamp+plan.duration,
   custom_end_at=case when a.custom_end_at is not null then stamp+plan.duration end
   where id=a.id;
 -- Buyout is deliberately retained; only the minimum bid is reduced.
 -- KoL mail timestamps have whole-second precision, just like deposit opening.
 update khub_bot.auction_relist_plans set completed=completed+1,cycle_started_at=date_trunc('second',stamp) where auction_id=a.id;
 insert into khub_bot.auction_relist_events values(a.id,plan.completed+1,a.end_time,stamp,stamp+plan.duration,
   a.min_bid_meat,next_min,a.instant_purchase_price);
 update khub_bot.public_cache_revision set revision=revision+1 where id;
 perform khub_bot.send_public_cache_invalidation(a.id);
 return true;
end; $$;
revoke all on function khub_bot.try_relist_auction(uuid,text) from public,anon,authenticated,service_role;

-- Intercept before any settlement state, fee recording or delivery is queued.
-- Preserve the surrounding receipt authorization and all existing outcome paths.
do $$declare d text; marker text:='outcome:=case'; begin
 d:=pg_get_functiondef('khub_bot.finish_listing_before_receipt_time(uuid,text)'::regprocedure);
 if strpos(d,marker)=0 then raise exception 'Unexpected settlement source; relisting was not installed.'; end if;
 execute replace(d,marker,'if p_reason=''deadline'' and a.highest_bidder_id is null and a.giveaway_title is null and khub_bot.try_relist_auction(p_id,p_reason) then return; end if; '||marker);
 -- An old-cycle KMail must not become a bid in the new attempt. The existing
 -- invalid-funded-mail path performs its normal durable refund, not a new send.
 d:=pg_get_functiondef('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure);
 marker:='a.status<>''active'' or a.escrow_buyout_received_at is not null or (p_mail->>''received_at'')::timestamptz>=a.end_time';
 if strpos(d,marker)=0 then raise exception 'Unexpected receipt-time bid source; relisting was not installed.'; end if;
 execute replace(d,marker,marker||' or exists(select 1 from khub_bot.auction_relist_plans rp where rp.auction_id=a.id and rp.cycle_started_at>(p_mail->>''received_at'')::timestamptz)');
 -- The outer ordering guard runs before the refund path. Old-attempt mail
 -- cannot hold the current attempt, even if its first bid already arrived.
 d:=pg_get_functiondef('khub_bot.ingest_before_buy_orders(jsonb)'::regprocedure);
 marker:='if listing.id is not null and listing.status=''active''';
 if strpos(d,marker)=0 then raise exception 'Unexpected receipt ordering source; relisting was not installed.'; end if;
 execute replace(d,marker,marker||' and not exists(select 1 from khub_bot.auction_relist_plans rp where rp.auction_id=listing.id and rp.cycle_started_at>(p_mail->>''received_at'')::timestamptz)');
end; $$;
-- Changed prices/deadlines ride the existing bounded shared live read, never
-- an extra per-visitor fetch or a catalogue refresh on every retry.
do $$declare d text; marker text:='''id'',''current_bid'',''end_time'',''status'''; begin
 d:=pg_get_functiondef('public.read_public_auction_live_batch(uuid[])'::regprocedure);
 if strpos(d,marker)=0 then raise exception 'Unexpected live projection source; relisting was not installed.'; end if;
 execute replace(d,marker,'''id'',''min_bid_meat'',''custom_end_at'',''current_bid'',''end_time'',''status''');
end; $$;
notify pgrst,'reload schema';
commit;
