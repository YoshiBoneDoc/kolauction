# Homepage totals

Apply [migration 150](../supabase/migrations/202610290150_homepage_trade_totals.sql)
and [migration 151](../supabase/migrations/queue/202610290151_milestones_cache_interval.sql),
then deploy the website and public cache Worker through the existing Git workflows.
No bot update is required. Until the migration is applied and the homepage snapshot
refreshes, the totals row is omitted rather than displaying invented zero values.

The three figures are public lifetime aggregates:

- Meat: completed Sell final prices plus confirmed Buy fulfillment payments,
  excluding commissions, funding deposits, refunds and donations.
- Items: quantities from those trades; bundle components are summed individually.
- Trades: one per completed Sell auction and one per paid Buy fulfillment.
  Partial Buy-order purchases remain included if the order later expires or cancels.

An independent, nonblocking fifteen-minute database snapshot is reused by both the
direct and shared-cache homepage reads. The browser makes no extra request for
these figures. The public cache allows only three nonnegative decimal strings;
no account balances, participant details or transaction records are shared.
The display may lag by the snapshot interval plus normal public-cache refresh.
These numbers never authorize any financial operation.

Concurrent visitors reuse the same persisted singleton snapshot. On expiry,
one reader obtains a separate nonblocking advisory lock and recalculates; other
readers immediately receive the previous totals. Freshness is checked again after
acquiring the lock, preventing redundant recalculation. The existing homepage
Durable Object also coalesces requests and serves stale homepage snapshots while
refreshing through `waitUntil`, when a reusable listing snapshot is available.
Cold/invalidated homepage reads can wait for fresh listings; the milestones do not
extend listing freshness or weaken accepted-bid invalidation. No timers, per-user
caches, new requests or background polling jobs are introduced for milestones.

Icons are served locally; sources and artwork credits are in
[the icon README](../public/images/site-stats/README.md).
