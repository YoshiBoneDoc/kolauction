-- After 269. Financial integration remains disabled until explicit owner activation.
-- Preserve all pre-existing settlement guards and frozen financial rows.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
select pg_advisory_xact_lock(3888760);
create function khub_bot.lock_auction_fee_terms(p_id uuid,p_legacy boolean default false) returns void language plpgsql set search_path='' as $$
declare a public.auctions%rowtype;e jsonb;pid uuid;
begin
 select * into strict a from public.auctions where id=p_id;
 if not a.escrow_mode or exists(select 1 from khub_bot.auction_fee_terms where auction_id=p_id) then return;end if;
 e:=khub_bot.fee_eligibility(a.seller_id);
 pid:=khub_bot.live_escrow_promotion(clock_timestamp());
 -- November retains its original settlement-time selection, including manual end.
 if exists(select 1 from khub_bot.escrow_promotions where id=pid and legacy) then pid:=null;end if;
 insert into khub_bot.auction_fee_terms(auction_id,user_id,normal_bps,tier,promotion_id,legacy,eligibility)
 values(p_id,a.seller_id,array(select jsonb_array_elements_text(e->'bps')::integer),(e->>'tier')::integer,pid,p_legacy,e);
end;$$;
create function khub_bot.capture_auction_fee_terms() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.escrow_mode and (select enabled from khub_bot.fee_engine_state where singleton) then
  perform pg_advisory_xact_lock(3888760);perform khub_bot.lock_auction_fee_terms(new.id);
 end if;return new;
end;$$;
create trigger capture_auction_fee_terms after insert on public.auctions for each row execute function khub_bot.capture_auction_fee_terms();

-- A per-unit ceiling at the largest locked rate safely covers arbitrary partial
-- fills (including fills on opposite sides of a price bracket or allowance).
create function khub_bot.buy_fee_cap_bps(p_id uuid) returns integer language plpgsql stable set search_path='' as $$
declare t khub_bot.auction_fee_terms%rowtype; c jsonb; cap integer;
begin
 select * into t from khub_bot.auction_fee_terms where auction_id=p_id;
 if not found then return null;end if;
 select max(x) into cap from unnest(t.normal_bps)x;
 if t.promotion_id is not null then
  select config into c from khub_bot.escrow_promotions where id=t.promotion_id;
  if c->>'mode'='replace' and c->'tiers' @> to_jsonb(array[t.tier]) then
   select greatest(cap,max((b->>'bps')::integer)) into cap from jsonb_array_elements(c->'buy')b;
  end if;
 end if;
 return cap;
end;$$;
create function khub_bot.locked_buy_cost(p_id uuid,p_price bigint,p_quantity bigint) returns bigint language plpgsql stable set search_path='' as $$
declare cap integer;begin
 cap:=khub_bot.buy_fee_cap_bps(p_id);
 if cap is null then return khub_bot.buy_cost(p_price,p_quantity);end if;
 -- Existing orders retain their original funding/reservation ceiling; the new
 -- decision is always capped at their historical fee, so it cannot exceed it.
 if (select legacy from khub_bot.auction_fee_terms where auction_id=p_id) then return khub_bot.buy_cost(p_price,p_quantity);end if;
 return (p_price::numeric*p_quantity+ceil(p_price::numeric*cap/10000)*p_quantity)::bigint;
end;$$;
create function khub_bot.locked_buy_affordable(p_id uuid,p_price bigint,p_balance bigint,p_max bigint) returns bigint language plpgsql stable set search_path='' as $$
declare lo bigint:=0;hi bigint:=greatest(0,p_max);mid bigint;begin
 while lo<hi loop mid:=(lo+hi+1)/2;if khub_bot.locked_buy_cost(p_id,p_price,mid)<=p_balance then lo:=mid;else hi:=mid-1;end if;end loop;return lo;
end;$$;
create function khub_bot.capture_buy_funding() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;begin
 if exists(select 1 from khub_bot.auction_fee_terms where auction_id=new.auction_id) then
  select * into strict a from public.auctions where id=new.auction_id;
  new.funding_required:=khub_bot.locked_buy_cost(a.id,a.min_bid_meat,a.quantity);
  if new.funding_required>20000000000 then raise exception 'A buy order including its fee reserve cannot exceed 20 billion Meat.';end if;
 end if;return new;
