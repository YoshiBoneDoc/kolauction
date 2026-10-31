-- One independent durable claim per giveaway's final reminder.
begin;
create table khub_bot.giveaway_final_reminders (
 auction_id uuid primary key references public.auctions(id),
 claimed_at timestamptz not null default clock_timestamp()
);
revoke all on khub_bot.giveaway_final_reminders from public,anon,authenticated,service_role;
alter function public.bot_claim_giveaway_announcement() rename to bot_claim_giveaway_launch;
revoke all on function public.bot_claim_giveaway_launch() from public,anon,authenticated,service_role;
create function public.bot_claim_giveaway_announcement() returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;
begin
 for a in select * from public.auctions
 where giveaway_title is not null and status='active'
 and (not escrow_mode or item_escrowed_at is not null)
 and end_time>clock_timestamp() and end_time<=clock_timestamp()+interval '30 minutes'
 and not exists(select 1 from khub_bot.giveaway_final_reminders r where r.auction_id=public.auctions.id)
 order by end_time limit 1 for update skip locked loop
   insert into khub_bot.giveaway_final_reminders(auction_id) values(a.id) on conflict do nothing;
   if found then return jsonb_build_object('id',a.id,'title',a.giveaway_title,'kind','final_reminder');end if;
 end loop;
 return public.bot_claim_giveaway_launch();
end;$$;
revoke all on function public.bot_claim_giveaway_announcement() from public,anon,authenticated;
grant execute on function public.bot_claim_giveaway_announcement() to service_role;
notify pgrst,'reload schema';
commit;
