-- After 177. Separate maintenance ownership from the financial bot. Deployment
-- gate: run all Site tasks successfully, then call activate_site_maintenance().
begin;
set local lock_timeout='2s';
create role khub_site_maintenance nologin;
grant usage on schema public to khub_site_maintenance;
do $$begin
 if exists(select 1 from pg_roles where rolname='authenticator') then
   grant khub_site_maintenance to authenticator;
 end if;
end;$$;
create table khub_bot.site_maintenance_state (
 task text primary key check(task in('discovery','activity','totals')),
 last_success timestamptz, next_attempt timestamptz not null default '-infinity',
 failures integer not null default 0, last_error text
);
insert into khub_bot.site_maintenance_state(task) values('discovery'),('activity'),('totals');
create table khub_bot.site_maintenance_owner(singleton boolean primary key default true check(singleton),site_owned boolean not null default false);
insert into khub_bot.site_maintenance_owner values(true,false);
revoke all on khub_bot.site_maintenance_state,khub_bot.site_maintenance_owner from public,anon,authenticated,service_role,khub_site_maintenance;
create index if not exists site_activity_cleanup_idx on public.site_activity(last_seen);
-- Totals only rebuild after relevant source tables change. The statement trigger
-- writes a dirty marker once per transaction, without acquiring financial locks.
create table khub_bot.site_totals_dirty(transaction_id bigint primary key);
insert into khub_bot.site_totals_dirty values(txid_current());
revoke all on khub_bot.site_totals_dirty from public,anon,authenticated,service_role,khub_site_maintenance;
-- Avoid a shared dirty-row write on every bid: these triggers only cover changes
-- that can alter historical totals. Concurrent inserts are bounded by source writes.
create function khub_bot.mark_totals_dirty() returns trigger
language plpgsql security definer set search_path='' as $$begin
 if tg_table_name='auctions' then
   if tg_op='INSERT' and new.status<>'completed' then return null; end if;
   if tg_op='DELETE' and old.status<>'completed' then return null; end if;
   if tg_op='UPDATE' then
     if old.status<>'completed' and new.status<>'completed' then return null; end if;
     if (old.status,old.final_price,old.winner_id,old.quantity,old.bundle_items) is not distinct from
        (new.status,new.final_price,new.winner_id,new.quantity,new.bundle_items) then return null; end if;
   end if;
 elsif tg_table_name='deliveries' then
   if tg_op='INSERT' and coalesce(new.dedupe_key,'') not like 'buy-fill-payment:%' then return null; end if;
   if tg_op='DELETE' and coalesce(old.dedupe_key,'') not like 'buy-fill-payment:%' then return null; end if;
   if tg_op='UPDATE' then
     if coalesce(old.dedupe_key,'') not like 'buy-fill-payment:%' and coalesce(new.dedupe_key,'') not like 'buy-fill-payment:%' then return null; end if;
     if (old.state,old.dedupe_key,old.receipt_id) is not distinct from (new.state,new.dedupe_key,new.receipt_id) then return null; end if;
   end if;
 end if;
 insert into khub_bot.site_totals_dirty values(txid_current()) on conflict do nothing;
 return null;
