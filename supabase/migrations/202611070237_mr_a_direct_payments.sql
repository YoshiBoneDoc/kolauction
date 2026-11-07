-- Apply after 236. Direct Sell support only; mixed Escrow creation is rejected
-- until physical-reserve/refund/settlement support is installed and verified.
-- No historical fees, obligations, receipts or transfers are changed.
begin;
select pg_advisory_xact_lock(3888760);
alter table public.auctions
 add column mr_a_rate bigint check(mr_a_rate between 1 and 9007199254740991),
 add column mr_a_reference bigint,
 add column mr_a_observed_at timestamptz,
 add column payment_meat bigint check(payment_meat between 0 and 9007199254740991),
 add column payment_mr_a bigint not null default 0 check(payment_mr_a between 0 and 9007199254740991),
 add constraint mr_a_terms_complete check((mr_a_rate is null and mr_a_reference is null and mr_a_observed_at is null)
   or (mr_a_rate is not null and mr_a_reference>0 and mr_a_observed_at is not null
       and auction_kind='sell' and giveaway_title is null and not escrow_mode));
alter table public.bids
 add column payment_meat bigint check(payment_meat between 0 and 9007199254740991),
 add column payment_mr_a bigint not null default 0 check(payment_mr_a between 0 and 9007199254740991);

create function khub_bot.guard_mr_a_terms() returns trigger
language plpgsql set search_path='' as $$
declare quote khub_bot.market_prices%rowtype; stamp timestamptz:=clock_timestamp();
begin
 if tg_op='UPDATE' and (new.mr_a_rate,new.mr_a_reference,new.mr_a_observed_at)
     is not distinct from (old.mr_a_rate,old.mr_a_reference,old.mr_a_observed_at) then return new; end if;
 if tg_op='UPDATE' then
   if old.mr_a_rate is not null or old.created_at<transaction_timestamp()
      or old.current_bid<>0 or old.finalized_at is not null then
     raise exception 'Mr. A payment terms are immutable.';
   end if;
 end if;
 if new.mr_a_rate is null then return new; end if;
 select * into quote from khub_bot.market_prices where item_id=194;
 if not found or not quote.available or quote.price_meat is null
   or quote.observed_at is null or quote.checked_at>stamp or quote.observed_at>quote.checked_at
   or quote.observed_at<=stamp-interval '26 hours' or quote.checked_at<=stamp-interval '26 hours' then
   raise exception 'A fresh Mr. A market quote is unavailable. Create a Meat-only auction or try later.';
 end if;
 if new.mr_a_rate::numeric*100<quote.price_meat::numeric*95
   or new.mr_a_rate::numeric*100>quote.price_meat::numeric*105 then
   raise exception 'Mr. A valuation must be within 5 percent of the current market quote. Refresh the quote.';
 end if;
 new.mr_a_reference:=quote.price_meat; new.mr_a_observed_at:=quote.observed_at;
 return new;
end; $$;
create trigger guard_mr_a_terms before insert or update of mr_a_rate,mr_a_reference,mr_a_observed_at
 on public.auctions for each row execute function khub_bot.guard_mr_a_terms();

-- Reuse all existing creators and their authorization/catalog/schedule rules.
-- Attaching terms in this same transaction cannot leave a Meat-only listing on failure.
create function public.create_mr_a_auction(p_listing jsonb,p_rate bigint) returns uuid
language plpgsql security definer set search_path='' as $$
declare aid uuid; ending timestamptz:=(p_listing->>'customEndAt')::timestamptz;
begin
 perform pg_advisory_xact_lock(3888760);
 perform khub_bot.require_verified_trader();
 if p_rate is null or coalesce(p_listing->>'auctionKind','sell') not in ('sell','bundle')
    or p_listing ? 'giveawayTitle' or coalesce((p_listing->>'escrowMode')::boolean,true)
    or coalesce((p_listing->>'autoRelist')::boolean,false) then
   raise exception 'Mr. A payments currently require an ordinary Direct Sell auction.';
 end if;
 if jsonb_array_length(coalesce(p_listing->'bundleItems','[]'::jsonb))>0 then
   aid:=public.create_bundle_auction(p_listing->'bundleItems',(p_listing->>'minBidMeat')::bigint,
     (p_listing->>'auctionTime')::integer,(p_listing->>'instantPurchasePrice')::bigint,false,ending,
     p_listing->>'bundleTitle',(p_listing->>'bundleImageItemId')::integer);
 elsif ending is not null then
   aid:=public.create_auction(p_listing->>'item',(p_listing->>'quantity')::bigint,(p_listing->>'minBidMeat')::bigint,
     (p_listing->>'auctionTime')::integer,null,(p_listing->>'instantPurchasePrice')::bigint,
     (p_listing->>'itemId')::integer,false,ending);
 else
   aid:=public.create_auction(p_listing->>'item',(p_listing->>'quantity')::bigint,(p_listing->>'minBidMeat')::bigint,
     (p_listing->>'auctionTime')::integer,null,(p_listing->>'instantPurchasePrice')::bigint,
     (p_listing->>'itemId')::integer,false);
 end if;
 update public.auctions set mr_a_rate=p_rate where id=aid;
 return aid;
