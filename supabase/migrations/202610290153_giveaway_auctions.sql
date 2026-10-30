-- Giveaway metadata and server-side creation/price/deadline rules.
begin;
alter table public.auctions add column giveaway_title text;
alter table public.auctions add constraint giveaway_title_valid check (giveaway_title is null or (length(btrim(giveaway_title)) between 1 and 80 and auction_kind='sell'));

create function public.create_giveaway_auction(p_item text,p_quantity bigint,p_min_bid_meat bigint,p_duration_hours integer,p_image text,p_instant_purchase_price bigint,p_item_id integer,p_escrow_mode boolean,p_title text,p_custom_end_at timestamptz default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare aid uuid;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_title is null or length(btrim(p_title)) not between 1 and 80 then raise exception 'A giveaway needs a title.'; end if;
    if p_custom_end_at is null then
        aid:=public.create_auction(p_item,p_quantity,p_min_bid_meat,p_duration_hours,p_image,p_instant_purchase_price,p_item_id,p_escrow_mode);
    else
        aid:=public.create_auction(p_item,p_quantity,p_min_bid_meat,p_duration_hours,p_image,p_instant_purchase_price,p_item_id,p_escrow_mode,p_custom_end_at);
    end if;
    update public.auctions set giveaway_title=btrim(p_title) where id=aid;
    return aid;
end;$$;
revoke all on function public.create_giveaway_auction(text,bigint,bigint,integer,text,bigint,integer,boolean,text,timestamptz) from public,anon;
grant execute on function public.create_giveaway_auction(text,bigint,bigint,integer,text,bigint,integer,boolean,text,timestamptz) to authenticated;

-- Keep the existing projection, adding only public giveaway metadata.
alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to public_auction_before_giveaway;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language sql stable security definer set search_path='' as $$
 select khub_bot.public_auction_before_giveaway(a,p_bid_count,p_highest_label,p_winner_label)
 || jsonb_build_object('giveaway_title',a.giveaway_title);
$$;
revoke all on function khub_bot.public_auction(public.auctions,bigint,text,text),khub_bot.public_auction_before_giveaway(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;

-- The shared deadline extension function is used by Direct and Escrow bids.
do $$declare definition text;
begin
 definition:=pg_get_functiondef('khub_bot.extend_sell_auction(uuid,uuid,timestamptz,text)'::regprocedure);
 if strpos(definition,'if a.id is null or a.auction_kind')=0 then raise exception 'Unexpected anti-sniping function.'; end if;
 execute replace(definition,'if a.id is null or a.auction_kind', 'if a.id is null or a.giveaway_title is not null or a.auction_kind');
end;$$;

-- Reject raised giveaway bids before buyout handling, retaining normal refund paths.
do $$declare d text; marker text:='if v_auction.instant_purchase_price is not null and p_amount>=v_auction.instant_purchase_price then';
begin
 d:=pg_get_functiondef('public.legacy_place_bid(uuid,bigint)'::regprocedure);
 if strpos(d,marker)=0 then raise exception 'Unexpected Direct bid writer.'; end if;
 execute replace(d,marker,'if v_auction.giveaway_title is not null and p_amount<>least(khub_bot.minimum_auction_bid(v_auction.min_bid_meat,v_auction.current_bid),coalesce(v_auction.instant_purchase_price,9007199254740991)) then raise exception ''Giveaway bids must equal the next minimum bid.''; end if; '||marker);
 d:=pg_get_functiondef('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure);
 if strpos(d,'meat<a.min_bid_meat')=0 then raise exception 'Unexpected escrow bid writer.';end if;
 execute replace(d,'meat<a.min_bid_meat',
 '(a.giveaway_title is not null and meat<>least(khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid),coalesce(a.instant_purchase_price,9007199254740991))) or meat<a.min_bid_meat');
end;$$;
alter function public.purchase_auction(uuid) rename to purchase_auction_before_giveaway;
create function public.purchase_auction(p_auction_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;
begin
 perform pg_advisory_xact_lock(3888760);
 select * into a from public.auctions where id=p_auction_id for update;
 if a.giveaway_title is not null and a.instant_purchase_price>khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid) then raise exception 'Giveaway bids must equal the next minimum bid.';end if;
 perform public.purchase_auction_before_giveaway(p_auction_id);
end;$$;
revoke all on function public.purchase_auction_before_giveaway(uuid) from public,anon,authenticated;
revoke all on function public.purchase_auction(uuid) from public,anon;
grant execute on function public.purchase_auction(uuid) to authenticated;

-- Featured auction is read independently of filters and page number.
create function public.read_featured_giveaway() returns jsonb language sql stable security definer set search_path='' as $$
 select khub_bot.public_auction(a,(select count(*) from public.bids b where b.auction_id=a.id),null,null)
 from public.auctions a where a.giveaway_title is not null and a.status='active' and a.end_time>statement_timestamp()
 and not khub_bot.profile_is_restricted(a.seller_id)
 order by a.created_at desc limit 1;
$$;
revoke all on function public.read_featured_giveaway() from public;
grant execute on function public.read_featured_giveaway() to anon,authenticated;

-- Claim before posting. A lost chat confirmation never creates a duplicate announcement.
create table khub_bot.giveaway_announcements (auction_id uuid primary key references public.auctions(id), claimed_at timestamptz not null default clock_timestamp());
revoke all on khub_bot.giveaway_announcements from public,anon,authenticated,service_role;
create function public.bot_claim_giveaway_announcement() returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;
begin
 for a in select * from public.auctions where giveaway_title is not null and status='active' and (not escrow_mode or item_escrowed_at is not null)
 and not exists(select 1 from khub_bot.giveaway_announcements g where g.auction_id=public.auctions.id)
 order by item_escrowed_at limit 1 for update skip locked loop
   insert into khub_bot.giveaway_announcements(auction_id) values(a.id) on conflict do nothing;
   if found then return jsonb_build_object('id',a.id,'title',a.giveaway_title,'hours',a.duration_hours);end if;
 end loop;
 return null;
end;$$;
revoke all on function public.bot_claim_giveaway_announcement() from public,anon,authenticated;
grant execute on function public.bot_claim_giveaway_announcement() to service_role;
notify pgrst,'reload schema';
commit;
