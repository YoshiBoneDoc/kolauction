-- Apply after 080, before deploying the Custom ending-time form.
-- Existing preset durations and listing deadlines stay unchanged.
-- The current Oracle worker already supports fixed-deadline deposits; no rebuild is required.
begin;
select pg_advisory_xact_lock(3888760);
alter table public.auctions add column custom_end_at timestamptz;
alter table public.auctions drop constraint auctions_duration_hours_check;
alter table public.auctions add constraint auctions_duration_hours_check check (
    (custom_end_at is null and duration_hours in (6,12,24,72,168,336,720))
    or (custom_end_at is not null and duration_hours between 1 and 720)
);

-- Derive the explicit custom overload from the current creator so all catalog,
-- identity, restriction, minimum-price, buyout and fee checks remain identical.
-- Set fixed-deadline terms on INSERT; published settlement terms stay immutable.
do $$
declare body text;
    columns_anchor text := 'duration_hours,image,';
    values_anchor text := 'p_min_bid_meat,p_duration_hours,item_image,';
    end_anchor text := 'v_now,v_now+make_interval(hours=>p_duration_hours)';
    start_anchor text := 'p_escrow_mode and s.start_on_deposit)';
    lock_anchor text := 'perform pg_advisory_xact_lock(3888760);';
begin
    select prosrc into body from pg_proc where oid='public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean)'::regprocedure;
    if strpos(body,columns_anchor)=0 or strpos(body,values_anchor)=0 or strpos(body,end_anchor)=0
        or strpos(body,start_anchor)=0 or strpos(body,lock_anchor)=0 then
        raise exception 'Unexpected auction creator; custom ending-time migration not applied.';
    end if;
    body:=replace(body,lock_anchor,lock_anchor || E'\n'
        ||'v_now:=clock_timestamp(); '
        ||'if p_custom_end_at is null or not isfinite(p_custom_end_at) or p_custom_end_at<=v_now '
        ||'or p_custom_end_at>v_now+interval ''720 hours'' then '
        ||'raise exception ''Choose an ending time in the future and within the next 30 days.''; end if;');
    body:=replace(body,columns_anchor,'duration_hours,image,custom_end_at,');
    body:=replace(body,values_anchor,'p_min_bid_meat,greatest(1,ceil(extract(epoch from p_custom_end_at-v_now)/3600)::integer),item_image,p_custom_end_at,');
    body:=replace(body,end_anchor,'v_now,p_custom_end_at');
    body:=replace(body,start_anchor,'false)');
    execute 'create function public.create_auction(p_item text,p_quantity bigint,p_min_bid_meat bigint,p_duration_hours integer,p_image text,p_instant_purchase_price bigint,p_item_id integer,p_escrow_mode boolean,p_custom_end_at timestamptz) returns uuid language plpgsql security definer set search_path='''' as ' || quote_literal(body);
end; $$;
revoke all on function public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean,timestamptz) from public,anon;
grant execute on function public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean,timestamptz) to authenticated;

alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to public_auction_before_custom_end;
revoke all on function khub_bot.public_auction_before_custom_end(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language sql stable security definer set search_path='' as $$
    select khub_bot.public_auction_before_custom_end(a,p_bid_count,p_highest_label,p_winner_label)
        ||jsonb_build_object('custom_end_at',a.custom_end_at);
$$;
revoke all on function khub_bot.public_auction(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