end; $$;

create function public.place_mixed_bid(p_auction_id uuid,p_meat bigint,p_mr_a bigint) returns void
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype; total numeric; accepted bigint; accepted_meat bigint; bid_id uuid;
begin
 perform pg_advisory_xact_lock(3888760);
 perform khub_bot.require_verified_trader();
 select * into a from public.auctions where id=p_auction_id for update;
 if not found or a.mr_a_rate is null or a.escrow_mode or a.auction_kind<>'sell' or a.giveaway_title is not null then
   raise exception 'This auction does not accept Direct Mr. A payments.';
 end if;
 if p_meat is null or p_mr_a is null or p_meat<0 or p_mr_a<0 then raise exception 'Payment amounts must be nonnegative whole numbers.'; end if;
 total:=p_meat::numeric+p_mr_a::numeric*a.mr_a_rate;
 if total<1 or total>9007199254740991 then raise exception 'Invalid payment value.'; end if;
 accepted:=least(total,coalesce(a.instant_purchase_price,total));
 accepted_meat:=accepted::numeric-p_mr_a::numeric*a.mr_a_rate;
 if accepted_meat<0 then raise exception 'Mr. A portion exceeds the buyout; choose fewer Mr. A''s.'; end if;
 -- A buyout replay must never rewrite an already committed payment composition.
 if a.instant_purchased_at is not null then
   if a.winner_id=auth.uid() and a.payment_meat=accepted_meat and a.payment_mr_a=p_mr_a then return; end if;
   raise exception 'Bidding has closed.';
 end if;
 -- Existing wrapper preserves restrictions, ignores, deadlines, increments and
 -- anti-sniping. Equivalent value is only passed to the Direct bid comparator.
 -- Set composition before invoking the writer: its buyout finalization trigger
 -- freezes Direct reminder bodies in this transaction. Rejection rolls back all.
 update public.auctions set payment_meat=accepted_meat,payment_mr_a=p_mr_a where id=p_auction_id;
 perform public.place_bid(p_auction_id,total::bigint);
 select id into strict bid_id from public.bids where auction_id=p_auction_id and amount=accepted and bidder_id=auth.uid();
 update public.bids set payment_meat=accepted_meat,payment_mr_a=p_mr_a where id=bid_id;
 update public.auctions set payment_meat=accepted_meat,payment_mr_a=p_mr_a where id=p_auction_id;
end; $$;

-- Normalize legacy Meat-only bids using the auction row already being written.
-- The trigger's WHEN excludes every existing Meat-only/Buy/escrow auction.
-- Mixed RPC stages the exact new composition before invoking the legacy writer.
create function khub_bot.record_meat_bid_composition() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.payment_meat::numeric+new.payment_mr_a::numeric*new.mr_a_rate is distinct from new.current_bid::numeric then
   new.payment_meat:=new.current_bid; new.payment_mr_a:=0;
 end if;
 return new;
end; $$;
create trigger record_meat_bid_composition before update of current_bid on public.auctions
 for each row when (new.mr_a_rate is not null) execute function khub_bot.record_meat_bid_composition();

