-- Requires 181 (saved auctions). Public aggregate only; never expose saver identities.
begin;
set local lock_timeout = '2s';
create index if not exists saved_auctions_saved_count on khub_bot.saved_auctions(auction_id) where saved;
create or replace function public.read_auction_bookmark_counts(p_ids uuid[])
returns table(auction_id uuid, bookmark_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
 if coalesce(cardinality(p_ids), 0) > 24 then
   raise exception 'At most 24 auctions per request.' using errcode = '22023';
 end if;
 return query
 select a.id, count(s.user_id)
 from khub_bot.visible_auctions() a
 left join khub_bot.saved_auctions s on s.auction_id = a.id and s.saved
 where a.id = any(p_ids) and a.status <> 'pending_escrow'
 and not khub_bot.is_abandoned_escrow_draft(a)
 group by a.id;
end;
$$;
revoke all on function public.read_auction_bookmark_counts(uuid[]) from public;
grant execute on function public.read_auction_bookmark_counts(uuid[]) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
