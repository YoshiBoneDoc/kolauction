# Scoped reads and query statistics (migration 231)

These changes target the remaining private card/Home projection costs and routine gift-state traffic. Local fixtures verify behavior and demonstrate lower execution time; they do not establish production savings or explain a past incident. Measure the deployed versions before tuning the existing scheduler again.

## Rollout

1. Review/apply `supabase/migrations/queue/202611050231_scoped_gift_and_card_reads.sql` through the normal database migration process. The matching `bot/supabase/migrations/202611050231_scoped_gift_and_card_reads.sql` is an identical copy for the same database: apply it once. Existing migrations must already be installed.
2. Deploy the website build. Signed-in/direct Home reads now call `read_home_cards`; the SQL must precede this deployment. The shared public Worker keeps its existing endpoint and benefits from the underlying Buy projection optimization. No Worker concurrency increase is required.
3. Deploy the bot independently. Full and safety capability reports advertise `scopedGiftStateVersion: 1`. A new bot against an older database retains the legacy gift reader; an older bot continues using its unchanged diagnostic endpoint. Do not advertise the capability separately from the migration.
4. Compare equivalent traffic periods using the statistics workflow below and existing `[BOT_PERFORMANCE]`/scheduler telemetry. Check calls and execution time for both old/new Home and gift endpoints, card context, scheduler empty work, failures, and end-to-end intake/cycle latency.

Nothing here applies SQL or deploys either application automatically. The bot copy is in the repository's ignored bot workspace; include it in the normal bot release packaging rather than force-adding ignored files.

## What changed

- `read_auction_card_context` now returns only the viewer-specific fields required by cards, including authorized names and the viewer's own Buy reservation. Detail/history/contact and account balance reads retain their existing paths. Sell/Buy active seller restrictions are evaluated once per distinct seller in the batch. Migration 192 already supplied this optimization for other listing readers; those implementations remain intact.
- `read_home_cards` retains existing visibility, ignore rules, section selection and cached site totals while using public card projections. The public Buy projection reads quantities and delivery state without constructing private fulfillment/history data. Legacy detail-rich Home endpoints remain available for comparison and existing clients.
- Live browse overlays use an authorization-scoped, memory-only per-auction cache: at most 256 entries, 60-second TTL, batches of at most 24 IDs, coalesced overlapping requests. Token changes, ignore changes, explicit refreshes, authorization errors and listing status changes invalidate or reject old context; reservation expiry limits its lifetime. Live public prices remain authoritative. Static snapshots and seller/detail refreshes retain their prior cadence.
- Routine scoped gift reads include observed inbox IDs, unposted/unopened records, the active opening attempt, all isolated attempts and all unresolved reviews. Historical posted payloads outside the observed inbox are omitted from responses; no evidence is deleted. Unknown or malformed state stops processing. Registration returns a validated transactional state, avoiding a redundant read; an empty isolated-intake cycle goes from three gift-state reads to two. Reconciliation across opening, recovery, isolation and final safety checks remains in place.

The gift query still examines durable state to identify unposted records. Unresolved holds deliberately have no arbitrary truncation; a large unresolved backlog still requires operational review. This is payload/read reduction, not a promise of constant database cost. No financial lock, asset barrier, receipt rule or settlement definition is weakened.

## Capture an actual measurement interval

`pg_stat_statements` is cumulative. A single export cannot recover the last 24 hours unless a suitable baseline already exists. Do not reset shared counters to manufacture one.

1. Run all of `scripts/query-stats-snapshot.sql` in the Supabase SQL Editor. Export the complete one-row `snapshot` result as CSV or JSON and keep it as `baseline.csv`. The script expects Supabase's statistics extension in `extensions`.
2. Approximately 24 hours later, run the same script and export `current.csv`. Retain both original files. Do not export a top-50 table or truncate the JSON cell.
3. From the project root, compare the files (adjust the paths):

```sh
python3 scripts/queryStatsDelta.py /path/to/baseline.csv /path/to/current.csv --output /tmp/query-stats-delta.csv
```

The command also accepts raw snapshot JSON. It reports the actual elapsed hours and exclusions on stderr, with every current entry in the output CSV. Rank matched entries by total execution seconds for aggregate pressure and average execution milliseconds for latency; consider call volume and buffer/temp activity alongside them.

The snapshot includes every currently retained statement for this database, using query ID, execution role and top-level/nested identity. It exports no SQL text, query arguments, credentials or gift payloads. RPC names and categories are heuristic: administration and instrumentation are separated from application calls, and request setup has its own category. Review `other` entries before assuming they are application overhead. Role IDs describe the database execution role, not a unique website viewer. Administrator-triggered application RPCs cannot always be distinguished from normal requests by normalized statistics alone.

Global resets reject the comparison. New/unbaselined entries, changed identities, per-entry resets, decreasing counters and unverifiable eviction intervals get explicit statuses and no invented deltas. Removed entries are counted in the summary. Older PostgreSQL versions without per-entry collection timestamps cannot reliably establish a delta after statement eviction, so the tool excludes those matches conservatively. A complete export avoids top-N selection loss; it cannot restore entries already evicted by PostgreSQL.

Execution time is elapsed database statement time, not CPU time. With nested tracking, parent/child times can overlap: do not sum nested and top-level rows as independent database load. This workflow intentionally does not subtract cumulative maxima or percentiles to invent interval p95/max values. Capture application histograms/logs separately for tail latency.

## Representative query plans

For deeper profiling, use a controlled database with read-only transactions,
equivalent authenticated viewer context and short statement/lock timeouts. The
former standalone plan-profiling script has been removed. Choose active Sell,
active Buy with reservations, closed listings, ordinary viewers and owners for
meaningful coverage; small fixtures do not predict production performance.
For routine captures, use `scripts/query-stats-snapshot.sql` before/after the
interval and `scripts/traffic-pressure-snapshot.sql` during the slowdown.

`EXPLAIN` of a PL/pgSQL RPC call measures its envelope, not each internal query. To identify remaining row-loop/index costs, inspect the installed function and explain its constituent reads with equivalent authorization, or use a controlled nested-plan capture with appropriate database privileges. Do not enable broad production parameter/payload logging. Add indexes only after representative plans show a useful access path and assess their write/storage cost.

## Validation

Database regression tests cover public field parity, closed/Buy identity rules, private reservation isolation, role grants, unchanged financial definitions, gift unresolved/observed/unposted coverage, and complete snapshot/delta compatibility. Client tests cover cache scope changes, overlap, status/expiry invalidation and live-field precedence. Bot tests cover empty cycles, successful-open recovery after lost acknowledgements, and malformed state/registration responses failing before package opening or review classification.
