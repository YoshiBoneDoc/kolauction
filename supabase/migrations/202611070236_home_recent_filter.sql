-- After 235. Completed listings cannot be abandoned cancelled/expired drafts.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $patch$
declare d text; helper text; expected text; anchor text;
begin
 select prosrc into helper from pg_proc where oid='khub_bot.is_abandoned_escrow_draft(public.auctions)'::regprocedure;
 expected:=$body$select a.escrow_mode and a.status in ('cancelled','expired','voided')
        and a.item_escrowed_at is null and coalesce(a.current_bid,0)=0
        and a.highest_bidder_id is null and a.winner_id is null
        and not exists(select 1 from public.bids b where b.auction_id=a.id)
        and not exists(select 1 from khub_bot.buy_orders o where o.auction_id=a.id and o.funding_receipt is not null);$body$;
 if btrim(regexp_replace(helper,'\s+',' ','g')) is distinct from btrim(regexp_replace(expected,'\s+',' ','g')) then
  raise exception 'Unexpected abandoned-draft semantics; inspect before optimizing Home';
 end if;
 d:=pg_get_functiondef('khub_bot.home_cards_core()'::regprocedure);
 anchor:='a.status=''completed'' and not khub_bot.is_abandoned_escrow_draft(a)';
 if (length(d)-length(replace(d,anchor,'')))/length(anchor)<>1 then
  raise exception 'Unexpected Home recent selector';
 end if;
 execute replace(d,anchor,'a.status=''completed''');
end $patch$;
notify pgrst,'reload schema';
commit;
