-- Phase 1 website only. Requires existing khub_bot catalog and administrator helpers.
-- Apply manually before using raffle creation. No auction/ledger/bot objects are changed.
begin;
create table public.mystery_raffles (
 id uuid primary key default gen_random_uuid(),
 creator_id uuid not null references public.profiles(id),
 name text not null check (char_length(btrim(name)) between 1 and 80),
 ticket_price bigint not null check(ticket_price between 1 and 1000000000000),
 ends_at timestamptz not null,
 state text not null default 'preview' check(state = 'preview'),
 created_at timestamptz not null default now()
);
-- Each row is one equally weighted possible outcome, regardless of quantity.
create table public.mystery_raffle_prizes (
 raffle_id uuid not null references public.mystery_raffles(id),
 outcome integer not null check(outcome between 1 and 20),
 item_id integer not null,
 name text not null,
 image text,
 quantity bigint not null check(quantity between 1 and 1000000000),
 primary key(raffle_id,outcome), unique(raffle_id,item_id)
);
alter table public.mystery_raffles enable row level security;
alter table public.mystery_raffle_prizes enable row level security;
revoke all on public.mystery_raffles,public.mystery_raffle_prizes from public,anon,authenticated;
grant select(id,name,ticket_price,ends_at,state,created_at) on public.mystery_raffles to anon,authenticated;
grant select on public.mystery_raffle_prizes to anon,authenticated;
create policy raffle_preview_read on public.mystery_raffles for select to anon,authenticated using(true);
create policy raffle_prize_preview_read on public.mystery_raffle_prizes for select to anon,authenticated using(true);
create function public.create_mystery_raffle(p_request_id uuid,p_name text,p_ticket_price bigint,p_ends_at timestamptz,p_prizes jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare rid uuid; prize jsonb; n integer := 0; item khub_bot.catalog%rowtype;
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then raise exception 'Administrator required'; end if;
 if p_request_id is null then raise exception 'Request ID required'; end if;
 -- Repeated submission with this ID returns the original saved listing.
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,197));
 select id into rid from public.mystery_raffles where id=p_request_id and creator_id=auth.uid();
 if found then return rid; end if;
 if p_name is null or char_length(btrim(p_name)) not between 1 and 80
 or p_ticket_price is null or p_ticket_price not between 1 and 1000000000000
 or p_ends_at is null or p_ends_at<=clock_timestamp() or p_ends_at>clock_timestamp()+interval '365 days' then
 raise exception 'Invalid raffle name, ticket price or closing time'; end if;
 if jsonb_typeof(p_prizes) is distinct from 'array' then raise exception 'Invalid prize pool'; end if;
 if jsonb_array_length(p_prizes) not between 1 and 20 then raise exception 'Choose 1 to 20 prize outcomes'; end if;
 insert into public.mystery_raffles(id,creator_id,name,ticket_price,ends_at) values(p_request_id,auth.uid(),btrim(p_name),p_ticket_price,p_ends_at);
 for prize in select value from jsonb_array_elements(p_prizes) loop
  if jsonb_typeof(prize->'id') is distinct from 'number' or (prize->>'id') !~ '^[1-9][0-9]{0,9}$'
  or jsonb_typeof(prize->'quantity') is distinct from 'number' or (prize->>'quantity') !~ '^[1-9][0-9]{0,9}$'
  or (prize->>'quantity')::bigint>1000000000 then raise exception 'Invalid prize quantity or item'; end if;
  select * into item from khub_bot.catalog c where id=(prize->>'id')::bigint and khub_bot.auction_item_eligible(c);
  if not found then raise exception 'Prize is not an eligible catalog item'; end if;
  n:=n+1;
  insert into public.mystery_raffle_prizes values(p_request_id,n,item.id,item.name,item.image,(prize->>'quantity')::bigint);
 end loop;
 return p_request_id;
end $$;
revoke all on function public.create_mystery_raffle(uuid,text,bigint,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.create_mystery_raffle(uuid,text,bigint,timestamptz,jsonb) to authenticated;
commit;
