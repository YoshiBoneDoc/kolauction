-- Apply after 173. Fix read-only Home RPC failures when milestone totals expire.
-- No financial data or authorization changes. Existing snapshot remains available.
begin;
set local lock_timeout='2s';
alter function khub_bot.site_trade_totals() rename to refresh_site_trade_totals;
create function khub_bot.site_trade_totals() returns jsonb
language sql stable security definer set search_path='' as $$
 select totals from khub_bot.site_trade_totals_snapshot where singleton;
$$;
revoke all on function khub_bot.site_trade_totals(),khub_bot.refresh_site_trade_totals()
 from public,anon,authenticated,service_role;
-- Preserve discovery refresh and stale activity cleanup from 173.
create or replace function public.bot_refresh_public_discovery() returns void
language plpgsql security definer set search_path='' as $$
begin
 perform khub_bot.refresh_public_discovery();
 delete from public.site_activity where last_seen<now()-interval '5 minutes';
 perform khub_bot.refresh_site_trade_totals();
end;$$;
notify pgrst,'reload schema';
commit;
