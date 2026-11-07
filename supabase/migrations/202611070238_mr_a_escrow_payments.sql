-- Apply once after 237 with the sole worker stopped. Mixed Escrow creation
-- stays disabled until the operator explicitly activates it after verification.
-- No historical obligations, receipt payloads or unknown sends are rewritten.
begin;
select pg_advisory_xact_lock(3888760);
create table khub_bot.mr_a_escrow_config(id boolean primary key default true check(id),enabled boolean not null default false);
insert into khub_bot.mr_a_escrow_config values(true,false);
alter table khub_bot.mr_a_escrow_config enable row level security;
revoke all on khub_bot.mr_a_escrow_config from public,anon,authenticated,service_role;
alter table public.auctions drop constraint mr_a_terms_complete,
 add constraint mr_a_terms_complete check((mr_a_rate is null and mr_a_reference is null and mr_a_observed_at is null)
 or (mr_a_rate is not null and mr_a_reference is not null and mr_a_reference>0 and mr_a_observed_at is not null
 and auction_kind='sell' and giveaway_title is null)),
 add column calculated_fee_meat bigint check(calculated_fee_meat>=0),
 add column waived_fee_meat bigint not null default 0 check(waived_fee_meat>=0);

create function public.set_mr_a_escrow_enabled(p_enabled boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(3888760);
 if p_enabled is null then raise exception 'Specify true or false.'; end if;
 update khub_bot.mr_a_escrow_config set enabled=p_enabled where id;
end; $$;
-- Only gates NEW auctions; disabling never abandons accepted player assets.
alter function public.create_mr_a_auction(jsonb,bigint) set schema khub_bot;
alter function khub_bot.create_mr_a_auction(jsonb,bigint) rename to create_mr_a_direct;
revoke all on function khub_bot.create_mr_a_direct(jsonb,bigint) from public,anon,authenticated,service_role;
create function public.create_mr_a_auction(p_listing jsonb,p_rate bigint) returns uuid
language plpgsql security definer set search_path='' as $$
declare aid uuid; ending timestamptz:=(p_listing->>'customEndAt')::timestamptz;
begin
 if coalesce((p_listing->>'escrowMode')::boolean,true) is false then
   return khub_bot.create_mr_a_direct(p_listing,p_rate);
 end if;
 perform pg_advisory_xact_lock(3888760);
 perform khub_bot.require_verified_trader();
 if not (select enabled from khub_bot.mr_a_escrow_config where id) then raise exception 'Mr. A escrow creation is not enabled yet.'; end if;
 if p_rate is null or coalesce(p_listing->>'auctionKind','sell') not in ('sell','bundle') or p_listing ? 'giveawayTitle' then
   raise exception 'Mr. A payments require an ordinary Sell or Bundle auction.';
 end if;
 if coalesce((p_listing->>'autoRelist')::boolean,false) then
   aid:=public.create_relisting_auction(p_listing,(p_listing->>'relistCount')::integer,(p_listing->>'relistReduction')::integer);
 elsif jsonb_array_length(coalesce(p_listing->'bundleItems','[]'::jsonb))>0 then
   aid:=public.create_bundle_auction(p_listing->'bundleItems',(p_listing->>'minBidMeat')::bigint,
     (p_listing->>'auctionTime')::integer,(p_listing->>'instantPurchasePrice')::bigint,true,ending,
     p_listing->>'bundleTitle',(p_listing->>'bundleImageItemId')::integer);
 elsif ending is not null then
   aid:=public.create_auction(p_listing->>'item',(p_listing->>'quantity')::bigint,(p_listing->>'minBidMeat')::bigint,
     (p_listing->>'auctionTime')::integer,null,(p_listing->>'instantPurchasePrice')::bigint,(p_listing->>'itemId')::integer,true,ending);
 else
   aid:=public.create_auction(p_listing->>'item',(p_listing->>'quantity')::bigint,(p_listing->>'minBidMeat')::bigint,
     (p_listing->>'auctionTime')::integer,null,(p_listing->>'instantPurchasePrice')::bigint,(p_listing->>'itemId')::integer,true);
 end if;
 update public.auctions set mr_a_rate=p_rate where id=aid;
 return aid;
end; $$;

create function khub_bot.mr_a_items(p_quantity bigint) returns jsonb
language sql immutable set search_path='' as $$
 select case when p_quantity>0 then jsonb_build_array(jsonb_build_object('id',194,'quantity',p_quantity)) else '[]'::jsonb end;
$$;

-- Escrow writers must supply the physical composition; never normalize a
-- malformed mixed reserve into invented Meat. Legacy Direct normalization stays.
create or replace function khub_bot.record_meat_bid_composition() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.payment_meat::numeric+new.payment_mr_a::numeric*new.mr_a_rate is distinct from new.current_bid::numeric then
   if new.escrow_mode and new.current_bid>0 then raise exception 'Mixed escrow reserve does not match bid value.'; end if;
   new.payment_meat:=new.current_bid; new.payment_mr_a:=0;
 end if;
 return new;
end; $$;
create function khub_bot.guard_frozen_payment() returns trigger
language plpgsql set search_path='' as $$
begin
 if old.finalized_at is not null and (new.payment_meat,new.payment_mr_a) is distinct from (old.payment_meat,old.payment_mr_a) then
   raise exception 'Finalized payment composition is immutable.';
 end if;
 return new;
end; $$;
create trigger guard_frozen_payment before update of payment_meat,payment_mr_a on public.auctions
 for each row when (old.mr_a_rate is not null and old.finalized_at is not null) execute function khub_bot.guard_frozen_payment();

-- Freeze calculated/collected fees separately, including promotional volume.
-- Replays validate exact identity and return the original collected amount.
create table khub_bot.mixed_sell_fees(
 auction_id uuid primary key references public.auctions(id),seller_id uuid not null,
 value bigint not null,meat bigint not null,mr_a bigint not null,
 calculated bigint not null check(calculated>=0),collected bigint not null check(collected>=0 and collected<=meat and collected<=calculated)
);
alter table khub_bot.mixed_sell_fees enable row level security;
revoke all on khub_bot.mixed_sell_fees from public,anon,authenticated,service_role;
create function khub_bot.settle_mr_a_fee(a public.auctions) returns bigint
language plpgsql set search_path='' as $$
declare prior khub_bot.mixed_sell_fees%rowtype; calculated bigint; collected bigint;
begin
 perform pg_advisory_xact_lock(3888760);
 select * into prior from khub_bot.mixed_sell_fees where auction_id=a.id;
 if found then
   if (prior.seller_id,prior.value,prior.meat,prior.mr_a) is distinct from
      (a.seller_id,a.current_bid,a.payment_meat,a.payment_mr_a) then raise exception 'Mixed settlement identity changed.'; end if;
   return prior.collected;
 end if;
 if a.mr_a_rate is null or a.payment_meat is null or a.payment_meat::numeric+a.payment_mr_a::numeric*a.mr_a_rate<>a.current_bid then
   raise exception 'Mixed settlement composition is invalid.';
 end if;
 calculated:=khub_bot.settle_escrow_fee('sell:'||a.id,a.seller_id,a.current_bid,khub_bot.auction_sale_fee(a.current_bid,a.fee_policy,a.fee_bps));
 collected:=least(calculated,a.payment_meat);
 insert into khub_bot.mixed_sell_fees values(a.id,a.seller_id,a.current_bid,a.payment_meat,a.payment_mr_a,calculated,collected);
 update khub_bot.promotional_escrow_volume set fee=collected where transaction_key='sell:'||a.id;
 update public.auctions set calculated_fee_meat=calculated,waived_fee_meat=calculated-collected where id=a.id;
 return collected;
end; $$;

-- Exact, fail-closed source patches retain all installed intake/receipt/grace/
-- giveaway/bundle/relisting wrappers. Unexpected installed definitions abort.
create function pg_temp.mr_patch(p_target regprocedure,p_old text,p_new text) returns void language plpgsql as $$
declare d text:=pg_get_functiondef(p_target);
begin
 if strpos(d,p_old)=0 then raise exception 'Missing Mr. A patch anchor in %: %',p_target,p_old; end if;
 execute replace(d,p_old,p_new);
end; $$;
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$old_bid bigint;$old$,$new$old_bid bigint; bid_value numeric; mr_quantity bigint:=0; accepted_meat bigint;$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$(x->>'quantity')::bigint>5000000000$old$,$new$(x->>'quantity')::numeric>case when (x->>'id')::integer=194 then 9007199254740991 else 5000000000 end$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$if exists(select 1 from khub_bot.receipts where mail_id=mid) then$old$,$new$if (select count(*)<>count(distinct x->>'id') from jsonb_array_elements(attachments) x) then raise exception 'Duplicate normalized attachment IDs; retain for review.'; end if;
    if exists(select 1 from khub_bot.receipts where mail_id=mid) then$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$else
            if a.status$old$,$new$else
            bid_value:=meat;
            if a.mr_a_rate is not null and jsonb_array_length(attachments)=1 and (attachments->0->>'id')::integer=194 then
                mr_quantity:=(attachments->0->>'quantity')::bigint; bid_value:=meat::numeric+mr_quantity::numeric*a.mr_a_rate;
            end if;
            if a.status$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$elsif jsonb_array_length(attachments)<>0 then reason:='Bids must contain Meat only, without items.';$old$,$new$elsif jsonb_array_length(attachments)<>0 and (a.mr_a_rate is null or jsonb_array_length(attachments)<>1 or (attachments->0->>'id')::integer<>194) then reason:=case when a.mr_a_rate is null then 'Bids must contain Meat only, without items.' else 'This bid contains unsupported payment items.' end;
            elsif bid_value>9007199254740991 then reason:='Payment value exceeds the exact integer limit.';
            elsif a.instant_purchase_price is not null and mr_quantity::numeric*coalesce(a.mr_a_rate,0)>a.instant_purchase_price then reason:='Mr. A portion exceeds the buyout; choose fewer Mr. A''s.';$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$elsif cmd='buy' and meat<a.instant_purchase_price then reason:='The attached Meat does not meet the instant purchase price.';
            elsif (a.giveaway_title is not null and meat<>least(khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid),coalesce(a.instant_purchase_price,9007199254740991))) or meat<a.min_bid_meat or meat<=a.current_bid or meat>9007199254740991 or ((a.instant_purchase_price is null or meat<a.instant_purchase_price) and meat<khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid)) then reason:=case when khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid)>9007199254740991 then 'The maximum supported bid has been reached.' else 'Send your full bid of at least '||khub_bot.format_message_number(least(khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid),coalesce(a.instant_purchase_price,khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid))))||' Meat. Bid increases depend on the current highest bid.' end;$old$,$new$elsif cmd='buy' and bid_value<a.instant_purchase_price then reason:='The attached Meat does not meet the instant purchase price.';
            elsif (a.giveaway_title is not null and bid_value<>least(khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid),coalesce(a.instant_purchase_price,9007199254740991))) or bid_value<a.min_bid_meat or bid_value<=a.current_bid or bid_value>9007199254740991 or ((a.instant_purchase_price is null or bid_value<a.instant_purchase_price) and bid_value<khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid)) then reason:=case when khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid)>9007199254740991 then 'The maximum supported bid has been reached.' else 'Send your full bid of at least '||khub_bot.format_message_number(least(khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid),coalesce(a.instant_purchase_price,khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid))))||' Meat. Bid increases depend on the current highest bid.' end;$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$accepted:=case when a.instant_purchase_price is not null and meat>=a.instant_purchase_price then a.instant_purchase_price else meat end;$old$,$new$accepted:=case when a.instant_purchase_price is not null and bid_value>=a.instant_purchase_price then a.instant_purchase_price else bid_value::bigint end;
                accepted_meat:=accepted::numeric-mr_quantity::numeric*coalesce(a.mr_a_rate,0);$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$old_bid:=a.current_bid;$old$,$new$old_bid:=coalesce(a.payment_meat,a.current_bid);$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$'refund',old_bid,'[]'$old$,$new$'refund',old_bid,khub_bot.mr_a_items(a.payment_mr_a)$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$insert into public.bids(auction_id,bidder_id,bidder_username,amount) values(aid,u.id,u.khub_username,accepted)$old$,$new$insert into public.bids(auction_id,bidder_id,bidder_username,amount,payment_meat,payment_mr_a) values(aid,u.id,u.khub_username,accepted,case when a.mr_a_rate is null then null else accepted_meat end,mr_quantity)$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$update public.auctions set current_bid=accepted,$old$,$new$update public.auctions set payment_meat=case when a.mr_a_rate is null then null else accepted_meat end,payment_mr_a=mr_quantity,current_bid=accepted,$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$if meat>accepted then$old$,$new$if meat>accepted_meat then$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,$old$'refund',meat-accepted,'[]'$old$,$new$'refund',meat-accepted_meat,'[]'$new$);
