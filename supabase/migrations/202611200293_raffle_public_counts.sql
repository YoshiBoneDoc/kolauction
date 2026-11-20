-- Public raffle counts are opt-in for each raffle. Existing rows default to hidden.
begin;
set local lock_timeout='2s';
alter table public.mystery_raffles add column show_public_counts boolean not null default false;
grant select(show_public_counts) on public.mystery_raffles to authenticated;

create or replace function public.total_tickets_sold(public.mystery_raffles) returns text
language sql stable security definer set search_path='' as $$
 select coalesce((select a.ticket_count from khub_bot.raffle_accounts a where a.raffle_id=($1).id),0)::text
 where public.can_view_raffle(($1).id) and exists (select 1 from public.mystery_raffles r where r.id=($1).id and r.show_public_counts);
$$;
create or replace function public.total_raffle_participants(public.mystery_raffles) returns text
language sql stable security definer set search_path='' as $$
 select count(distinct p.player_id)::text from khub_bot.raffle_purchases p
 where p.raffle_id=($1).id
 having public.can_view_raffle(($1).id) and exists (select 1 from public.mystery_raffles r where r.id=($1).id and r.show_public_counts);
$$;
create function public.set_raffle_public_counts(p_id uuid, p_show boolean) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then
  raise exception 'Administrator required' using errcode='42501';
 end if;
 if p_show is null then raise exception 'Visibility is required'; end if;
 update public.mystery_raffles set show_public_counts=p_show where id=p_id and state='active';
 if not found then raise exception 'Active raffle not found'; end if;
 return p_show;
end $$;
revoke all on function public.set_raffle_public_counts(uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.set_raffle_public_counts(uuid,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
