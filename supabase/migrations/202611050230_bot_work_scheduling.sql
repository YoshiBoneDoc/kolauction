-- After 229. Apply SQL before the matching bot. No live transfers.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
alter table khub_bot.raffle_accounts add column next_work_at timestamptz not null default now(),
 add column draw_failures integer not null default 0 check(draw_failures>=0);
alter table khub_bot.raffle_purchases add column refund_queued boolean not null default false;
-- Append-only wakeups avoid taking an account/global financial lock from a
-- delivery-row trigger. Consume only committed events; concurrent arrivals stay.
create table khub_bot.raffle_work_wakeups (
 id bigint generated always as identity primary key,
 raffle_id uuid not null
);
create index raffle_work_wakeups_raffle_idx on khub_bot.raffle_work_wakeups(raffle_id,id);
alter table khub_bot.raffle_work_wakeups enable row level security;
revoke all on khub_bot.raffle_work_wakeups from public,anon,authenticated,service_role;
-- Retain the installed fresh safety predicates, omit optional discovery wrappers.
do $patch$
declare source text;
begin
 select prosrc into source from pg_proc where oid='khub_bot.worker_status_before_multi_mail()'::regprocedure;
 if strpos(source,'''isolatedDeliveryAttention''')=0 or strpos(source,'''accountRequestsPending''')=0 then raise exception 'Unexpected base safety status'; end if;
 source:=regexp_replace(source,';[[:space:]]*$','');
 execute 'create function public.bot_worker_safety() returns jsonb language sql stable security definer set search_path='''' as '||quote_literal(
 'select ('||source||') || jsonb_build_object(''workerSchedulingVersion'',1,''capabilityRevision'',230,''siteMaintenanceOwned'',(select site_owned from khub_bot.site_maintenance_owner),
 ''closetRecoveryReviewKey'',coalesce((select string_agg(r.attempt::text,'','' order by r.attempt)
 from khub_bot.closet_recovery_attempts r join khub_bot.closet_transfers c on c.id=r.transfer_id
 where r.state=''review'' and c.state in (''moving'',''unknown'') and coalesce(c.attempt,c.id)=r.attempt),''''));');
 source:=pg_get_functiondef('public.bot_worker_status()'::regprocedure);
 if strpos(source,'''raffleFairnessVersion'',1')=0 then raise exception 'Unexpected capability status'; end if;
 execute replace(source,'''raffleFairnessVersion'',1','''raffleFairnessVersion'',1,''workerSchedulingVersion'',1,''capabilityRevision'',230');
end $patch$;
-- All financial accounting remains atomic under the same advisory lock. Limit
-- each transaction to 50 refund/return records across at most 10 raffles,
-- with at most 20 item-return records per raffle. Queue splitting stays intact.
do $patch$
declare source text; old text;
begin
 source:=pg_get_functiondef('public.bot_raffle_tick()'::regprocedure);
 if strpos(source,'for x in select * from khub_bot.raffle_purchases where raffle_id=r.id loop')=0 then raise exception 'Unexpected refund loop'; end if;
 if strpos(source,'complete boolean;')=0 then raise exception 'Unexpected tick variables'; end if;
 source:=replace(source,'complete boolean;','complete boolean; remaining_work integer:=50;');
 source:=replace(source,'FUNCTION public.bot_raffle_tick()', 'FUNCTION khub_bot.raffle_tick_bounded(p_due_only boolean)');
 source:=replace(source,'where mr.state in (', 'where (not p_due_only or ra.next_work_at<=statement_timestamp() or exists(select 1 from khub_bot.raffle_work_wakeups wake where wake.raffle_id=mr.id)) and mr.state in (');
 source:=replace(source,'  update khub_bot.raffle_accounts set last_work_at','  exit when remaining_work<=0;
  delete from khub_bot.raffle_work_wakeups where raffle_id=r.id;
  update khub_bot.raffle_accounts set last_work_at');
 source:=replace(source,'set last_work_at=clock_timestamp() where raffle_id=r.id;',
 'set last_work_at=clock_timestamp(),next_work_at=case when r.state=''fulfilling'' and r.ends_at+interval ''30 minutes''>clock_timestamp() then least(clock_timestamp()+interval ''60 seconds'',r.ends_at+interval ''30 minutes'') else clock_timestamp()+interval ''60 seconds'' end where raffle_id=r.id;');
 source:=replace(source,'for x in select * from khub_bot.raffle_purchases where raffle_id=r.id loop',
 'for x in select * from khub_bot.raffle_purchases where raffle_id=r.id and not refund_queued order by first_ticket limit remaining_work for update loop');
 old:='    end loop;
   end if;
   for x in select * from khub_bot.raffle_inventory where raffle_id=r.id and quantity>0 loop';
 if strpos(source,old)=0 then raise exception 'Unexpected refund completion boundary'; end if;
 source:=replace(source,old,'    remaining_work:=remaining_work-1;
     update khub_bot.raffle_purchases set refund_queued=true where receipt_id=x.receipt_id;
     update khub_bot.raffle_accounts set held_meat=held_meat-x.meat where raffle_id=r.id;
    end loop;
    if exists(select 1 from khub_bot.raffle_purchases where raffle_id=r.id and not refund_queued) then
     update khub_bot.raffle_accounts set next_work_at=clock_timestamp() where raffle_id=r.id;
     continue;
    end if;
   end if;
   for x in select * from khub_bot.raffle_inventory where raffle_id=r.id and quantity>0 order by item_id limit least(20,remaining_work) for update loop');
 old:='   end loop;
   update khub_bot.raffle_inventory set quantity=0 where raffle_id=r.id;';
 if strpos(source,old)=0 then raise exception 'Unexpected inventory return boundary'; end if;
 source:=replace(source,old,'    remaining_work:=remaining_work-1;
    update khub_bot.raffle_inventory set quantity=0 where raffle_id=r.id and item_id=x.item_id;
   end loop;
   if exists(select 1 from khub_bot.raffle_inventory where raffle_id=r.id and quantity>0) then
    update khub_bot.raffle_accounts set next_work_at=clock_timestamp() where raffle_id=r.id;
    continue;
   end if;');
 execute source;
end $patch$;
create or replace function public.bot_raffle_tick() returns void language sql security definer set search_path='' as $$ select khub_bot.raffle_tick_bounded(false); $$;
create function public.bot_raffle_tick_due() returns void language sql security definer set search_path='' as $$ select khub_bot.raffle_tick_bounded(true); $$;
-- Wakeups commit with the state change. No external calls or cached authority.
create function khub_bot.wake_raffle_work() returns trigger language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 if tg_op='DELETE' then delete from khub_bot.raffle_work_wakeups where raffle_id=old.id; return old; end if;
 if tg_table_name='mystery_raffles' then
  if new.state not in ('fulfilling','empty','cancelled','returning') then return new; end if;
  rid:=new.id;
 elsif tg_table_name='deliveries' then
  if coalesce(new.dedupe_key,'') !~ '^raffle:[0-9a-f-]{36}:' then return new; end if;
  rid:=split_part(new.dedupe_key,':',2)::uuid;
 else rid:=new.raffle_id; end if;
 insert into khub_bot.raffle_work_wakeups(raffle_id) values(rid);
 return new;
end $$;
create trigger cleanup_raffle_wakeups after delete on public.mystery_raffles for each row execute function khub_bot.wake_raffle_work();
create trigger wake_raffle_state after update of state on public.mystery_raffles for each row when(old.state is distinct from new.state) execute function khub_bot.wake_raffle_work();
create trigger wake_raffle_supply_insert after insert on khub_bot.raffle_inventory for each row execute function khub_bot.wake_raffle_work();
create trigger wake_raffle_supply_update after update of quantity on khub_bot.raffle_inventory for each row when(old.quantity is distinct from new.quantity) execute function khub_bot.wake_raffle_work();
create trigger wake_raffle_delivery_insert after insert on khub_bot.deliveries for each row execute function khub_bot.wake_raffle_work();
create trigger wake_raffle_delivery_update after update of state on khub_bot.deliveries for each row when(old.state is distinct from new.state) execute function khub_bot.wake_raffle_work();
create function public.bot_defer_raffle_draw(p_id uuid,p_round bigint,p_failed boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(3888760);
 update khub_bot.raffle_accounts a set draw_failures=case when p_failed then least(draw_failures+1,10) else draw_failures end,
 next_work_at=greatest(to_timestamp(1692803367+(p_round-1)*3),clock_timestamp()+case when p_failed then make_interval(secs=>least(60,5*power(2,least(draw_failures,4)))::double precision) else interval '0 seconds' end)
 from public.mystery_raffles r,khub_bot.raffle_fairness f
 where a.raffle_id=p_id and r.id=a.raffle_id and r.state='drawing' and f.raffle_id=a.raffle_id and f.round=p_round and f.result is null;
end $$;
-- Clone the installed draw/fairness barriers, changing only due-row selection.
-- Deferred manifests are not deserialized or rotated by unrelated due raffles.
do $patch$
declare source text; anchor text;
begin
 source:=pg_get_functiondef('khub_bot.draw_work_before_fairness()'::regprocedure);
 anchor:='where mr.state=''drawing'' order by ra.last_work_at,mr.ends_at,mr.id limit 5';
 if strpos(source,anchor)=0 then raise exception 'Unexpected fair draw selection'; end if;
 source:=replace(source,'FUNCTION khub_bot.draw_work_before_fairness()', 'FUNCTION khub_bot.draw_work_before_fairness_due()');
 source:=replace(source,anchor,'where mr.state=''drawing'' and ra.next_work_at<=statement_timestamp() order by ra.last_work_at,mr.ends_at,mr.id limit 5');
 execute source;
 source:=pg_get_functiondef('public.bot_raffle_draw_work()'::regprocedure);
 if strpos(source,'work:=khub_bot.draw_work_before_fairness();')=0 then raise exception 'Unexpected fairness wrapper'; end if;
 source:=replace(source,'FUNCTION public.bot_raffle_draw_work()', 'FUNCTION public.bot_raffle_draw_work_due()');
 source:=replace(source,'work:=khub_bot.draw_work_before_fairness();','work:=khub_bot.draw_work_before_fairness_due();');
 execute source;
end $patch$;
-- Hints only: actual claims and financial checks remain authoritative. Fetch
-- after complete inbox intake; refresh work discovery after any maintenance.
create function public.bot_cycle_plan() returns jsonb language sql stable security definer set search_path='' as $$
 select public.bot_read_work_queue() || jsonb_build_object('plan_version',1,'server_now',statement_timestamp(),
 'oldest_pending_delivery_at',(select created_at from khub_bot.deliveries where state='pending' order by created_at,id limit 1),
 'auction_due',exists(select 1 from public.auctions where status='active' and end_time<=statement_timestamp() or status='settling' or status='pending_escrow' and not start_on_deposit and end_time<=statement_timestamp()),
 'draw_due',exists(select 1 from public.mystery_raffles r join khub_bot.raffle_accounts a on a.raffle_id=r.id where r.state='active' and r.ends_at<=statement_timestamp() or r.state='drawing' and a.next_work_at<=statement_timestamp()),
 'raffle_due',exists(select 1 from public.mystery_raffles r join khub_bot.raffle_accounts a on a.raffle_id=r.id where r.state in ('fulfilling','empty','cancelled','returning') and (a.next_work_at<=statement_timestamp() or exists(select 1 from khub_bot.raffle_work_wakeups wake where wake.raffle_id=r.id))));
$$;
revoke all on function public.bot_worker_safety(),public.bot_cycle_plan(),public.bot_raffle_tick_due(),public.bot_raffle_draw_work_due(),public.bot_defer_raffle_draw(uuid,bigint,boolean),khub_bot.raffle_tick_bounded(boolean),khub_bot.draw_work_before_fairness_due(),khub_bot.wake_raffle_work() from public,anon,authenticated,service_role;
grant execute on function public.bot_worker_safety(),public.bot_cycle_plan(),public.bot_raffle_tick_due(),public.bot_raffle_draw_work_due(),public.bot_defer_raffle_draw(uuid,bigint,boolean) to service_role;
notify pgrst,'reload schema';
commit;