select pg_temp.mr_patch('khub_bot.finish_listing_before_receipt_time(uuid,text)'::regprocedure,$old$khub_bot.settle_escrow_fee('sell:'||a.id,a.seller_id,a.current_bid,khub_bot.auction_sale_fee(a.current_bid,a.fee_policy,a.fee_bps))$old$,$new$case when a.mr_a_rate is not null then khub_bot.settle_mr_a_fee(a) else khub_bot.settle_escrow_fee('sell:'||a.id,a.seller_id,a.current_bid,khub_bot.auction_sale_fee(a.current_bid,a.fee_policy,a.fee_bps)) end$new$);
select pg_temp.mr_patch('khub_bot.finish_listing_before_receipt_time(uuid,text)'::regprocedure,$old$if a.current_bid-fee>0 then$old$,$new$if coalesce(a.payment_meat,a.current_bid)-fee>0 or a.payment_mr_a>0 then$new$);
select pg_temp.mr_patch('khub_bot.finish_listing_before_receipt_time(uuid,text)'::regprocedure,$old$'sale_meat',a.current_bid-fee,'[]'$old$,$new$'sale_meat',coalesce(a.payment_meat,a.current_bid)-fee,khub_bot.mr_a_items(a.payment_mr_a)$new$);
select pg_temp.mr_patch('khub_bot.liabilities_before_incoming_gifts()'::regprocedure,$old$a.status='active' and a.item_escrowed_at$old$,$new$(a.status='active' or (a.mr_a_rate is not null and a.status='on_hold')) and a.item_escrowed_at$new$);
select pg_temp.mr_patch('khub_bot.liabilities_before_incoming_gifts()'::regprocedure,$old$union all select null,0,current_bid from public.auctions where auction_kind='sell' and escrow_mode and status='active'$old$,$new$union all select physical.item_id,physical.quantity,physical.meat from public.auctions a
        cross join lateral (values (null::integer,0::bigint,coalesce(a.payment_meat,a.current_bid)),
            (194,a.payment_mr_a,0::bigint)) physical(item_id,quantity,meat)
        where a.auction_kind='sell' and a.escrow_mode and (a.status='active' or (a.mr_a_rate is not null and a.status='on_hold'))
            and (physical.quantity>0 or physical.meat>0)$new$);

