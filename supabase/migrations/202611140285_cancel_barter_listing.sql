-- After 283. Apply once per database; deploy the website separately.
-- Host cancellation before any accepted offer. No assets/accounting are changed.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
create function public.cancel_barter_auction(p_auction uuid) returns void
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; a khub_bot.barter_auctions%rowtype;
begin
 p:=khub_bot.require_verified_trader();
 -- Same listing-first lock order as submission and host review. A concurrent
 -- acceptance must either block cancellation or see the listing already closed.
 select * into a from khub_bot.barter_auctions where id=p_auction for update;
 if not found then raise exception 'Barter not found.'; end if;
 if a.seller_id<>p.id then raise exception 'Only the host can cancel this listing.'; end if;
 if a.cancelled_at is not null then return; end if;
 if a.end_time<=clock_timestamp() then raise exception 'This barter has already ended.'; end if;
 if a.current_offer_id is not null or exists (
   select 1 from khub_bot.barter_offers where auction_id=a.id and accepted_at is not null
 ) then raise exception 'A listing cannot be cancelled after an offer has been accepted.'; end if;
 update khub_bot.barter_auctions set cancelled_at=clock_timestamp() where id=a.id;
 -- Keep immutable offers/feedback as evidence. Existing reads and writes exclude
 -- cancelled listings from browse, notices, submissions and host decisions.
end; $$;
revoke all on function public.cancel_barter_auction(uuid) from public,anon,authenticated;
grant execute on function public.cancel_barter_auction(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
