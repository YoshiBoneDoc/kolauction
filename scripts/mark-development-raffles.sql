-- Supabase SQL Editor: run AFTER migration 218.
-- Explicit test raffles from the owner's screenshot. No records are deleted.
-- To restore these raffles, change is_test = true to is_test = false below.
begin;
select pg_advisory_xact_lock(3888760);
update public.mystery_raffles
set is_test = true
where raffle_number in (1001,1002,1003,1004,1005,1006,1007,1008,1009,1010)
  and state in ('settled','cancelled','empty')
returning raffle_number, name, state, is_test;
commit;