-- Item and Meat rows already use deterministic queue keys, batching, exact
-- claims/acks and unknown-send reserves. No new transfer or recovery path.
-- Mark only new mixed payment messages. Legacy messages use the original
-- formatter immediately, avoiding a redundant auction lookup at dispatch.
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,
 $old$'Auction '||aid||': your previous bid is refunded in full.'$old$,
 $new$'Auction '||aid||': your previous bid is refunded in full.'||case when a.mr_a_rate is not null then E'\n[MrA payment]' else '' end$new$);
select pg_temp.mr_patch('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure,
 $old$'Auction '||aid||': your funded bid of '||accepted||' Meat was accepted.'$old$,
 $new$'Auction '||aid||': your funded bid of '||accepted||' Meat was accepted.'||case when a.mr_a_rate is not null then E'\n[MrA payment]' else '' end$new$);
select pg_temp.mr_patch('khub_bot.finish_listing_before_receipt_time(uuid,text)'::regprocedure,
 $old$'Auction '||p_id||': seller payment; fee '||fee||' Meat.'$old$,
 $new$'Auction '||p_id||': seller payment; fee '||fee||' Meat.'||case when a.mr_a_rate is not null then E'\n[MrA payment]' else '' end$new$);
alter function khub_bot.friendly_message(khub_bot.deliveries) rename to friendly_before_mr_a_escrow;
create function khub_bot.friendly_message(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
declare a public.auctions%rowtype; b public.bids%rowtype; body text; attached text;
begin
 if strpos(d.message,'[MrA payment]')=0 then return khub_bot.friendly_before_mr_a_escrow(d); end if;
 if d.auction_id is not null then select * into a from public.auctions where id=d.auction_id; end if;
 if a.mr_a_rate is null then return khub_bot.friendly_before_mr_a_escrow(d); end if;
 attached:=khub_bot.format_message_number(d.meat)||' Meat'
   ||case when d.item_id=194 then ' + '||khub_bot.format_message_number(d.quantity)||' Mr. A(s)' else '' end;
 if d.kind='sale_meat' then
   return 'Auction #'||a.auction_number||E' sold.\nWinning payment: '||khub_bot.direct_payment_label(a)
    ||E'\nCommission collected: '||khub_bot.format_message_number(a.fee_meat)||' Meat'
    ||E'\nCommission permanently waived: '||khub_bot.format_message_number(a.waived_fee_meat)||' Meat'
    ||E'\nSeller proceeds: '||khub_bot.format_message_number(a.payment_meat-a.fee_meat)||' Meat + '||khub_bot.format_message_number(a.payment_mr_a)||' Mr. A(s)'
    ||E'\nAttached in this message: '||attached||E'. Other portions may arrive separately.';
 elsif d.dedupe_key like 'bid-accepted:%' then
   select bids.* into strict b from public.bids bids join khub_bot.bid_receipts br on br.bid_id=bids.id where br.receipt_id=d.receipt_id;
   return 'Auction #'||a.auction_number||E': Bid accepted.\nEscrow holds '||khub_bot.format_message_number(b.payment_meat)||' Meat + '
    ||khub_bot.format_message_number(b.payment_mr_a)||' Mr. A(s), worth '||khub_bot.format_message_number(b.amount)||' Meat at the fixed rate.';
 elsif d.dedupe_key like 'outbid:%' then
   return 'Auction #'||a.auction_number||E': You have been outbid. Your original payment is returned in full across these messages.\nAttached: '||attached||'.';
 end if;
 return khub_bot.friendly_before_mr_a_escrow(d);
end; $$;
-- New rejection reasons remain safe and actionable, without raw input echoing.
alter function khub_bot.friendly_reason(text) rename to friendly_reason_before_mr_a;
create function khub_bot.friendly_reason(p_reason text) returns text language sql immutable set search_path='' as $$
 select case p_reason
 when 'Mr. A portion exceeds the buyout; choose fewer Mr. A''s.' then 'The Mr. A portion alone exceeds the buyout. All payment assets are returned. Choose fewer Mr. A''s and top up with Meat.'
 when 'This bid contains unsupported payment items.' then 'Only Meat and, when enabled on the listing, Mr. Accessories can pay for bids. All original payment assets are returned.'
 when 'Payment value exceeds the exact integer limit.' then 'The payment exceeds the supported exact integer value. All original payment assets are returned.'
 else khub_bot.friendly_reason_before_mr_a(p_reason) end;
$$;
-- Report projections reuse their existing scans/pages. Value stays equivalent;
-- seller proceeds and currency quantities describe physical assets only.
do $$ declare r record; d text; n integer:=0; begin
 for r in select p.oid from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname in ('public','khub_bot') and p.prokind='f'
   and strpos(p.prosrc,'''seller_proceeds_meat''')>0 loop
   d:=pg_get_functiondef(r.oid);
   if strpos(d,'sum(current_bid::numeric-fee_meat)')>0 then
     d:=replace(d,'sum(current_bid::numeric-fee_meat)','sum(coalesce(payment_meat,current_bid)::numeric-fee_meat)');
     d:=replace(d,'''seller_proceeds_meat'',','''seller_proceeds_mr_a'',(select coalesce(sum(payment_mr_a::numeric),0)::text from sales),''waived_commission_meat'',(select coalesce(sum(waived_fee_meat::numeric),0)::text from sales),''seller_proceeds_meat'',');
     n:=n+1;
   end if;
   if strpos(d,'(a.current_bid-a.fee_meat)::text')>0 then
     d:=replace(d,'(a.current_bid-a.fee_meat)::text','(coalesce(a.payment_meat,a.current_bid)-a.fee_meat)::text');
     d:=replace(d,'''sale_meat'',a.current_bid::text,','''sale_meat'',a.current_bid::text,''payment_meat'',coalesce(a.payment_meat,a.current_bid)::text,''payment_mr_a'',a.payment_mr_a::text,''waived_fee_meat'',a.waived_fee_meat::text,');
     n:=n+1;
   end if;
   execute d;
 end loop;
 if n<>2 then raise exception 'Unexpected financial report projections: %',n; end if;
end; $$;
select pg_temp.mr_patch('public.submit_trade_query(uuid,uuid,text)'::regprocedure,
 $old$khub_bot.format_message_number(a.final_price)||' Meat'$old$,$new$khub_bot.direct_payment_label(a)$new$);
select pg_temp.mr_patch('khub_bot.refresh_site_trade_totals()'::regprocedure,
 $old$else a.quantity::numeric end as units$old$,$new$else a.quantity::numeric end+a.payment_mr_a::numeric as units$new$);
-- Admin recovery links include the item portion of outbid refunds. Ordinary
-- viewers still receive no administrative delivery references.
select pg_temp.mr_patch('khub_bot.admin_bid_delivery_references(uuid)'::regprocedure,
 $old$d.dedupe_key like 'outbid:'||next_link.receipt_id||':meat:%'$old$,
 $new$(d.dedupe_key like 'outbid:'||next_link.receipt_id||':meat:%' or d.dedupe_key like 'outbid:'||next_link.receipt_id||':item:194:%')$new$);
-- Public fee fields flow through the existing permission-dependent reader only.
alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to public_auction_before_mr_a_escrow;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language sql stable security definer set search_path='' as $$
 select khub_bot.public_auction_before_mr_a_escrow(a,p_bid_count,p_highest_label,p_winner_label)
 ||jsonb_build_object('calculated_fee_meat',a.calculated_fee_meat,'waived_fee_meat',a.waived_fee_meat);
$$;
revoke all on function public.create_mr_a_auction(jsonb,bigint),public.set_mr_a_escrow_enabled(boolean),
 khub_bot.mr_a_items(bigint),khub_bot.settle_mr_a_fee(public.auctions),khub_bot.friendly_before_mr_a_escrow(khub_bot.deliveries),
 khub_bot.guard_frozen_payment(),
 khub_bot.friendly_message(khub_bot.deliveries),khub_bot.friendly_reason_before_mr_a(text),khub_bot.friendly_reason(text),
 khub_bot.public_auction_before_mr_a_escrow(public.auctions,bigint,text,text),khub_bot.public_auction(public.auctions,bigint,text,text)
 from public,anon,authenticated,service_role;
grant execute on function public.create_mr_a_auction(jsonb,bigint) to authenticated;
grant execute on function public.set_mr_a_escrow_enabled(boolean) to service_role;
notify pgrst,'reload schema';
commit;