end;$$;
create trigger capture_buy_funding before insert on khub_bot.buy_orders for each row execute function khub_bot.capture_buy_funding();

create function khub_bot.settle_locked_escrow_fee(p_id uuid,p_key text,p_user uuid,p_price bigint,p_original bigint,p_free boolean default false) returns bigint language plpgsql set search_path='' as $$
declare t khub_bot.auction_fee_terms%rowtype;prior khub_bot.escrow_fee_decisions%rowtype;p khub_bot.escrow_promotions%rowtype;fee bigint;normal bigint;volume numeric;kind text;
begin
 perform pg_advisory_xact_lock(3888760);
 select * into prior from khub_bot.escrow_fee_decisions where transaction_key=p_key;
 if found then
  if prior.auction_id<>p_id or prior.user_id<>p_user or prior.price<>p_price then raise exception 'Settlement identity changed';end if;
  return prior.fee;
 end if;
 -- An already recorded November decision must never be repriced.
 if exists(select 1 from khub_bot.promotional_escrow_volume where transaction_key=p_key) then
  return khub_bot.settle_escrow_fee(p_key,p_user,p_price,p_original);
 end if;
 select * into t from khub_bot.auction_fee_terms where auction_id=p_id;
 if not found then
  -- Disabled gate keeps the untouched legacy path. Once enabled, absent
  -- terms indicate a reconciliation problem; never silently select old fees.
  if (select enabled from khub_bot.fee_engine_state where singleton) then raise exception 'Fee terms missing; reconcile before settlement';end if;
  return khub_bot.settle_buy_escrow_fee(p_key,p_user,p_price,p_original,p_free);
 end if;
 if p_price is null or p_price<=0 or p_original is null or p_original<0 or p_user is distinct from t.user_id then raise exception 'Invalid fee settlement';end if;
 select auction_kind into kind from public.auctions where id=p_id;
 normal:=khub_bot.flat_band_fee(p_price,khub_bot.fee_bands(t.normal_bps));
 if t.legacy then normal:=least(normal,p_original);end if;
 if t.promotion_id is not null then select * into strict p from khub_bot.escrow_promotions where id=t.promotion_id;
 else
  -- November only: existing live trades retain the original runtime rules.
  select * into p from khub_bot.escrow_promotions where id=khub_bot.live_escrow_promotion(clock_timestamp()) and legacy;
 end if;
 fee:=normal;
 if p.id is not null then
  if p.legacy then select coalesce(sum(v.volume),0) into volume from khub_bot.promotional_escrow_volume v where user_id=p_user;
  else select coalesce((select b.volume from khub_bot.promotion_balances b where promotion_id=p.id and user_id=p_user),0) into volume;end if;
  fee:=khub_bot.promotion_fee(p_price,kind,p.config,normal,t.tier,(t.eligibility->>'donor')::boolean,volume,p.legacy,p_free and p.legacy);
  if p.legacy then
   insert into khub_bot.promotional_escrow_volume values(p_key,p_user,p_price,fee,clock_timestamp());
  elsif p.config->'tiers' @> to_jsonb(array[t.tier]) then
   insert into khub_bot.promotion_volume values(p_key,p.id,p_user,p_price);
   insert into khub_bot.promotion_balances values(p.id,p_user,p_price) on conflict(promotion_id,user_id) do update set volume=khub_bot.promotion_balances.volume+excluded.volume;
  end if;
 end if;
 -- Legacy funding must remain solvent even if the flat schedule is higher.
 if t.legacy then fee:=least(fee,p_original);end if;
 insert into khub_bot.escrow_fee_decisions(transaction_key,auction_id,user_id,price,fee,promotion_id,normal_fee) values(p_key,p_id,p_user,p_price,fee,p.id,normal);
 return fee;
end;$$;

