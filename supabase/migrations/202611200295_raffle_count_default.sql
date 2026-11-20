-- After 293. Remember the last successful admin selection for future activations.
begin;
set local lock_timeout='2s';
create table khub_bot.raffle_display_preferences (
 id boolean primary key default true check (id),
 show_public_counts boolean not null
);
alter table khub_bot.raffle_display_preferences enable row level security;
revoke all on khub_bot.raffle_display_preferences from public,anon,authenticated,service_role;
-- Preserve the current live selection; otherwise use the latest concluded raffle.
insert into khub_bot.raffle_display_preferences(id,show_public_counts)
values(true,coalesce((select show_public_counts from public.mystery_raffles
 where state<>'preview' order by (state='active') desc,created_at desc,id desc limit 1),false));

create function khub_bot.apply_raffle_count_default() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (TG_OP='INSERT' and new.state='active') or
    (TG_OP='UPDATE' and old.state is distinct from 'active' and new.state='active') then
  select p.show_public_counts into new.show_public_counts
  from khub_bot.raffle_display_preferences p where p.id;
 end if;
 return new;
end $$;
revoke all on function khub_bot.apply_raffle_count_default() from public,anon,authenticated,service_role;
create trigger apply_raffle_count_default before insert or update of state on public.mystery_raffles
for each row execute function khub_bot.apply_raffle_count_default();

create or replace function public.set_raffle_public_counts(p_id uuid,p_show boolean) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then
  raise exception 'Administrator required' using errcode='42501';
 end if;
 if p_show is null then raise exception 'Visibility is required'; end if;
 -- Match activation's serialization and atomically remember only successful changes.
 perform pg_advisory_xact_lock(3888760);
 update public.mystery_raffles set show_public_counts=p_show where id=p_id and state='active';
 if not found then raise exception 'Active raffle not found'; end if;
 update khub_bot.raffle_display_preferences set show_public_counts=p_show where id;
 return p_show;
end $$;
notify pgrst,'reload schema';
commit;
