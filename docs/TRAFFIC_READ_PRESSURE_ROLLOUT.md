# Traffic read-pressure changes

New local changes reduce reads without altering auction bids, financial locking,
intake, draw computation, settlement, or cache admission limits. Deployment status
is not inferred from local migration locations.

## Behavior

- Commitment polling has jitter, exponential failure backoff (up to five minutes
  before jitter), hidden-page pausing, serialization and focus cooldowns.
- With shared caching enabled, public commitment metadata uses the existing cache
  class/scheduler through a separate named object. Concurrent viewers coalesce;
  snapshots expire after five seconds, with no stale fallback. The projection
  contains only the existing public record and a completion boolean. It never
  contains names, private state, manifests, totals, purchases or credentials.
- Private fairness status refreshes at most once per minute per browser/token.
  Proof remains an explicit action. Cancellation/empty status therefore can take
  up to a minute to appear. Public completion can arrive at the next shared poll.
- Raffle lists, details, counts and personal history reuse the bounded auction
  memory cache with token scoping, two request slots and failure cooldowns.
  Repeated mounts coalesce and reuse successful data for 15 seconds. Management
  writes invalidate these snapshots and force authoritative refreshes.
- Account access returns administrator/raffle permissions and invitation status in
  one RPC. Older schemas keep the previous permission reads and a throttled
  invitation refresh until SQL is upgraded. Server writes still check permissions.
- Personal purchase history loads 50 receipts per page. Exact personal totals are
  computed separately; refund checks only run for that page. Private ticket label
  offsets and refund status semantics are preserved. The old RPC remains intact.
- A player-leading purchase index supports personal history and paged reads.
  Its production benefit depends on data volume/plans; no capacity claim is made.

## Apply order

1. Verify the installed definitions of migration 227 before proceeding. Do not
   rerun it solely because a file is present. Existing 227 and its tests were
   left untouched by this change.
2. Manually apply `supabase/migrations/queue/202611050228_raffle_read_pressure.sql`
   after prerequisites through 227. The script is transactional with bounded lock
   and statement waits. A timeout rolls it back; investigate contention rather
   than removing the timeout during heavy traffic. The matching standalone copy
   is in `bot/supabase/migrations/`. These are the same script: do not apply both
   copies to one database. Move the queued file only after successful application.
3. Deploy the cache Worker, then the website Worker/assets using the established
   deployment procedure. Use `npm run build:cloudflare` so shared caching is
   compiled in. The new site route requires the updated cache Worker and SQL.
   No bot JavaScript changed, so this change alone needs no bot restart/rebuild.
4. Confirm `/khub-build.json`, Worker deployment versions and database definition
   fingerprints separately. Test authorized raffle/history and anonymous public
   commitment reads. Never test by sending real assets or starting another bot.

## Measure during traffic

Run `scripts/traffic-diagnostics.sql` manually in Supabase SQL Editor during the
incident. It reads session/wait/lock summaries and function fingerprints without
SQL text, credentials or player payloads. Capture timestamps and affected routes.
It creates no tables and changes no database state. Access to statistics depends
on the SQL Editor role. Capture Supabase resource charts at the same time.

Cache logs now include `[PUBLIC_CACHE_QUEUE]` wait duration and pending counts and
`[PUBLIC_CACHE_ORIGIN]` RPC family/duration. Existing `[PUBLIC_CACHE]` error codes,
queue caps and circuit breakers remain. Logs omit IDs, request parameters and raw
origin bodies. Correlate these with request rates and p95/p99 browser/origin timing;
a queue timeout alone does not prove CPU saturation or financial lock contention.

For representative plans, use actual incident parameters and roles in a controlled
read-only session. Inspect `read_auction_page`, `read_auction_detail_static`,
`read_auction_bid_history`, private card/detail projection, and personal raffle
history. Avoid unbounded `EXPLAIN ANALYZE` on production during an outage. Compare
plans/latency at equal data sizes before any further SQL or lock changes.

The global financial lock and Worker concurrency limits intentionally retain their
current values. Changing them requires evidence about longest lock holders and
origin pressure; this read-pressure release adds the instrumentation to obtain it.

## Second read-pressure release (migration 229)

Apply `supabase/migrations/queue/202611050229_background_read_efficiency.sql`
after 228, before deploying this website. The standalone copy has the same name
under `bot/supabase/migrations/`; apply only one copy to the shared database.
No bot JavaScript, financial locks, write validation or Worker admission limits
change. Local file placement does not establish installed production definitions.

- Collapsed pending trades load only an eligibility-matched count every two
  minutes. Expanding loads the existing 12-card page and refreshes it every 30
  seconds; collapsing stops those full reads. Empty panels return to summary mode.
  The new SQL derives its matching predicate from the installed reader, fails on
  unexpected layout, and selects IDs instead of materializing full auction rows.
- Active shared detail pages refresh private context at 60 seconds, rather than
  30. Closed detail pages poll at 60 seconds and refresh full private data at 120
  seconds. Shared live prices/deadlines, auth-token scoping, ignore invalidation,
  status transitions and explicit post-write reads retain their verification paths.
  Existing bid-history revision checks remain; no extra revision-maintenance table
  or speculative index was added. Bid-related identity fields remain unknown when
  the live amount disagrees with the cached private context.
- Confirmed website bids return their result without waiting for reconciliation.
  They invalidate pre-write data and start a fresh selected-page read, without
  fetching pending trades. A failed or uncertain submission triggers a read but
  is never automatically resubmitted. The form blocks another submission during
  reconciliation after success; failed refreshes retain the existing unavailable
  behavior. Other trade actions still await their existing reconciliation.
- Account refreshes coordinate under Web Locks with hashed resource keys and
  timestamps only. Each tab performs its own initial, focus and explicit reads;
  periodic followers may reuse their existing in-memory profile for at most five
  minutes before independently checking again. Opaque change signals prompt other
  tabs to revalidate; profiles and tokens are never shared. Storage/Web Locks
  failures fall back to local reads. Account reads have a 12-second deadline so
  a stalled read cannot hold the cross-tab lock indefinitely. Administrator UI
  uses the account's existing server-verified flag instead of another RPC.
- Presence uses the existing cross-tab heartbeat coordination at 90 seconds, with
  failure backoff and jitter. Administrator counts cover three recent minutes to
  allow for that cadence. During busy mode presence/count reads pause. These are
  approximate recent viewers, not a precise live connection count.
- Busy mode is a per-browser hint from display-read latency/errors, not a claim
  about global database load. Three slow (at least 2.5 seconds) or failed display
  reads among the last 20 observations within 30 seconds enter it. It holds for
  at least 60 seconds and recovers after five fast (under one second) observations.
  Optional private polling and pending counts slow to three times their normal
  intervals; focus cannot bypass a one-minute busy cooldown. Explicit account
  changes retain the five-second cooldown. Live auction polling, authoritative
  writes and their reconciliation are not slowed. Regular reads continue to
  provide recovery observations, and existing stale/unavailable labels remain.

The current SQL already has inlineable auction visibility, maintained bid counts,
and keyset bid-history pagination. This release does not replace those mechanisms
or assume that new indexes improve production queries. The isolated lifecycle
suite checks summary/full-reader equivalence for both parties and an unrelated
viewer, verifies that financial definitions are unchanged, and prints paired warm
`EXPLAIN (ANALYZE, BUFFERS)` execution times. These small local fixtures establish
correctness and illustrate avoided projection work, not peak production capacity.
Use incident parameters and the existing diagnostics for further SQL optimization.
