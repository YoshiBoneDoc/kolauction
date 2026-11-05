-- Apply after 202; matching standalone bot copy has the same name.
-- Display-only analytics. No activation, transfers or financial accounting changes.
begin;
create table khub_bot.raffle_market_prices (
 raffle_id uuid primary key references public.mystery_raffles(id),
 item_id integer not null, quantity bigint not null,
 price_meat bigint, observed_at timestamptz, checked_at timestamptz,
 captured_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.raffle_market_prices enable row level security;
revoke all on khub_bot.raffle_market_prices from public,anon,authenticated,service_role;
create function khub_bot.capture_raffle_market_price() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.selected_outcome is not null and old.selected_outcome is null then
  insert into khub_bot.raffle_market_prices(raffle_id,item_id,quantity,price_meat,observed_at,checked_at)
  select new.id,p.item_id,p.quantity,case when m.available and m.observed_at<=new.ends_at then m.price_meat end,m.observed_at,m.checked_at
  from public.mystery_raffle_prizes p left join khub_bot.market_prices m on m.item_id=p.item_id
  where p.raffle_id=new.id and p.outcome=new.selected_outcome
  on conflict(raffle_id) do nothing;
 end if;
 return new;
end $$;
revoke all on function khub_bot.capture_raffle_market_price() from public,anon,authenticated,service_role;
create trigger capture_raffle_market_price after update of selected_outcome on public.mystery_raffles
for each row execute function khub_bot.capture_raffle_market_price();
-- Existing concluded raffles deliberately remain unavailable: no current-price backfill.
create function public.read_admin_raffle_analytics(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then
  raise exception 'Administrator required' using errcode='42501';
 end if;
 if p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'Invalid offset'; end if;
 with purchases as materialized (
  select raffle_id,player_id,sum(last_ticket-first_ticket+1) tickets,sum(meat) revenue
  from khub_bot.raffle_purchases group by raffle_id,player_id
 ), totals as materialized (
  select raffle_id,sum(tickets) tickets,sum(revenue) revenue from purchases group by raffle_id
 ), results as materialized (
  select r.*,coalesce(t.tickets,0) tickets,coalesce(t.revenue,0) revenue,
   m.price_meat::numeric*m.quantity value,
   p.name prize_name,p.quantity prize_quantity
  from public.mystery_raffles r left join totals t on t.raffle_id=r.id
  left join khub_bot.raffle_market_prices m on m.raffle_id=r.id
  left join public.mystery_raffle_prizes p on p.raffle_id=r.id and p.outcome=r.selected_outcome
 ), people as materialized (
  select player_id,count(*) raffles,sum(tickets) tickets from purchases group by player_id
 )
 select jsonb_build_object(
  'revenue',coalesce((select sum(revenue) from totals),0)::text,
  'tickets',coalesce((select sum(tickets) from totals),0)::text,
  'refundable_revenue',coalesce((select sum(revenue) from results where completion_reason='cancelled' or state='cancelled'),0)::text,
  'prize_value',(select sum(value)::text from results where completion_reason='prize_delivered'),
  'profit',(select sum(revenue-value)::text from results where selected_outcome is not null and value is not null and coalesce(completion_reason,'') not in ('cancelled','no_tickets')),
  'unavailable',(select count(*) from results where selected_outcome is not null and value is null),
  'participants',(select count(*) from people),
  'people',coalesce((select jsonb_agg(to_jsonb(x)) from (
   select s.player_id::text,p.id profile_id,coalesce(p.kol_player_name,'Player #'||s.player_id) username,s.raffles::text,s.tickets::text
   from people s left join public.profiles p on p.kol_player_id=s.player_id
   order by s.raffles desc,s.tickets desc,s.player_id limit 50 offset p_offset) x),'[]'),
  'current',coalesce((select jsonb_agg(to_jsonb(x)) from (
   select r.id,r.name,r.state,r.ends_at,r.tickets::text,r.revenue::text,r.prize_name,r.prize_quantity::text,
    case when r.state='fulfilling' then case when a.prize_queued or coalesce((select i.quantity from khub_bot.raffle_inventory i join public.mystery_raffle_prizes q on q.raffle_id=i.raffle_id and q.item_id=i.item_id where i.raffle_id=r.id and q.outcome=r.selected_outcome),0)>=r.prize_quantity then 'Awaiting delivery' else 'Awaiting prize deposit' end
     when r.state='drawing' then 'Drawing winner' else coalesce(replace(r.completion_reason,'_',' '),r.state) end status,
    coalesce((select jsonb_agg(jsonb_build_object('name',p.name,'quantity',p.quantity::text) order by p.outcome) from public.mystery_raffle_prizes p where p.raffle_id=r.id),'[]') pool
   from results r left join khub_bot.raffle_accounts a on a.raffle_id=r.id
   where r.state not in ('settled','cancelled','empty') order by r.ends_at desc,r.id limit 50) x),'[]'),
  'past',coalesce((select jsonb_agg(to_jsonb(x)) from (
   select id,name,state,completion_reason,ends_at,prize_name,prize_quantity::text,value::text,revenue::text,
    case when selected_outcome is not null and coalesce(completion_reason,'') not in ('cancelled','no_tickets') then (revenue-value)::text end profit
   from results where selected_outcome is not null or state in ('settled','cancelled','empty') or completion_reason is not null
   order by ends_at desc,id limit 50 offset p_offset) x),'[]')
 ) into result;
 return result;
end $$;
create function public.read_admin_raffle_participants(p_id uuid,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then raise exception 'Administrator required' using errcode='42501'; end if;
 if p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'Invalid offset'; end if;
 return coalesce((select jsonb_agg(to_jsonb(x)) from (
 select t.player_id::text,p.id profile_id,coalesce(p.kol_player_name,'Player #'||t.player_id) username,t.tickets::text
 from (select player_id,sum(last_ticket-first_ticket+1) tickets from khub_bot.raffle_purchases where raffle_id=p_id group by player_id) t
 left join public.profiles p on p.kol_player_id=t.player_id
 order by t.tickets desc,t.player_id limit 50 offset p_offset) x),'[]');
end $$;
revoke all on function public.read_admin_raffle_analytics(integer),public.read_admin_raffle_participants(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_admin_raffle_analytics(integer),public.read_admin_raffle_participants(uuid,integer) to authenticated;
notify pgrst,'reload schema';
commit;
