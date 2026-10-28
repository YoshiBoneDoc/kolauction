-- Apply after 068 with all workers stopped, then restart the bot and deploy the website.
-- Open standard-rate escrow listings receive the lower schedule. Existing free/
-- discounted flat terms, finalized payouts, frozen messages and ledgers stay intact.
begin;
select pg_advisory_xact_lock(3888760);
alter table public.auctions add column fee_policy text not null default 'flat'
    check (fee_policy in ('flat','tiered_v1'));
update public.auctions set fee_policy='tiered_v1'
    where escrow_mode and finalized_at is null and status in ('pending_escrow','active') and fee_bps>=500;
update khub_bot.settings set fee_bps=500 where id;
alter table khub_bot.settings alter column fee_bps set default 500;

-- Exact basis-point numerator, rounded down ONCE after adding all portions.
create function khub_bot.tiered_escrow_fee(p_price bigint) returns bigint
language plpgsql immutable set search_path='' as $$
begin
    if p_price is null or p_price<0 or p_price>9007199254740991 then raise exception 'Invalid escrow sale price.'; end if;
    return floor((
        least(p_price,1000000)::numeric*500
        +least(greatest(p_price-1000000,0),9000000)::numeric*400
        +least(greatest(p_price-10000000,0),90000000)::numeric*300
        +least(greatest(p_price-100000000,0),900000000)::numeric*200
        +greatest(p_price-1000000000,0)::numeric*100
    )/10000)::bigint;
end; $$;
create function khub_bot.auction_sale_fee(p_price bigint,p_policy text,p_flat_bps integer) returns bigint
language plpgsql immutable set search_path='' as $$
begin
    if p_policy='tiered_v1' then return khub_bot.tiered_escrow_fee(p_price); end if;
    if p_policy is distinct from 'flat' or p_price is null or p_price<0 or p_price>9007199254740991
        or p_flat_bps is null or p_flat_bps not between 0 and 10000 then raise exception 'Invalid auction fee terms.'; end if;
    return floor(p_price::numeric*p_flat_bps/10000)::bigint;
end; $$;
revoke all on function khub_bot.tiered_escrow_fee(bigint),khub_bot.auction_sale_fee(bigint,text,integer) from public,anon,authenticated,service_role;

-- All new escrow listings use this schedule; clients cannot choose a cheaper policy
-- or edit one after publishing. fee_bps remains the legacy flat-rate snapshot only.
create function khub_bot.assign_auction_fee_policy() returns trigger
language plpgsql set search_path='' as $$
begin
    if tg_op='INSERT' then
        new.fee_policy:=case when new.escrow_mode then 'tiered_v1' else 'flat' end;
        new.fee_bps:=case when new.escrow_mode then 500 else 0 end;
    elsif new.fee_policy is distinct from old.fee_policy then
        raise exception 'The auction fee policy is fixed when a listing is published.';
    end if;
    return new;
end; $$;
create trigger auctions_assign_fee_policy before insert or update of fee_policy on public.auctions
    for each row execute function khub_bot.assign_auction_fee_policy();
revoke all on function khub_bot.assign_auction_fee_policy() from public,anon,authenticated,service_role;

-- Patch the authoritative close path used by BOTH deadline and buyout settlement.
-- Keep locking, guards, split deliveries, refunds and finalization idempotency intact.
do $$
declare definition text;
    old_fee text:=$old$fee:=case when outcome='completed' then floor(a.current_bid::numeric*a.fee_bps/10000)::bigint else 0 end;$old$;
    new_fee text:=$new$fee:=case when outcome='completed' then khub_bot.auction_sale_fee(a.current_bid,a.fee_policy,a.fee_bps) else 0 end;$new$;
begin
    definition:=pg_get_functiondef('khub_bot.finish_listing(uuid,text)'::regprocedure);
    if strpos(definition,old_fee)=0 then raise exception 'Unexpected escrow fee implementation; migration not applied.'; end if;
    execute replace(definition,old_fee,new_fee);
end; $$;

-- Tiered messages show the actual fee, never a misleading flat 5% label.
-- Historical flat-rate messages keep their recorded rate. Frozen bodies stay frozen.
do $$
declare definition text;
    old_label text:=$old$||E'\nCommission ('||commission||'%): '||to_char(a.fee_meat,$old$;
    new_label text:=$new$||case when a.fee_policy='tiered_v1' then E'\nCommission (tiered): ' else E'\nCommission ('||commission||'%): ' end||to_char(a.fee_meat,$new$;
begin
    definition:=pg_get_functiondef('khub_bot.friendly_message(khub_bot.deliveries)'::regprocedure);
    if strpos(definition,old_label)=0 then raise exception 'Unexpected seller commission message; migration not applied.'; end if;
    execute replace(definition,old_label,new_label);
end; $$;

alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to public_auction_before_tiered_fees;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language sql stable security definer set search_path='' as $$
    select khub_bot.public_auction_before_tiered_fees(a,p_bid_count,p_highest_label,p_winner_label)
        ||jsonb_build_object('fee_policy',a.fee_policy);
$$;
revoke all on function khub_bot.public_auction(public.auctions,bigint,text,text),
    khub_bot.public_auction_before_tiered_fees(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;

-- Commission on a settling sale is not yet in the closet queue. Protect it
-- from gift wrapping too, so packaging cannot leave its later fee move short.
create or replace function public.bot_gift_wrapping_liabilities() returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_set(held,'{meat}',to_jsonb(((held->>'meat')::numeric
        +coalesce((select sum(c.meat) from khub_bot.closet_transfers c
            where c.state in ('pending','moving','unknown')),0)
        +coalesce((select sum(a.fee_meat) from public.auctions a
            where a.escrow_mode and a.status='settling' and a.settlement_outcome='completed'),0))::text))
    from (select public.bot_liabilities() held) protected;
$$;
revoke all on function public.bot_gift_wrapping_liabilities() from public,anon,authenticated;
grant execute on function public.bot_gift_wrapping_liabilities() to service_role;

alter function public.bot_inspect() rename to bot_inspect_before_tiered_fees;
alter function public.bot_inspect_before_tiered_fees() set schema khub_bot;
create function public.bot_inspect() returns jsonb
language sql security definer set search_path='' as $$
    select khub_bot.bot_inspect_before_tiered_fees()||jsonb_build_object('escrowFeePolicy',jsonb_build_object(
        'name','tiered_v1','rounding','floor_once','direct_fee',0,
        'tiers',jsonb_build_array(
            jsonb_build_object('up_to',1000000,'bps',500),
            jsonb_build_object('up_to',10000000,'bps',400),
            jsonb_build_object('up_to',100000000,'bps',300),
            jsonb_build_object('up_to',1000000000,'bps',200),
            jsonb_build_object('up_to',null,'bps',100))));
$$;
revoke all on function public.bot_inspect(),khub_bot.bot_inspect_before_tiered_fees() from public,anon,authenticated;
grant execute on function public.bot_inspect() to service_role;
notify pgrst,'reload schema';
commit;
