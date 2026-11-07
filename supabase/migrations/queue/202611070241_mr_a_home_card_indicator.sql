-- After 237–240. Public card metadata only; no extra joins or reads.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $patch$
declare source text; anchor text := '''min_bid_meat'',''current_bid''';
begin
 source := pg_get_functiondef('khub_bot.public_listing_projection(public.auctions,bigint,text,text)'::regprocedure);
 if (length(source)-length(replace(source,anchor,'')))/length(anchor) <> 1 then
   raise exception 'Unexpected public card projection; inspect before adding Mr. A metadata';
 end if;
 execute replace(source,anchor,'''mr_a_rate'',''min_bid_meat'',''current_bid''');
end $patch$;
notify pgrst,'reload schema';
commit;