-- Patch only exact known call sites; retain every surrounding accounting guard.
do $patch$
declare d text;f record;anchor text;replacement text;
begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='khub_bot' and p.prokind='f' and p.proname in ('finish_listing_before_receipt_time','settle_mr_a_fee') loop
  d:=pg_get_functiondef(f.signature);
  anchor:='khub_bot.settle_escrow_fee(''sell:''||a.id,a.seller_id,a.current_bid,khub_bot.auction_sale_fee(a.current_bid,a.fee_policy,a.fee_bps))';
  if strpos(d,anchor)=0 then raise exception 'Sell fee integration anchor missing in %',f.signature;end if;
  execute replace(d,anchor,'khub_bot.settle_locked_escrow_fee(a.id,''sell:''||a.id,a.seller_id,a.current_bid,khub_bot.auction_sale_fee(a.current_bid,a.fee_policy,a.fee_bps))');
 end loop;
 d:=pg_get_functiondef('khub_bot.ingest_before_buy_reservations(jsonb)'::regprocedure);
 anchor:='khub_bot.settle_buy_escrow_fee(''buy:''||mid,a.seller_id,payment,floor(khub_bot.buy_fee_numerator(a.min_bid_meat)*accepted/10000)::bigint,o.promotional_remaining_free)';
 if strpos(d,anchor)=0 then raise exception 'Buy fee integration anchor missing';end if;
 execute replace(d,anchor,'khub_bot.settle_locked_escrow_fee(a.id,''buy:''||mid,a.seller_id,payment,floor(khub_bot.buy_fee_numerator(a.min_bid_meat)*accepted/10000)::bigint,o.promotional_remaining_free)');
 -- Reservation/availability callers must use the same locked funding ceiling.
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','khub_bot') and p.prokind='f' and (strpos(p.prosrc,'khub_bot.buy_affordable(a.min_bid_meat,')>0 or strpos(p.prosrc,'khub_bot.buy_cost(a.min_bid_meat,')>0) loop
  d:=pg_get_functiondef(f.signature);
  d:=replace(d,'khub_bot.buy_affordable(a.min_bid_meat,','khub_bot.locked_buy_affordable(a.id,a.min_bid_meat,');
  d:=replace(d,'khub_bot.buy_cost(a.min_bid_meat,','khub_bot.locked_buy_cost(a.id,a.min_bid_meat,');execute d;
 end loop;
 d:=pg_get_functiondef('public.create_buy_auction(integer,bigint,bigint,integer,text)'::regprocedure);
 anchor:='total:=p_price_per_item::numeric*p_quantity+ceil(khub_bot.buy_fee_numerator(p_price_per_item)*p_quantity/10000);';
 if strpos(d,anchor)=0 then raise exception 'Buy creation anchor missing';end if;
 -- AFTER auction insert captures terms; BEFORE buy_order insert enforces final cap.
 replacement:='if p_price_per_item is null or p_price_per_item not between 1 and 20000000000 then raise exception ''Invalid buy price per item.'';end if;total:=case when (select enabled from khub_bot.fee_engine_state where singleton) then p_price_per_item::numeric*p_quantity else p_price_per_item::numeric*p_quantity+ceil(khub_bot.buy_fee_numerator(p_price_per_item)*p_quantity/10000) end;';
 execute replace(d,anchor,replacement);
end;$patch$;

-- Only the owner/service role can explicitly activate this separately from install.
-- Capture existing open trades once, never reset allowances or frozen decisions.
create function public.activate_escrow_fee_engine() returns void language plpgsql security definer set search_path='' as $$
declare a record;begin
 perform pg_advisory_xact_lock(3888760);
 if not exists(select 1 from khub_bot.fee_engine_state where singleton) then raise exception 'Fee engine configuration missing';end if;
 if (select enabled from khub_bot.fee_engine_state where singleton) then return;end if;
 for a in select id from public.auctions where escrow_mode and finalized_at is null and status in ('pending_escrow','active','on_hold') order by id loop perform khub_bot.lock_auction_fee_terms(a.id,true);end loop;
 update khub_bot.fee_engine_state set enabled=true where singleton;
end;$$;
revoke all on function public.activate_escrow_fee_engine() from public,anon,authenticated,service_role;
grant execute on function public.activate_escrow_fee_engine() to service_role;
do $$declare obj record;begin
 for obj in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='khub_bot' and p.proname in ('lock_auction_fee_terms','capture_auction_fee_terms','buy_fee_cap_bps','locked_buy_cost','locked_buy_affordable','capture_buy_funding','settle_locked_escrow_fee') loop execute format('revoke all on function %s from public,anon,authenticated,service_role',obj.signature);end loop;
end;$$;
notify pgrst,'reload schema';
commit;
