-- Apply after 184, before deploying the website. Public display facts only.
begin;
set local lock_timeout='2s';
do $$declare d text;
 anchor text:='''status'',a.status,''end_time''';
begin
 d:=pg_get_functiondef('public.read_saved_auctions_before_defaults(uuid)'::regprocedure);
 if strpos(d,anchor)=0 then raise exception 'Unexpected saved-auction projection';end if;
 execute replace(d,anchor,$fields$'image',a.image,'quantity',a.quantity::text,'bundle_items',a.bundle_items,
 'auction_kind',a.auction_kind,'escrow_mode',a.escrow_mode,'current_bid',a.current_bid::text,
 'min_bid_meat',a.min_bid_meat::text,'final_price',a.final_price::text,
 'purchased_quantity',case when a.auction_kind='buy' then (select purchased_quantity::text from khub_bot.buy_orders where auction_id=a.id) end,
 'status',a.status,'end_time'$fields$);
end;$$;
notify pgrst,'reload schema';
commit;
