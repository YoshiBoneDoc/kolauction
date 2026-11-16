-- After 284 (and 108 market prices). Apply once per database, then deploy website.
-- Donation ranking only. Never adds estimated value to spendable Meat or transfers.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

create table khub_bot.donation_item_values (
 receipt_id text primary key references khub_bot.receipts(mail_id) on delete cascade,
 received_at timestamptz not null,
 captured_at timestamptz not null default clock_timestamp(),
 items jsonb not null,
 value_meat numeric not null check(value_meat>=0)
);
alter table khub_bot.donation_item_values enable row level security;
revoke all on khub_bot.donation_item_values from public,anon,authenticated,service_role;

-- Keep exactly one previous observation per item so the daily price import does
-- not erase the receipt-time quote while a donation is waiting for intake. Storage
-- is bounded by catalog size; no historical price scans or new refresh job.
create table khub_bot.previous_donation_market_prices (
 item_id integer primary key,
 price_meat bigint,
 observed_at timestamptz,
 checked_at timestamptz not null,
 available boolean not null
);
alter table khub_bot.previous_donation_market_prices enable row level security;
revoke all on khub_bot.previous_donation_market_prices from public,anon,authenticated,service_role;
create function khub_bot.retain_previous_donation_quote() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.checked_at>old.checked_at then
   insert into khub_bot.previous_donation_market_prices(item_id,price_meat,observed_at,checked_at,available)
   values(old.item_id,old.price_meat,old.observed_at,old.checked_at,old.available)
   on conflict(item_id) do update set price_meat=excluded.price_meat,observed_at=excluded.observed_at,
     checked_at=excluded.checked_at,available=excluded.available;
 end if;
 return null;
end;$$;
revoke all on function khub_bot.retain_previous_donation_quote() from public,anon,authenticated,service_role;
create trigger retain_previous_donation_quote after update on khub_bot.market_prices
for each row when (new.checked_at>old.checked_at) execute function khub_bot.retain_previous_donation_quote();

-- Use the established 26-hour fresh-quote window, evaluated at the donation's
-- receipt time. A quote observed/checked AFTER receipt is not historical evidence.
-- Missing, unavailable, stale and newer quotes remain explicitly unvalued. Never
-- reprice a captured donation when the market changes or a receipt is replayed.
create function khub_bot.donation_item_quote(p_received_at timestamptz,p_items jsonb) returns jsonb
language sql stable set search_path='' as $$
 with lines as (
   select (x->>'id')::integer item_id,sum((x->>'quantity')::numeric) quantity
   from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) x group by (x->>'id')::integer
 ), quoted as (
   select l.*,m.observed_at,m.checked_at,
     case when m.item_id is null or m.observed_at>p_received_at then 'no_historical_quote'
          when not m.available or m.price_meat is null then 'unavailable'
          when m.observed_at<=p_received_at-interval '26 hours' or m.checked_at<=p_received_at-interval '26 hours' then 'stale'
          else 'valued' end status,m.price_meat
   from lines l left join lateral (
     select q.* from (
       select item_id,price_meat,observed_at,checked_at,available from khub_bot.market_prices where item_id=l.item_id
       union all
       select item_id,price_meat,observed_at,checked_at,available from khub_bot.previous_donation_market_prices where item_id=l.item_id
     ) q where q.checked_at<=p_received_at order by q.checked_at desc limit 1
   ) m on true
 ) select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
   'item_id',item_id,'quantity',quantity::text,'status',status,
   'unit_price_meat',case when status='valued' then price_meat::text end,
   'observed_at',observed_at,'checked_at',checked_at) order by item_id),'[]'::jsonb),
   'value_meat',coalesce(sum(case when status='valued' then quantity*price_meat::numeric else 0 end),0)::text)
 from quoted;
$$;
revoke all on function khub_bot.donation_item_quote(timestamptz,jsonb) from public,anon,authenticated,service_role;

create function khub_bot.capture_donation_item_value() returns trigger
language plpgsql security definer set search_path='' as $$
declare quote jsonb;
begin
 if new.result is distinct from 'donation' or new.payload#>>'{raw,type}' is distinct from 'normal'
   or coalesce(new.payload#>>'{raw,message}','') !~* '^[[:space:]]*DONATE[[:space:]]*(<|$)'
   or exists(select 1 from khub_bot.donation_item_values where receipt_id=new.mail_id) then return null; end if;
 quote:=khub_bot.donation_item_quote(new.received_at,new.payload->'items');
 insert into khub_bot.donation_item_values(receipt_id,received_at,items,value_meat)
 values(new.mail_id,new.received_at,quote->'items',(quote->>'value_meat')::numeric)
 on conflict(receipt_id) do nothing;
 return null;
end;$$;
revoke all on function khub_bot.capture_donation_item_value() from public,anon,authenticated,service_role;
create trigger donation_item_value_capture after insert or update of result on khub_bot.receipts
for each row execute function khub_bot.capture_donation_item_value();

-- Existing receipts get credit only if the retained quote is valid AS OF receipt.
-- Only current/prior observations exist: newer quotes cannot reconstruct old values.
insert into khub_bot.donation_item_values(receipt_id,received_at,items,value_meat)
 select r.mail_id,r.received_at,q.value->'items',(q.value->>'value_meat')::numeric
 from khub_bot.report_donations() r
 cross join lateral (select khub_bot.donation_item_quote(r.received_at,r.payload->'items') value) q
 where r.payload#>>'{raw,type}'='normal';

do $$
declare definition text; old_sql text:=$old$   -- No speculative item/gift valuation or commission income in donor rankings.
   select p.id,0::numeric,0::bigint,sum((r.payload->>'meat')::numeric)
   from khub_bot.report_donations() r join public.profiles p on p.kol_player_id=r.sender_id and p.kol_verified_at is not null
   where r.payload#>>'{raw,type}'='normal' and (r.payload->>'meat')::numeric>0 group by p.id$old$;
 new_sql text:=$new$   -- Actual donated Meat plus immutable, receipt-time item reference values.
   -- Receipt eligibility still excludes fees, invalid mail and refunded donations.
   select p.id,0::numeric,0::bigint,
     sum(coalesce((r.payload->>'meat')::numeric,0)+coalesce(v.value_meat,0))
   from khub_bot.report_donations() r
   join public.profiles p on p.kol_player_id=r.sender_id and p.kol_verified_at is not null
   left join khub_bot.donation_item_values v on v.receipt_id=r.mail_id and v.received_at=r.received_at
   where r.payload#>>'{raw,type}'='normal'
     and coalesce((r.payload->>'meat')::numeric,0)+coalesce(v.value_meat,0)>0 group by p.id$new$;
begin
 definition:=pg_get_functiondef('khub_bot.refresh_leaderboards()'::regprocedure);
 if strpos(definition,'count(distinct auction_id)')=0 or strpos(definition,old_sql)=0 then
   raise exception 'Expected migration 284 leaderboard definition';
 end if;
 execute replace(definition,old_sql,new_sql);
end;$$;
-- Normal bounded-cadence maintenance rebuilds the snapshot after installation.
update khub_bot.leaderboard_state set refreshed_at='-infinity' where singleton;
insert into khub_bot.site_totals_dirty values(txid_current()) on conflict do nothing;
notify pgrst,'reload schema';
commit;
