-- After 268 (compatible with 269-283). Apply once per database.
-- Leaderboard display/ranking only: one completed-trade credit per player/auction.
-- Preserves payment eligibility, full Meat volume, donations and locked fee terms.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
create or replace function khub_bot.refresh_leaderboards() returns void
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from khub_bot.leaderboard_state where refreshed_at>clock_timestamp()-interval '5 minutes') then return; end if;
 if not pg_try_advisory_xact_lock(3888770) then return; end if;
 if exists(select 1 from khub_bot.leaderboard_state where refreshed_at>clock_timestamp()-interval '5 minutes') then return; end if;
 -- Same completed-sale/confirmed-Buy definitions as site totals. Both parties
 -- receive credit once per auction, regardless of split Buy fulfillments.
 -- Every eligible payment still contributes its full Meat value.
 delete from khub_bot.leaderboard_totals where profile_id is not null;
 insert into khub_bot.leaderboard_totals(profile_id,volume,trades,donated)
 with sales as materialized (
   select a.id auction_id,a.seller_id,a.winner_id,a.final_price::numeric meat from public.auctions a
   where a.auction_kind='sell' and a.status='completed' and a.winner_id is not null and a.final_price is not null
 ), purchases as materialized (
   select a.id auction_id,f.seller_id,a.seller_id buyer_id,f.payment_meat::numeric meat
   from khub_bot.buy_fulfillments f join public.auctions a on a.id=f.auction_id
   where exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id and d.dedupe_key like 'buy-fill-payment:%' and d.state='sent')
   and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=f.receipt_id and d.dedupe_key like 'buy-fill-payment:%' and d.state<>'sent')
 ), activity as (
   select s.seller_id profile_id,s.auction_id,s.meat from sales s
   union all select s.winner_id,s.auction_id,s.meat from sales s where s.winner_id<>s.seller_id
   union all select p.seller_id,p.auction_id,p.meat from purchases p
   union all select p.buyer_id,p.auction_id,p.meat from purchases p where p.buyer_id<>p.seller_id
 ), totals as (
   select profile_id,sum(meat) volume,count(distinct auction_id) trades,0::numeric donated from activity group by profile_id
   union all
   -- No speculative item/gift valuation or commission income in donor rankings.
   select p.id,0::numeric,0::bigint,sum((r.payload->>'meat')::numeric)
   from khub_bot.report_donations() r join public.profiles p on p.kol_player_id=r.sender_id and p.kol_verified_at is not null
   where r.payload#>>'{raw,type}'='normal' and (r.payload->>'meat')::numeric>0 group by p.id
 ) select profile_id,sum(volume),sum(trades)::bigint,sum(donated) from totals group by profile_id;
 insert into khub_bot.leaderboard_state values(true,clock_timestamp())
 on conflict(singleton) do update set refreshed_at=excluded.refreshed_at;
end;$$;
-- Rebuild historical rankings on the next normal discovery maintenance run.
-- Avoid running the full historical aggregate during installation.
update khub_bot.leaderboard_state set refreshed_at='-infinity' where singleton;
notify pgrst,'reload schema';
commit;