end;$$;
create trigger site_totals_auction_dirty after insert or delete or update of status,final_price,winner_id,quantity,bundle_items on public.auctions
for each row execute function khub_bot.mark_totals_dirty();
create trigger site_totals_fulfillment_dirty after insert or update or delete on khub_bot.buy_fulfillments
for each row execute function khub_bot.mark_totals_dirty();
create trigger site_totals_delivery_dirty after insert or update or delete on khub_bot.deliveries
for each row execute function khub_bot.mark_totals_dirty();
create function khub_bot.run_site_maintenance(p_task text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='100ms' as $$
declare s khub_bot.site_maintenance_state; cadence interval; code text;
begin
 if not pg_try_advisory_xact_lock(3888765) then return jsonb_build_object('state','busy'); end if;
 select * into strict s from khub_bot.site_maintenance_state where task=p_task for update;
 if s.next_attempt>clock_timestamp() then return jsonb_build_object('state','deferred'); end if;
 cadence:=case p_task when 'discovery' then interval '60 seconds' when 'activity' then interval '5 minutes' else interval '30 minutes' end;
 begin
   if p_task='discovery' then perform khub_bot.refresh_public_discovery();
   elsif p_task='activity' then
      delete from public.site_activity where ctid in (
        select ctid from public.site_activity where last_seen<statement_timestamp()-interval '5 minutes'
        order by last_seen limit 1000 for update skip locked);
   elsif p_task='totals' then
      -- Transaction-keyed markers avoid a global writer lock. Concurrent
      -- transactions insert different keys; unobserved markers survive this run.
      if exists(select 1 from khub_bot.site_totals_dirty) or not exists(select 1 from khub_bot.site_trade_totals_snapshot) then
         delete from khub_bot.site_totals_dirty;
         -- The scheduler owns cadence; force a refresh only when dirty.
         update khub_bot.site_trade_totals_snapshot set refreshed_at='-infinity';
         perform khub_bot.refresh_site_trade_totals();
      end if;
   end if;
 exception when query_canceled or lock_not_available or others then
   get stacked diagnostics code=returned_sqlstate;
   update khub_bot.site_maintenance_state set failures=least(failures+1,8),last_error=code,
      next_attempt=clock_timestamp()+least(interval '30 minutes',interval '1 minute'*power(2,least(s.failures+1,5))) where task=p_task;
   -- A resource/lock failure defers all optional work, across Worker isolates.
   update khub_bot.site_maintenance_state set next_attempt=greatest(next_attempt,clock_timestamp()+interval '5 minutes');
   return jsonb_build_object('state','deferred','code',code);
 end;
 update khub_bot.site_maintenance_state set last_success=clock_timestamp(),failures=0,last_error=null,
    next_attempt=date_trunc('minute',statement_timestamp())+cadence where task=p_task;
 return jsonb_build_object('state','ok');
end;$$;
create function public.site_refresh_discovery() returns jsonb language sql security definer set search_path='' set statement_timeout='1500ms' set lock_timeout='100ms' as $$select khub_bot.run_site_maintenance('discovery');$$;
create function public.site_cleanup_activity() returns jsonb language sql security definer set search_path='' set statement_timeout='1000ms' set lock_timeout='100ms' as $$select khub_bot.run_site_maintenance('activity');$$;
create function public.site_refresh_totals() returns jsonb language sql security definer set search_path='' set statement_timeout='2500ms' set lock_timeout='100ms' as $$select khub_bot.run_site_maintenance('totals');$$;
create function public.site_maintenance_status() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('site_owned',(select site_owned from khub_bot.site_maintenance_owner),'tasks',(select jsonb_agg(to_jsonb(s)) from khub_bot.site_maintenance_state s));
$$;
create function public.activate_site_maintenance() returns void language plpgsql security definer set search_path='' as $$begin
 if (select count(*) from khub_bot.site_maintenance_state where last_success>now()-interval '1 hour')<>3 then
   raise exception 'Verify all three Site tasks successfully before activation';
 end if;
 update khub_bot.site_maintenance_owner set site_owned=true;
end;$$;
alter function public.bot_worker_status() rename to worker_status_before_site_maintenance;
revoke all on function public.worker_status_before_site_maintenance() from public,anon,authenticated,service_role;
create function public.bot_worker_status() returns jsonb language sql stable security definer set search_path='' as $$
 select public.worker_status_before_site_maintenance()||jsonb_build_object('siteMaintenanceOwned',(select site_owned from khub_bot.site_maintenance_owner));
$$;
revoke all on function public.bot_worker_status() from public,anon,authenticated;
grant execute on function public.bot_worker_status() to service_role;
-- Old bot versions become harmless after the verified handoff. No automatic
-- fallback scheduler: a Site outage must not put maintenance back on the bot.
alter function public.bot_refresh_public_discovery() rename to bot_maintenance_before_site;
revoke all on function public.bot_maintenance_before_site() from public,anon,authenticated,service_role;
create function public.bot_refresh_public_discovery() returns void language plpgsql security definer set search_path='' as $$begin
 if not (select site_owned from khub_bot.site_maintenance_owner) then perform public.bot_maintenance_before_site(); end if;
end;$$;
grant execute on function public.bot_refresh_public_discovery() to service_role;
revoke all on function khub_bot.mark_totals_dirty(),khub_bot.run_site_maintenance(text),public.site_refresh_discovery(),public.site_cleanup_activity(),public.site_refresh_totals(),public.site_maintenance_status(),public.activate_site_maintenance(),public.bot_refresh_public_discovery() from public,anon,authenticated;
grant execute on function public.site_refresh_discovery(),public.site_cleanup_activity(),public.site_refresh_totals(),public.site_maintenance_status() to khub_site_maintenance;
-- Activation is operator-only (SQL Editor owner), not granted to the Worker.
notify pgrst,'reload config';
notify pgrst,'reload schema';
commit;
