-- Apply after 202611040197_mystery_raffle_preparation.sql. Website only; no drawing.
begin;
alter table public.mystery_raffle_prizes add column probability_bps integer;
-- Backfill prior equal-odds previews deterministically, distributing remainder by outcome.
with ranked as (select raffle_id,outcome,row_number() over(partition by raffle_id order by outcome) rn,
 count(*) over(partition by raffle_id)::integer n from public.mystery_raffle_prizes)
update public.mystery_raffle_prizes p set probability_bps=10000/r.n+case when r.rn<=10000%r.n then 1 else 0 end
from ranked r where p.raffle_id=r.raffle_id and p.outcome=r.outcome;
alter table public.mystery_raffle_prizes alter column probability_bps set not null;
alter table public.mystery_raffle_prizes add check(probability_bps between 0 and 10000);
create or replace function public.create_mystery_raffle(p_request_id uuid,p_name text,p_ticket_price bigint,p_ends_at timestamptz,p_prizes jsonb) returns uuid
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
 if exists(select 1 from jsonb_array_elements(p_prizes) p where
 jsonb_typeof(p->'probability_bps') is distinct from 'number' or (p->>'probability_bps') !~ '^[0-9]{1,5}$'
 or (p->>'probability_bps')::integer > 10000) then raise exception 'Invalid prize probability'; end if;
 if (select sum((p->>'probability_bps')::integer) from jsonb_array_elements(p_prizes) p) <> 10000 then raise exception 'Probabilities must total 100 percent'; end if;
 insert into public.mystery_raffles(id,creator_id,name,ticket_price,ends_at) values(p_request_id,auth.uid(),btrim(p_name),p_ticket_price,p_ends_at);
 for prize in select value from jsonb_array_elements(p_prizes) loop
  if jsonb_typeof(prize->'id') is distinct from 'number' or (prize->>'id') !~ '^[1-9][0-9]{0,9}$'
  or jsonb_typeof(prize->'quantity') is distinct from 'number' or (prize->>'quantity') !~ '^[1-9][0-9]{0,9}$'
  or (prize->>'quantity')::bigint>1000000000 then raise exception 'Invalid prize quantity or item'; end if;
  select * into item from khub_bot.catalog c where id=(prize->>'id')::bigint and khub_bot.auction_item_eligible(c);
  if not found then raise exception 'Prize is not an eligible catalog item'; end if;
  n:=n+1;
  insert into public.mystery_raffle_prizes(raffle_id,outcome,item_id,name,image,quantity,probability_bps) values(p_request_id,n,item.id,item.name,item.image,(prize->>'quantity')::bigint,(prize->>'probability_bps')::integer);
 end loop;
 return p_request_id;
end $$;
-- Existing RLS and grants expose reads only; there is no pool/odds update RPC.
commit;
