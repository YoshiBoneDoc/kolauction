-- Stop workers while applying. No historical rows are backfilled.
begin;
select pg_advisory_xact_lock(3888760);
create table khub_bot.escrow_promotion_config(id boolean primary key default true check(id), enabled boolean not null);
insert into khub_bot.escrow_promotion_config values(true,true);
create table khub_bot.promotional_escrow_volume(
    transaction_key text primary key, user_id uuid not null references public.profiles(id),
    volume numeric not null check(volume>0), fee bigint not null check(fee>=0),
    created_at timestamptz not null default clock_timestamp()
);
create index promotional_escrow_user on khub_bot.promotional_escrow_volume(user_id);
alter table khub_bot.escrow_promotion_config enable row level security;
alter table khub_bot.promotional_escrow_volume enable row level security;
revoke all on khub_bot.escrow_promotion_config,khub_bot.promotional_escrow_volume from public,anon,authenticated,service_role;

create function khub_bot.promotional_fee(p_price bigint) returns bigint
language sql immutable set search_path='' as $$
 select floor((least(p_price,1000000000)::numeric*200+greatest(p_price-1000000000,0)::numeric*100)/10000)::bigint;
$$;
create function khub_bot.current_escrow_fee(p_user uuid,p_price bigint,p_original bigint) returns bigint
language sql stable set search_path='' as $$
 select case when not (select enabled from khub_bot.escrow_promotion_config where id) then p_original
 when coalesce((select sum(volume) from khub_bot.promotional_escrow_volume where user_id=p_user),0)<20000000 then 0
 else khub_bot.promotional_fee(p_price) end;
$$;
create function khub_bot.settle_escrow_fee(p_key text,p_user uuid,p_price bigint,p_original bigint) returns bigint
language plpgsql set search_path='' as $$
declare result bigint; prior khub_bot.promotional_escrow_volume%rowtype;
begin
 perform pg_advisory_xact_lock(3888760);
 select * into prior from khub_bot.promotional_escrow_volume where transaction_key=p_key;
 if found then
   if prior.user_id<>p_user or prior.volume<>p_price then raise exception 'Promotional settlement identity changed.'; end if;
   return prior.fee;
 end if;
 if p_price is null or p_price<=0 or p_original<0 then raise exception 'Invalid settlement amount.'; end if;
 result:=khub_bot.current_escrow_fee(p_user,p_price,p_original);
 if (select enabled from khub_bot.escrow_promotion_config where id) then
   insert into khub_bot.promotional_escrow_volume values(p_key,p_user,p_price,result,clock_timestamp());
 end if;
 return result;
end; $$;
-- All entry points already hold the same financial lock. Keep their original
-- retry guards, receipt identity checks, reservations and accounting updates.
do $$
declare d text; old text; replacement text;
begin
 old:='khub_bot.auction_sale_fee(a.current_bid,a.fee_policy,a.fee_bps)';
 replacement:='khub_bot.settle_escrow_fee(''sell:''||a.id,a.seller_id,a.current_bid,'||old||')';
 d:=pg_get_functiondef('khub_bot.finish_listing_before_receipt_time(uuid,text)'::regprocedure);
 if strpos(d,old)=0 then raise exception 'Sell fee anchor missing'; end if;
 execute replace(d,old,replacement);
 old:='fee:=floor(khub_bot.buy_fee_numerator(a.min_bid_meat)*accepted/10000)::bigint;';
 replacement:='fee:=khub_bot.settle_escrow_fee(''buy:''||mid,a.seller_id,payment,floor(khub_bot.buy_fee_numerator(a.min_bid_meat)*accepted/10000)::bigint);';
 d:=pg_get_functiondef('khub_bot.ingest_before_buy_reservations(jsonb)'::regprocedure);
 if strpos(d,old)=0 then raise exception 'Buy fee anchor missing'; end if;
 execute replace(d,old,replacement);
end; $$;
create function public.escrow_fee_preview(p_price bigint) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_price is null or p_price<0 or p_price>9007199254740991 then raise exception 'Invalid price'; end if;
 return jsonb_build_object('enabled',(select enabled from khub_bot.escrow_promotion_config where id),
 'volume',coalesce((select sum(volume) from khub_bot.promotional_escrow_volume where user_id=auth.uid()),0)::text,
 'fee',khub_bot.current_escrow_fee(auth.uid(),p_price,khub_bot.tiered_escrow_fee(p_price))::text);
end; $$;
create function public.set_escrow_promotion(p_enabled boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(3888760);
 if p_enabled is null then raise exception 'Specify true or false'; end if;
 update khub_bot.escrow_promotion_config set enabled=p_enabled where id;
 -- Original-rate reserves remain held as a rollback buffer. Existing reservation
 -- commitments and purchase principal remain untouched; closing refunds surplus.
end; $$;
revoke all on function khub_bot.promotional_fee(bigint),khub_bot.current_escrow_fee(uuid,bigint,bigint),khub_bot.settle_escrow_fee(text,uuid,bigint,bigint),public.set_escrow_promotion(boolean) from public,anon,authenticated,service_role;
grant execute on function public.set_escrow_promotion(boolean) to service_role;
revoke all on function public.escrow_fee_preview(bigint) from public;
grant execute on function public.escrow_fee_preview(bigint) to anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
