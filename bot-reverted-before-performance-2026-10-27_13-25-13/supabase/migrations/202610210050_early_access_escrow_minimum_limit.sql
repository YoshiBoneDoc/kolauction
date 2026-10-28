-- Apply after 049. Limit new escrow listings by their minimum bid only.
-- Existing auctions, bids, buyout prices and settlement records are unchanged.
begin;
create or replace function public.create_auction(p_item text,p_quantity bigint,p_min_bid_meat bigint,
    p_duration_hours integer,p_image text default null,p_instant_purchase_price bigint default null,
    p_item_id integer default null,p_escrow_mode boolean default true)
returns uuid language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; v_id uuid; v_now timestamptz:=clock_timestamp(); s khub_bot.settings%rowtype;
begin
    p:=khub_bot.require_verified_trader();
    if p_escrow_mode is null then raise exception 'Choose Escrow or Direct settlement.'; end if;
    if p_escrow_mode and p_min_bid_meat>1000000 then
        raise exception 'Escrow is limited to a minimum bid of 1M Meat during early access. Choose Direct to continue with this amount.';
    end if;
    if p_item_id is null or not exists(select 1 from khub_bot.catalog where id=p_item_id and name=btrim(p_item)) then
        raise exception 'Choose a catalog item. The bot catalog must be synced before listing.';
    end if;
    if p_duration_hours is null or p_duration_hours not in (6,12,24,72,168,720) then
        raise exception 'Choose a valid auction duration.';
    end if;
    select * into s from khub_bot.settings where id;
    insert into public.auctions(seller_id,seller_username,item,item_id,quantity,min_bid_meat,duration_hours,image,
        created_at,end_time,instant_purchase_price,escrow_mode,status,seller_kol_id,fee_bps,start_on_deposit)
    values(p.id,p.khub_username,btrim(p_item),p_item_id,p_quantity,p_min_bid_meat,p_duration_hours,p_image,
        v_now,v_now+make_interval(hours=>p_duration_hours),p_instant_purchase_price,p_escrow_mode,
        case when p_escrow_mode then 'pending_escrow' else 'active' end,p.kol_player_id,
        case when p_escrow_mode then s.fee_bps else 0 end,p_escrow_mode and s.start_on_deposit)
    returning id into v_id;
    return v_id;
end; $$;
revoke all on function public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean) from public,anon,authenticated;
grant execute on function public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