create function khub_bot.direct_payment_label(a public.auctions) returns text
language sql stable set search_path='' as $$
 select case when a.payment_mr_a=0 then khub_bot.format_message_number(coalesce(a.final_price,a.current_bid))||' Meat'
 else khub_bot.format_message_number(a.payment_mr_a)||' Mr. A(s)'
   ||case when a.payment_meat>0 then ' + '||khub_bot.format_message_number(a.payment_meat)||' Meat' else '' end
   ||' ('||khub_bot.format_message_number(coalesce(a.final_price,a.current_bid))||' Meat value)' end;
$$;
do $$ declare d text; begin
 d:=pg_get_functiondef('khub_bot.maintain_direct_trade_reminders(uuid)'::regprocedure);
 if strpos(d,'khub_bot.format_message_number(auction_record.final_price)||'' Meat')=0 then
   raise exception 'Unexpected Direct reminder payment layout'; end if;
 d:=replace(d,'khub_bot.format_message_number(auction_record.final_price)||'' Meat''','khub_bot.direct_payment_label(auction_record)');
 d:=replace(d,'khub_bot.format_message_number(auction_record.final_price)||'' Meat.''','khub_bot.direct_payment_label(auction_record)||''.''');
 d:=replace(d,'khub_bot.format_message_number(auction_record.final_price)||'' Meat in exchange for ''','khub_bot.direct_payment_label(auction_record)||'' in exchange for ''');
 execute d;
end; $$;

create function khub_bot.validate_mixed_bid_composition() returns trigger
language plpgsql set search_path='' as $$
declare rate bigint;
begin
 if new.payment_meat is null and new.payment_mr_a=0 then return new; end if;
 select mr_a_rate into rate from public.auctions where id=new.auction_id;
 if new.payment_mr_a>0 and rate is null then raise exception 'Mr. A payments are disabled.'; end if;
 if coalesce(new.payment_meat,new.amount)::numeric+new.payment_mr_a::numeric*coalesce(rate,0)<>new.amount then
   raise exception 'Payment composition does not match bid value.';
 end if;
 return new;
end; $$;
create trigger validate_mixed_bid_composition before insert or update on public.bids
 for each row execute function khub_bot.validate_mixed_bid_composition();

alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to public_auction_before_mr_a;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language sql stable security definer set search_path='' as $$
 select khub_bot.public_auction_before_mr_a(a,p_bid_count,p_highest_label,p_winner_label)
 ||jsonb_build_object('mr_a_rate',a.mr_a_rate,'payment_meat',coalesce(a.payment_meat,a.current_bid),'payment_mr_a',a.payment_mr_a);
$$;
-- Extend bounded history projections in place; no per-row extra lookup or join.
do $$ declare d text; target regprocedure; begin
 foreach target in array array[
 'public.read_auction_bid_history(uuid,bigint,uuid,bigint)'::regprocedure
 ] loop
 d:=pg_get_functiondef(target);
 if strpos(d,'''amount'',b.amount')=0 then raise exception 'Unexpected bid history projection'; end if;
 execute replace(d,'''amount'',b.amount','''payment_meat'',coalesce(b.payment_meat,b.amount),''payment_mr_a'',b.payment_mr_a,''amount'',b.amount');
 end loop;
end; $$;
-- These hot public readers use explicit field lists rather than public_auction.
-- Extend those lists without changing selection, joins, TTLs or concurrency.
do $$ declare d text; target regprocedure; begin
 foreach target in array array[
 'public.read_public_auction_live_batch(uuid[])'::regprocedure,
 'public.read_public_auction_detail_state(uuid)'::regprocedure
 ] loop
 d:=pg_get_functiondef(target);
 if strpos(d,'''current_bid''')=0 then raise exception 'Unexpected public payment projection'; end if;
 execute replace(d,'''current_bid''','''mr_a_rate'',''payment_meat'',''payment_mr_a'',''current_bid''');
 end loop;
end; $$;
revoke all on function khub_bot.guard_mr_a_terms(),khub_bot.record_meat_bid_composition(),
 khub_bot.validate_mixed_bid_composition(),
 khub_bot.direct_payment_label(public.auctions),
 khub_bot.public_auction_before_mr_a(public.auctions,bigint,text,text),khub_bot.public_auction(public.auctions,bigint,text,text),
 public.create_mr_a_auction(jsonb,bigint),public.place_mixed_bid(uuid,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.create_mr_a_auction(jsonb,bigint),public.place_mixed_bid(uuid,bigint,bigint) to authenticated;
notify pgrst,'reload schema';
commit;
