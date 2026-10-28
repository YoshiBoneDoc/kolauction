-- Apply after 070, then deploy the website. The existing bot uses this shared
-- database rule for funded KMail bids; no bot rebuild is required.
-- Only future bid validation changes. Existing bids/prices/deliveries are untouched.
begin;
select pg_advisory_xact_lock(3888760);
create or replace function khub_bot.bid_increment(p_current bigint) returns bigint
language plpgsql immutable strict set search_path='' as $$
declare basis_points integer; rounding_unit bigint;
begin
    if p_current<0 or p_current>9007199254740991 then raise exception 'Invalid current bid.'; end if;
    if p_current<1000 then return 10;
    elsif p_current<10000 then return 100;
    elsif p_current<100000 then return 1000;
    elsif p_current<1000000 then return 10000;
    elsif p_current<10000000 then basis_points:=300; rounding_unit:=10000;
    elsif p_current<100000000 then basis_points:=200; rounding_unit:=100000;
    elsif p_current<10000000000 then basis_points:=100; rounding_unit:=500000;
    else basis_points:=50; rounding_unit:=500000;
    end if;
    -- Exact arbitrary-precision integer division, rounded up to whole units.
    return (div(p_current::numeric*basis_points+10000::numeric*rounding_unit-1,
        10000::numeric*rounding_unit)*rounding_unit)::bigint;
end; $$;
revoke all on function khub_bot.bid_increment(bigint) from public,anon,authenticated,service_role;
-- minimum_auction_bid, Direct validation and funded KMail validation already call
-- this function. Keep their first-bid, exact-minimum, ban and buyout guards intact.
notify pgrst,'reload schema';
commit;
