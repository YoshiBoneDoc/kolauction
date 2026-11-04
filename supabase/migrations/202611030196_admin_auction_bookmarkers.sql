-- Admin-only identities. Never add these fields to shared public snapshots.
begin;
set local lock_timeout = '2s';
create function public.read_admin_auction_bookmarkers(p_ids uuid[])
returns table(auction_id uuid, usernames text[])
language plpgsql stable security definer set search_path = '' as $$
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then
  raise exception 'Administrator access required.' using errcode = '42501';
 end if;
 if coalesce(cardinality(p_ids),0)>24 then
  raise exception 'At most 24 auctions per request.' using errcode = '22023';
 end if;
 return query
 select s.auction_id, array_agg(p.khub_username::text order by lower(p.khub_username),p.id)
 from khub_bot.saved_auctions s join public.profiles p on p.id=s.user_id
 where s.saved and s.auction_id=any(p_ids)
 group by s.auction_id;
end;
$$;
revoke all on function public.read_admin_auction_bookmarkers(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.read_admin_auction_bookmarkers(uuid[]) to authenticated;
notify pgrst,'reload schema';
commit;
