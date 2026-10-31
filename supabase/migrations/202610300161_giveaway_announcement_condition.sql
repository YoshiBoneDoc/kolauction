-- Include the persisted win condition without depending on installed function formatting.
begin;
create or replace function public.bot_claim_giveaway_announcement() returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;
begin
 for a in select * from public.auctions where giveaway_title is not null and status='active' and (not escrow_mode or item_escrowed_at is not null)
 and not exists(select 1 from khub_bot.giveaway_announcements g where g.auction_id=public.auctions.id)
 order by item_escrowed_at limit 1 for update skip locked loop
   insert into khub_bot.giveaway_announcements(auction_id) values(a.id) on conflict do nothing;
   if found then return jsonb_build_object('id',a.id,'title',a.giveaway_title,'hour(s)',a.duration_hours,'win_condition',a.giveaway_win_condition);end if;
 end loop;
 return null;
end;$$;
revoke all on function public.bot_claim_giveaway_announcement() from public,anon,authenticated;
grant execute on function public.bot_claim_giveaway_announcement() to service_role;
notify pgrst,'reload schema';
commit;
