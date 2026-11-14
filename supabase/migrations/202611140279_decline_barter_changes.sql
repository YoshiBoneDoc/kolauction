-- After 278. Bidders may decline their change-requested offer; accepted offers stay immutable.
begin;
create or replace function public.withdraw_barter_offer(p_offer uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a khub_bot.barter_auctions%rowtype;
begin
 perform khub_bot.require_verified_trader();
 select b.* into a from khub_bot.barter_auctions b join khub_bot.barter_offers o on o.auction_id=b.id where o.id=p_offer for update of b;
 if a.end_time<=clock_timestamp() then raise exception 'Bidding has closed.'; end if;
 update khub_bot.barter_offers set status='withdrawn' where id=p_offer and bidder_id=auth.uid() and status in ('pending','changes_requested');
 if not found then raise exception 'Only your pending offer or requested changes can be declined.'; end if;
end; $$;

notify pgrst,'reload schema';
commit;
