-- Extend the shared, persisted display-only snapshot from 5 to 15 minutes.
-- Retain its nonblocking lock, stale fallback and post-lock freshness check.
-- No financial records, calculations, permissions or bot operations change.
begin;
set local lock_timeout='2s';
do $patch$
declare
    definition text := pg_get_functiondef('khub_bot.site_trade_totals()'::regprocedure);
    old_interval text := 'interval ''5 minutes''';
    new_interval text := 'interval ''15 minutes''';
begin
    if strpos(definition,'pg_try_advisory_xact_lock(3888764)')=0 then
        raise exception 'Expected nonblocking milestones cache lock; inspect before applying 151.';
    end if;
    if (length(definition)-length(replace(definition,old_interval,'')))/length(old_interval)=2 then
        execute replace(definition,old_interval,new_interval);
    elsif (length(definition)-length(replace(definition,new_interval,'')))/length(new_interval)<>2 then
        raise exception 'Unexpected milestones cache interval; inspect before applying 151.';
    end if;
end;
$patch$;
commit;
