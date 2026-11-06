-- After 231. Private ID consumer needs neither card projections nor visibility.
-- Like the full reader's LEFT JOIN, retain saved IDs of unavailable auctions.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
create function public.read_saved_auction_ids() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Sign in to read saved auctions.' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(auction_id order by saved_at desc,auction_id)
 from khub_bot.saved_auctions where user_id=auth.uid() and saved
 and not exists(select 1 from public.auctions closed where closed.id=auction_id
 and khub_bot.saved_auction_concluded_at(closed)<=statement_timestamp()-interval '72 hours')),'[]'::jsonb);
end $$;
revoke all on function public.read_saved_auction_ids() from public,anon,authenticated,service_role;
grant execute on function public.read_saved_auction_ids() to authenticated;
notify pgrst,'reload schema';
commit;
