-- After 261 (and existing 178 Site maintenance). Apply once, then deploy website.
-- Display snapshots only. No financial lock, settlement, fee or delivery changes.
-- Uses the existing totals maintenance task/cooldowns; no new scheduler or polling.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
create table khub_bot.leaderboard_totals (
 profile_id uuid primary key references public.profiles(id) on delete cascade,
 volume numeric not null, trades bigint not null, donated numeric not null
);
create index leaderboard_volume_idx on khub_bot.leaderboard_totals(volume desc,profile_id);
create index leaderboard_trades_idx on khub_bot.leaderboard_totals(trades desc,profile_id);
create index leaderboard_donated_idx on khub_bot.leaderboard_totals(donated desc,profile_id);
create table khub_bot.leaderboard_state (
 singleton boolean primary key default true check(singleton), refreshed_at timestamptz not null
);
alter table khub_bot.leaderboard_totals enable row level security;
alter table khub_bot.leaderboard_state enable row level security;
revoke all on khub_bot.leaderboard_totals,khub_bot.leaderboard_state from public,anon,authenticated,service_role;
create function khub_bot.refresh_leaderboards() returns void
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from khub_bot.leaderboard_state where refreshed_at>clock_timestamp()-interval '5 minutes') then return; end if;
 if not pg_try_advisory_xact_lock(3888770) then return; end if;
 if exists(select 1 from khub_bot.leaderboard_state where refreshed_at>clock_timestamp()-interval '5 minutes') then return; end if;
 -- Same completed-sale/confirmed-Buy definitions as site totals. Both parties
 -- receive activity credit, once per trade; bundles remain one completed trade.
 delete from khub_bot.leaderboard_totals;
 insert into khub_bot.leaderboard_totals(profile_id,volume,trades,donated)
 with sales as materialized (
   select a.seller_id,a.winner_id,a.final_price::numeric meat from public.auctions a
   where a.auction_kind='sell' and a.status='completed' and a.winner_id is not null and a.final_price is not null
 ), purchases as materialized (
   select f.seller_id,a.seller_id buyer_id,f.payment_meat::numeric meat
   from khub_bot.buy_fulfillments f join public.auctions a on a.id=f.auction_id
   where exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id and d.dedupe_key like 'buy-fill-payment:%' and d.state='sent')
   and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id and d.dedupe_key like 'buy-fill-payment:%' and d.state<>'sent')
 ), activity as (
   select s.seller_id profile_id,s.meat from sales s
   union all select s.winner_id,s.meat from sales s where s.winner_id<>s.seller_id
   union all select p.seller_id,p.meat from purchases p
   union all select p.buyer_id,p.meat from purchases p where p.buyer_id<>p.seller_id
 ), totals as (
   select profile_id,sum(meat) volume,count(*) trades,0::numeric donated from activity group by profile_id
   union all
   -- No speculative item/gift valuation or commission income in donor rankings.
   select p.id,0::numeric,0::bigint,sum((r.payload->>'meat')::numeric)
   from khub_bot.report_donations() r join public.profiles p on p.kol_player_id=r.sender_id and p.kol_verified_at is not null
   where r.payload#>>'{raw,type}'='normal' and (r.payload->>'meat')::numeric>0 group by p.id
 ) select profile_id,sum(volume),sum(trades)::bigint,sum(donated) from totals group by profile_id;
 insert into khub_bot.leaderboard_state values(true,clock_timestamp())
 on conflict(singleton) do update set refreshed_at=excluded.refreshed_at;
end;$$;
revoke all on function khub_bot.refresh_leaderboards() from public,anon,authenticated,service_role;
-- Reuse existing background totals cadence, resource limits and failure cooldown.
alter function khub_bot.refresh_site_trade_totals() rename to refresh_site_totals_before_leaderboards;
create function khub_bot.refresh_site_trade_totals() returns jsonb
language plpgsql security definer set search_path='' as $$
declare totals jsonb;
begin
 totals:=khub_bot.refresh_site_totals_before_leaderboards();
 perform khub_bot.refresh_leaderboards();
 return totals;
end;$$;
revoke all on function khub_bot.refresh_site_totals_before_leaderboards(),khub_bot.refresh_site_trade_totals() from public,anon,authenticated,service_role;
create function khub_bot.mark_donation_leaderboards_dirty() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (tg_op<>'DELETE' and new.result='donation') or (tg_op<>'INSERT' and old.result='donation') then
   insert into khub_bot.site_totals_dirty values(txid_current()) on conflict do nothing;
 end if;
 return null;
end;$$;
revoke all on function khub_bot.mark_donation_leaderboards_dirty() from public,anon,authenticated,service_role;
create trigger leaderboard_donation_dirty after insert or update or delete on khub_bot.receipts
for each row execute function khub_bot.mark_donation_leaderboards_dirty();
create function public.read_leaderboards() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); result jsonb; category text; entries jsonb;
begin
 if actor is null or khub_bot.profile_is_restricted(actor) then raise exception 'Sign in with an unrestricted account to view leaderboards.' using errcode='42501'; end if;
 if not exists(select 1 from khub_bot.leaderboard_state) then raise exception 'Leaderboards are being prepared.'; end if;
 result:=jsonb_build_object('refreshed_at',(select refreshed_at from khub_bot.leaderboard_state where singleton));
 foreach category in array array['volume','trades','donors'] loop
   -- An explicit column allowlist permits index-ordered top-ten reads. Names and
   -- current restrictions/ignores are evaluated privately at read time, never cached publicly.
   execute format($query$
     select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'value',value::text,'rank',rank) order by rank),'[]'::jsonb)
     from (select p.id,coalesce(nullif(p.kol_player_name,''),p.khub_username) name,t.%1$I value,
       row_number() over(order by t.%1$I desc,t.profile_id) rank
       from khub_bot.leaderboard_totals t join public.profiles p on p.id=t.profile_id
       where t.%1$I>0 and p.kol_verified_at is not null and not khub_bot.profile_is_restricted(p.id)
       and not exists(select 1 from public.player_ignores i join public.profiles viewer on viewer.id=$1
         where (i.user_id=$1 and i.kol_player_id=p.kol_player_id) or (i.user_id=p.id and i.kol_player_id=viewer.kol_player_id))
       order by t.%1$I desc,t.profile_id limit 10) ranked
   $query$,case category when 'donors' then 'donated' else category end) into entries using actor;
   result:=result||jsonb_build_object(category,entries);
 end loop;
 return result;
end;$$;
revoke all on function public.read_leaderboards() from public,anon,authenticated,service_role;
grant execute on function public.read_leaderboards() to authenticated;
select khub_bot.refresh_leaderboards();
notify pgrst,'reload schema';
commit;
