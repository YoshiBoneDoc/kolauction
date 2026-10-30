-- Display-only lifetime maximum bid count. Reuse the 15-minute singleton cache,
-- nonblocking refresh lock and stale fallback; no per-visitor aggregate query.
begin;
set local lock_timeout='2s';
do $patch$
declare
    definition text := pg_get_functiondef('khub_bot.site_trade_totals()'::regprocedure);
    original text := $old$'trades',count(*)::text) into cached from trades;$old$;
    replacement text := $new$'trades',count(*)::text,
        'record_bids',(select coalesce(max(counts.bid_count),0)::text
            from (select count(*) as bid_count from public.bids group by auction_id) counts))
        into cached from trades;$new$;
begin
    if strpos(definition,'pg_try_advisory_xact_lock(3888764)')=0
        or strpos(definition,'interval ''15 minutes''')=0 then
        raise exception 'Expected migration 151 milestones cache; inspect before applying 152.';
    end if;
    if strpos(definition,replacement)>0 then return; end if;
    if strpos(definition,original)=0 then
        raise exception 'Unexpected milestones totals projection; inspect before applying 152.';
    end if;
    execute replace(definition,original,replacement);
    -- Expire only the display snapshot, so the next shared refresh includes the
    -- new statistic. Preserve old totals for readers while refresh is underway.
    update khub_bot.site_trade_totals_snapshot
        set refreshed_at=least(refreshed_at,clock_timestamp()-interval '16 minutes');
end;
$patch$;
commit;
