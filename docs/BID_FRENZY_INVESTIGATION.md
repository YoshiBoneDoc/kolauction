# Bid-frenzy investigation

Reviewed November 9, 2026 against local source and retained November 9 exports.
No production connection, deployment, financial change or connected bot run.

## Findings

Bid bursts are a credible trigger, but the available evidence does not establish
that a slow bot holds a lock needed by all website readers. Intake takes the
transaction-scoped financial advisory lock 3888760; ordinary public listing/live
reads do not acquire that lock. PostgreSQL snapshot reads ordinarily do not wait
for an auction row's UPDATE lock either. Resource contention, heavyweight locks,
connection/pool saturation and application/cache overload remain different possible
failure mechanisms. A serial worker awaiting a request does not itself serialize
unrelated browser database requests. Each intake RPC is a separate transaction;
the financial advisory lock is not held across KoL network sends or the whole cycle.

The worker does have application-level head-of-line delays:

- A complete inbox scan and gift preparation precede intake. At 100 API messages,
  the complete-inbox reader enumerates HTML pages and fetches missing old mail.
  A changing/incomplete inbox safely aborts processing rather than guessing order.
- Recognized messages are ingested serially, in receipt-time/message-ID order.
  A confirmed database cancellation permits one bounded same-receipt retry;
  uncertain responses leave the cycle for normal recovery.
- After intake, settlement/maintenance, outgoing delivery work, closet work and
  cleanup occur before the next inbox scan. Delivery and cleanup budgets are
  checked between operations, not hard cancellation deadlines. Both have paced
  one-second pauses; KoL calls and database calls add further time.
- The runtime then sleeps: default poll setting is 15 seconds; yielded work caps
  that sleep at 5 seconds. These are defaults, not verified production settings.
- Cleanup requires ledger approval and is budgeted. Retained mail can outgrow
  cleanup throughput, increasing later scan/replay cost even when intake is fast.

Replay amplification is directly reproducible in existing mocked worker tests.
If bot_handled_mail fails its five-second optional read, the worker uses durable
per-message intake for the supplied recognized mail and suppresses the optional
lookup for 60 seconds. The fixture makes 26 intake calls across two cycles for
13 retained messages. These are deduplicated attempts, not 26 accepted payments.
This is safe financially but can amplify work during database degradation.

## What the saved statistics establish

Recomputed from matched, top-level application rows in
scripts/11-9-2026 snapshots/analysis/interval-*.csv:

| Interval | Application elapsed s | bot_* elapsed s | Other application elapsed s | Intake calls / elapsed s |
| --- | ---: | ---: | ---: | ---: |
| 1 | 84.119 | 17.014 | 67.105 | 7 / 1.886 |
| 2 | 177.016 | 43.409 | 133.607 | 411 / 8.902 |
| 3 | 149.876 | 64.822 | 85.054 | 414 / 14.323 |
| 4 | 56.059 | 18.661 | 37.398 | 2 / 0.479 |
| 5 | 58.690 | 21.379 | 37.311 | 17 / 4.533 |

These are statement elapsed times, not CPU shares or complete service demand.
Intervals differ in duration; do not compare their totals as equal traffic windows.
Canceled/unfinished work and evicted entries may be absent. RPC names do not prove
caller provenance. Nonetheless, the busy second interval does not show committed
intake dominating observed application execution: intake averages about 21.7ms,
while substantial unrelated read cost coexists. The overlapping pressure capture
reported no blockers/financial-lock entries; that weakens the lock explanation at
that instant, without ruling out earlier/transient contention. Worker replay logs
are required to attribute the 411 calls to new bids versus retained-message replay.

## Deadline interpretation

Ordinary Sell extensions commit with accepted bids and set end_time to the original
receipt time plus 60 seconds. Delayed processing can therefore persist an extension
whose deadline has already passed. This protects original receipt ordering but does
not guarantee players 60 seconds after seeing the updated page. Rejected/duplicate
bids do not extend; rejection alone does not prove another bid was accepted.
Giveaways explicitly bypass extensions. Cached/failed reads can also delay display
of a committed new deadline. No particular reported auction has been diagnosed.

## Recommended course

1. Measure the pipeline during a representative concurrent-bid burst before
   changing financial concurrency. Correlate existing BOT_PERFORMANCE detail,
   DATABASE WAIT/replay messages, cycle/dispatch/cleanup times and retained inbox
   counts with receipt-to-commit delay, new/replayed intake counts and pending-mail
   age. Existing telemetry measures phases/RPCs but does not fully establish these
   queue delays. Keep any added instrumentation aggregate-only and bounded.
2. Use complete query-statistics snapshots immediately before/after the burst,
   pressure captures DURING stalls, and matching database CPU/memory/I/O/pool and
   cache Worker queue/error graphs. Distinguish lock waits from running-but-slow
   statements and browser catalogue-only responses from an actual process crash.
3. First bot optimization candidate: bound replay amplification. Evaluate bounded
   replay lookup batches and reuse of only exactly matched, confirmed terminal
   receipts. Any memory reuse must be bounded and respect recovery/state changes;
   it must never authorize deletion, skip unresolved staged mail or substitute for
   payload checks. Do not add a naive permanent handled-ID cache.
4. Next evaluate reducing time between intake scans by yielding optional work
   during backlog. Keep one financial executor, complete scan/settlement barriers,
   fresh solvency, recovery and dispatch fairness. Faster blind polling adds load;
   large atomic intake batches can lengthen locks and rollback scope. Neither is
   justified as the default fix. Measure bounded alternatives offline first.
5. In parallel profile installed Home/full/static/browse inner reads under mixed
   read/write fixtures. Existing evidence identifies repeated visibility/quote work;
   reducing that cost may create bid headroom without touching financial rules.
   Compare complete JSON/privacy/accounting output, not just fixture speed.

Keep financial locks, exact reserves, receipt ordering and uncertain-send barriers.
Do not add a second connected worker, parallelize transfers, raise timeouts or
change receipt-time extension policy as an incident workaround. A policy change
would need separate owner review because it changes fairness and closing semantics.

## Validation

- Existing isolated PostgreSQL anti-sniping suite passed, covering concurrent
  Direct bids, delayed Escrow chains, duplicate/rejected bids and settlement.
  It required local shared-memory access outside the sandbox; no live service used.
- 27 existing mocked Node tests passed for replay fallback, intake timeout retry
  and receipt-time scan barriers under local Node 22.12. Production requires Node
  24; this run is not Node 24 certification or a capacity/load test.
- No runtime code or SQL changed. Production root cause remains unverified.
