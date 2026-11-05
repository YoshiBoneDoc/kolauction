-- Apply after 216. Existing concluded ranges stay unavailable: no historical backfill.
begin;
alter table public.mystery_raffles add column prize_range_min text,
 add column prize_range_max text,add column prize_range_frozen_at timestamptz;
grant select(prize_range_min,prize_range_max,prize_range_frozen_at) on public.mystery_raffles to anon,authenticated;
create function khub_bot.freeze_raffle_prize_range() returns trigger
language plpgsql security definer set search_path='' as $$
declare low numeric; high numeric; complete boolean;
begin
 if old.prize_range_frozen_at is not null then
  new.prize_range_min:=old.prize_range_min; new.prize_range_max:=old.prize_range_max;
  new.prize_range_frozen_at:=old.prize_range_frozen_at;
 elsif (old.selected_outcome is null and new.selected_outcome is not null)
 or (new.state in ('settled','cancelled','empty') and new.state is distinct from old.state) then
  select min(m.price_meat::numeric*p.quantity),max(m.price_meat::numeric*p.quantity),
   bool_and(coalesce(m.available and m.price_meat is not null and m.observed_at<=new.ends_at,false))
  into low,high,complete from public.mystery_raffle_prizes p
  left join khub_bot.market_prices m on m.item_id=p.item_id where p.raffle_id=new.id;
  new.prize_range_min:=case when complete then low::text end;
  new.prize_range_max:=case when complete then high::text end;
  new.prize_range_frozen_at:=clock_timestamp();
 end if;
 return new;
end $$;
revoke all on function khub_bot.freeze_raffle_prize_range() from public,anon,authenticated,service_role;
create trigger freeze_raffle_prize_range before update on public.mystery_raffles
for each row execute function khub_bot.freeze_raffle_prize_range();
notify pgrst,'reload schema';
commit;
