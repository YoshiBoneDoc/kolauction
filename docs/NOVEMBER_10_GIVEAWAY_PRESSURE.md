# November 10 live giveaway pressure review

Initial read-only analysis of five exports in `scripts/11-10-26 snapshots/`
and six owner-supplied statement-timeout events. No production connection,
SQL application, deployment, bot restart, tests or application changes performed.
This report can be extended with later captures; it does not establish peak capacity.

## Capture validity and timeline

| Export | Type | UTC |
| --- | --- | --- |
| query 1 | Complete statement statistics | 17:14:18.350596 |
| query 2 | Pressure | 17:24:45.800873 |
| query 3 | Complete statement statistics | 17:24:57.382484 |
| query 4 | Pressure | 17:29:11.360573 |
| query 5 | Complete statement statistics | 17:29:33.851846 |

Statistics pairs cover 639.031888s and 276.469362s. Same database ID/name,
same statement-statistics reset, no deallocations, removed entries or unbaselined/
reset identities. Existing `scripts/queryStatsDelta.py` produced
`scripts/11-10-26 snapshots/analysis/interval-{1,2}.csv` and summary JSON.
RPCs below aggregate matched **top-level** entries across signatures/roles.
Do not add nested timings to parents or interpret execution totals as CPU usage.

## Initial result

The evidence favors a transient shared execution/resource slowdown alongside
persistent expensive readers. Financial-lock contention, connection exhaustion,
JIT, duplicate payments and bid volume as the sole cause are **not established**.
CPU scheduling/credits and resource pressure are hypotheses, not measured causes.

The first pressure sample is 51 seconds after the last supplied timeout, so it
does not capture the exact canceled statements. It nevertheless shows ongoing
multi-second active work. The second sample is idle; that is not proof of future
stability during the final-minute bid burst.

## Measured intervals

Successful execution counts / mean execution ms; canceled and in-flight work are
not a complete part of these totals. PostgreSQL updates execution statistics only
after successful execution: [PostgreSQL 17 documentation](https://www.postgresql.org/docs/17/pgstatstatements.html).
Thus the low successful public-browse mean does not contradict its timeout logs.

| RPC | 17:14:18–17:24:57 calls / mean ms | 17:24:57–17:29:33 calls / mean ms |
| --- | --- | --- |
| Card context | 16 / 1051.4 | 7 / 75.6 |
| Account access | 71 / 234.0 | 52 / 71.4 |
| Static detail | 30 / 489.6 | 12 / 679.5 |
| Bid history, combined signatures | 99 / 146.9 | 49 / 116.0 |
| Home poll feed | 25 / 504.7 | 24 / 127.6 |
| Public live detail | 150 / 49.6 | 72 / 46.4 |
| Home cards | 8 / 776.0 | 8 / 495.4 |
| Public browse | 11 / 307.0 | 6 / 270.5 |
| Site activity write | 23 / 137.3 | 14 / 91.6 |
| Bot intake | 15 / 787.5 | 14 / 189.8 |
| Bot replay classification | 28 / 65.1 | 16 / 19.8 |
| Bot scan completion | 28 / 236.8 | 16 / 68.6 |
| Bot delivery acknowledgment | 24 / 261.5 | 20 / 100.0 |
| Bot cleanup approval | 27 / 286.8 | 15 / 94.3 |

The shorter second interval has higher rates for account reads (6.67→11.29/min),
poll feed (2.35→5.21/min), intake (1.41→3.04/min), delivery acknowledgments
(2.25→4.34/min) and scans (2.63→3.47/min), while their means improve. Raw
request rate alone therefore does not explain the earlier degradation. This does
not rule out a short burst hidden by interval averaging or differing request inputs.
Static detail remains a persistent profiling target; its second-interval mean
worsens despite slightly lower request rate (2.82→2.60/min).

Application top-level execution totals: 211.704s then 62.476s. Administration:
32.980s then 1.250s; instrumentation: 3.281s then 9.910s. All matched application
entries have zero temp blocks written. Matched top-level temp writes are attributed
to administration/instrumentation (2974 then 1626 blocks). Exported SQL is hashed,
so the exact administration operations and their causality are unknown. Keep live
diagnostics lightweight; these totals cannot identify a saturating query or CPU load.

## Pressure samples

- **17:24:45:** six active client backends, all without reported wait events or
  blockers; oldest active query 7.306s. No blocked sessions or financial advisory
  lock holder/waiter. 21 total backends against `max_connections=60` does not show
  PostgreSQL connection exhaustion; an upstream API-pool queue remains unmeasured.
- Every captured active RPC label is null, so this export cannot identify the
  active functions. PID 573818 also appears in an earlier browse timeout, but a
  pooled backend can execute different statements; this is not proof the later
  statement was the same RPC.
- **17:29:11:** no other active operations, no blockers or financial lock; 17 backends.
- JIT off in both. `blks_read` remains 9597 between these samples, with no measured
  surge in database buffer-miss reads during that interval. This does not exclude
  write/storage pressure or earlier reads. I/O timing is off.
- Database temp bytes increase 22,357,086 between samples; database counters and
  statement intervals differ, so do not directly equate their deltas.
- Exported role timeouts: anon 3s, authenticated/authenticator 8s; authenticator
  lock timeout 8s. Capture-session default 120s is not the effective deadline for
  every application role; per-function overrides are not exported here.

No reported PostgreSQL wait means no instrumented wait at that instant, **not**
proof of CPU saturation. See [activity semantics](https://www.postgresql.org/docs/17/monitoring-stats.html).

## Supplied failures: what they establish

| UTC | RPC | Cancellation context |
| --- | --- | --- |
| 17:23:02.298 | Public browse | `is_abandoned_escrow_draft` within `public_listing_page` |
| 17:23:21.314 | Static detail | SQL function startup |
| 17:23:21.757 | Site activity | `site_activity` INSERT/ON CONFLICT update |
| 17:23:45.279 | Public browse | `public_listing_page` |
| 17:23:54.142 | Home cards | `bid_increment` via minimum bid / deal score / Home |
| 17:23:54.775 | Static detail | No inner context supplied |

All six are 57014 statement cancellations. They span public/private reads and a
presence write, not just financial intake. A cancellation frame is where the
budget expired, not proof that helper consumed the budget. Session start is
connection age, not query start; static detail did not necessarily run 12 minutes.
The dashboard image shows log error counts/percentage, not compute utilization.

Local [presence implementation](../supabase/migrations/202611090249_site_visit_analytics.sql:20)
uses an identity-specific advisory lock and an upsert; it does not use the global
financial lock. Row/identity contention is possible, but no incident-time blocker
was captured. The logged `actor,observed` text matches this newer path; it does not
verify all installed function definitions or releases.

Public browse retains [abandoned-draft filtering](../supabase/migrations/202610230092_hide_abandoned_escrow_drafts.sql:6).
Earlier migration 236 removed a redundant Home completed-results call only, not
this browse visibility rule. Do not infer 236 is absent from this error or remove
the visibility predicate to fix timeouts. Home scoring and full/static reader work
remain profiling targets, not proven causes of every failed request.

## Next evidence for the live event

1. CPU usage and credits if available, memory, disk I/O/latency and connection/API
   pool graphs covering 17:15–17:35 UTC, then the final-minute window. These are
   needed before declaring resource exhaustion or recommending compute changes.
2. Short complete statistics pairs around a slowdown and a recovery; separate
   pressure capture during the actual stall. Preserve timestamps and counters.
3. Bot logs/performance for the same UTC window: cycle/intake/dispatch durations,
   database waits, oldest delivery age, scan completion and receipt-to-intake age.
   Successful RPC counts do not prove fresh bids are current or queues are drained.
4. Identify active null-labeled operations using a bounded, allowlisted diagnostic
   if repeated samples remain unlabeled; do not export raw private queries/payloads.
5. Once resource evidence and deployed definitions are known, profile static
   detail, card-context visibility and Home/browse scoring with representative
   inputs off-production. No financial-write EXPLAIN ANALYZE during the giveaway.

No evidence currently warrants changing bid increments, receipt-time/grace rules,
financial locks, sender concurrency or timeout/retry policies during the event.

## Follow-up: owner resource screenshots at 12:36 Eastern / 17:36 UTC

These 24-hour charts materially strengthen memory pressure as the leading resource
hypothesis. Selected tooltip is 12:36:15 Eastern, about 12–13 minutes after the
17:23 timeout cluster; wide aggregation does not pinpoint incident-time behavior.

- Memory: total RAM 406.45 MB; used 268.79 MB (66.13%), cache/buffers 117.97 MB
  (29.02%), combined 386.76 MB (95.2%). Cache is potentially reclaimable, so the
  combined percentage alone does not establish exhaustion.
- Swap occupied: 570.35 MB. The displayed 140.32% compares swap to physical RAM;
  it is not percent of swap capacity. Occupancy alone does not prove current
  swap-in/out activity or thrashing.
- Memory commitment: 1.66 GB versus displayed 1.4 GB commit capacity, marked
  SEVERE. This is promised virtual memory, not 1.66 GB resident usage and not proof
  an OOM event happened. It is a significant headroom/risk signal.
- CPU tooltip: user 1.64%, system 1.98%, I/O wait 11.14%, idle 84.47%; displayed
  total 14.77%. These rounded/displayed figures do not exactly reconcile. There is
  no sustained CPU execution saturation visible; I/O wait makes storage/page wait
  worth investigating, without proving that swap caused these particular errors.
- Connections 16/60, disk occupied 351.66 MB (17.8%), current IOPS 5 and throughput
  about 353.8 KB/s. No demonstrated connection cap, disk-full or bandwidth/IOPS
  ceiling. Overview disk I/O balance is 71%, not depleted. These do not exclude
  short latency spikes or memory paging outside PostgreSQL block-read accounting.

Updated causal ranking: memory headroom/possible paging is the strongest resource
lead; persistent query costs can amplify concurrent memory demand. CPU saturation
and global financial-lock contention remain unsupported by these captures. OOM,
active thrashing, a leak and the responsible process/query are not established.
This is consistent with a broad slowdown across unrelated RPCs while SQL captures
show no blockers; OS memory behavior is not fully represented by database waits.

Next capture: narrow the resource charts to 12:15–12:40 Eastern (17:15–17:40 UTC)
with tooltips around 12:23, and obtain swap-in/out, major page faults or memory
pressure metrics if exposed. Confirm compute tier before choosing a larger size.
A RAM increase is now evidence-supported mitigation to evaluate, not a guaranteed
query fix. Supabase says compute changes incur downtime (usually under two minutes,
possibly longer), so do not treat a resize as transparent during the final minute.
No resize, restart or other production action was performed.

Metric semantics: [Supabase reports](https://supabase.com/docs/guides/observability/reports),
[memory/swap](https://supabase.com/kb/troubleshooting/memory-and-swap-usage-explained-aPNgm0),
[compute sizes and resize downtime](https://supabase.com/docs/guides/platform/compute-and-disk).

## Final-event capture: confirmed paging and successful bot progress

This section supersedes the earlier resource hypothesis with direct counter
measurements. It does not retroactively establish the cause of every 17:23 error.
Analysis used all 16 owner SQL exports, both successful local captures and the
Oracle `giveaway-bot.log`. No new production request, test, deployment or
application modification was made. Local derived artifacts are in
`scripts/11-10-26 snapshots/analysis/`; `analyze-capture.py` reproduces host rates,
pressure summary and the capture-start/owner-end query deltas offline.

### Coverage and validity

- Main pressure capture: **18:08:07.918–18:14:48.192 UTC**, 81 valid samples,
  approximately every five seconds. Seven host samples cover 18:08:06.697–18:14:12.848.
- Bot log: **18:08:15–18:13:04 UTC**; includes final bids, returns, winner-item
  delivery, payout and commission. No BOT_PERFORMANCE phase telemetry is present.
- Collector final `after.json` is explicitly unavailable, so it is not treated as
  a valid ending snapshot. The owner's separate 18:16:05.830 export supplies a
  valid later boundary against the collector's 18:08:06.697 baseline: **479.133118s**.
  No reset, eviction/deallocation, removed or unbaselined identities in that pair.
- All seven adjacent owner-statistics intervals were reduced separately. The
  17:59:59–18:03:45 pair has 21 new/unbaselined entries; the next has four. Their
  new identities are excluded from measured deltas, not assigned historical calls.
- Newly supplied CSVs contain statistics/pressure snapshots, not a later error-log
  export. The six exact failure events remain the earlier 17:23 cluster. The main
  capture has no database rollback/deadlock increment and the bot log has no
  database-wait/error/restart message. Do not invent an additional final-minute
  timeout count from slow successful calls or from the unavailable final snapshot.

### Confirmed shared bottleneck: active paging, increasing I/O stalls

Each rate below is computed from adjacent cumulative host counters. CPU percentages
sum deltas across the two CPU series, normalized by total CPU-time delta. PSI full
stall percentage is stalled-seconds delta divided by wall time; it is not CPU use.
Swap units are pages, without assuming a particular host page size.

| Host interval UTC | Swap-in pages/s | Swap-out pages/s | Major faults/s | CPU I/O wait | Full I/O stall | Full memory stall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 18:08:06–18:09:07 | 404 | 326 | 542 | 6.9% | 7.3% | 1.9% |
| 18:09:07–18:10:08 | 441 | 302 | 599 | 7.3% | 7.9% | 2.0% |
| 18:10:08–18:11:09 | 712 | 563 | 705 | 9.6% | 10.0% | 2.9% |
| 18:11:09–18:12:10 | 777 | 622 | 1117 | 16.5% | 17.2% | 6.1% |
| 18:12:10–18:13:11 | 881 | 964 | 1076 | 18.7% | 19.3% | 6.3% |
| 18:13:11–18:14:12 | **1524** | **1237** | **1963** | **44.0%** | **44.6%** | **16.3%** |

Physical RAM is 406.45 MiB. MemAvailable ranges about 82–117 MiB across seven
samples; this does not negate reclaim/page pressure or imply all available memory
can satisfy every working set without disk access. Swap occupied is about 512–588
MiB. Committed_AS is about 1602–1801 MiB versus exported CommitLimit **1227 MiB**.
These raw exporter values supersede approximate dashboard labels/units for this
window; virtual commitment is not resident memory and does not prove an OOM kill.

This establishes **ongoing memory paging and material host I/O/memory stalls**,
not merely a high historical swap gauge. At the worst interval, user+system CPU is
about 12.3%, with 43.5% idle; CPU execution saturation is not demonstrated. Host
pressure affects all processes, not just Postgres; exact per-process ownership of
swapped pages is not available. Supabase describes sustained swapping as a source
of degraded database performance in its [reports guide](https://supabase.com/docs/guides/observability/reports).

The worst host interval is **after the winner delivery/payout**, so pressure is not
exclusive to last-second bid intake. It overlaps the broad post-settlement read
slowdown below. This is a high-confidence explanation for that slowdown and a
measured capacity problem; attributing every earlier cancellation to it remains an
inference because those failures precede host-counter recording.

### What the database sampler rules out for the captured instants

- Zero blocked samples and zero financial-lock waiter samples. Only two samples
  catch granted financial locks: intake at 18:09:22, query age ~30ms, and scan
  completion at 18:12:18, age ~307ms. These ages are query ages, not lock durations.
- Other database sessions range 13–16. No connection-cap evidence.
- Between first/last pressure samples: five PostgreSQL blocks read, no deadlocks,
  no rollback increment. OS swapping and filesystem page faults are not counted as
  normal PostgreSQL buffer-miss reads, explaining why low `blks_read` does not
  eliminate host I/O trouble.
- At 18:13:08, public browse is active at 1.457s, discovery at 0.853s, card context
  at 0.611s. Then bid history reaches 1.393s, static detail 2.002s, cleanup 1.312s
  on separate samples. At 18:13:43, account/poll/featured/activity/trade-summary
  readers are simultaneously active around 0.72–0.76s. None has a reported blocker
  or wait event at the sampled instant. Host PSI fills the OS-pressure gap.
- Five-second samples cannot exclude shorter contention, but the observed broad
  delays do not require a financial-lock explanation.

### Remaining query costs and priorities

Owner interval **18:10:32–18:16:05** includes the final bidding/settlement and
post-settlement tail. Means are successful **top-level** execution times, aggregated
across signatures/roles; timeouts and in-flight work are not fully represented.

| RPC | Calls | Mean ms | Total seconds |
| --- | ---: | ---: | ---: |
| Static detail | 34 | 291.2 | 9.900 |
| Bid history | 86 | 98.9 | 8.508 |
| Public browse | 7 | 676.3 | 4.734 |
| Bot cleanup approval | 19 | 221.3 | 4.204 |
| Home cards | 5 | 705.6 | 3.528 |
| Home poll feed | 10 | 318.5 | 3.185 |
| Account access | 63 | 47.7 | 3.007 |
| Bot intake | 12 | 203.2 | 2.438 |
| Public live detail | 59 | 8.3 | 0.492 |

Immediately preceding 18:03:45–18:10:32, static detail averages 196.5ms, bid history
42.4ms, account 17.2ms, poll feed 39.4ms and public live detail 2.1ms. Different
inputs and interval sizes preclude a controlled comparison, but the broad later
increase aligns with measured host pressure. Static detail also costs 740–870ms
in some earlier owner intervals, making it a recurring profiling target.

Priority order:

1. **Host memory capacity / paging — high severity, confirmed.** More memory is
   evidence-supported mitigation now, rather than a speculative response to SQL
   counters. Verify compute tier; the observed RAM is consistent with a very small
   instance. Micro has 1GB and Small 2GB per current
   [compute documentation](https://supabase.com/docs/guides/platform/compute-and-disk).
   Small offers more burst headroom if affordable; these measurements cannot
   promise a particular tier eliminates every query timeout. Resize outside a
   live auction because it incurs downtime. No resize has been performed.
2. **Static detail — medium/high, measured recurring cost.** Largest aggregate
   read cost in the event-tail interval. Inspect installed
   [detail derivation](../supabase/migrations/202611030177_detail_history_pages.sql:35)
   and later wrappers/activity work with representative plans; elapsed counters
   alone cannot distinguish intrinsic SQL cost from paging delay.
3. **Home/public browse — medium/high, measured latency and prior timeout paths.**
   About 706/676ms means at low call counts, compared with 8ms public live detail.
   Existing candidate visibility, abandoned-draft checks and scoring-before-page
   work remain concrete profiling targets. Preserve visibility/privacy and minimum
   bid rules. Do not identify `bid_increment` as the culprit solely from a canceled
   Home stack frame or remove browse filtering.
4. **Cleanup — medium, bounded but visible.** A sample catches 1.31s; interval
   mean 221ms. The worker still needs approvals before deletion. Profile existing
   receipt/delivery checks after addressing resource pressure; do not loosen them.

About 22.4MB database temp bytes accrue during the pressure window. In the later
valid statement pair, matched top-level temp writes come from administration/
statistics instrumentation, not application RPC entries. One sampled admin query
runs ~1.1s alongside reads; it cannot be identified from raw-query-free exports.
Monitoring/manual SQL is not zero-cost. This does not prove it caused paging:
substantial swap activity was present before the manual final-minute snapshots,
and no per-process memory ownership was recorded.

### Bot outcome and assessment of today's changes

The supplied bot log has seven distinct accepted bid receipt IDs and eight distinct
rejected receipt IDs. This is the log window only, not all auction participation.
Same receipt summaries repeated later with refund confirmation are updates, not
proof of duplicate intake/payment. Rejection reasons include too-low/nonexact-next
bids, self-outbidding and closed bidding; these are rule outcomes, not DB failures.

- Winner-item delivery confirmed at **18:12:24.182 UTC**.
- Seller payout confirmed at **18:12:25.955 UTC**.
- Remaining closed-bid refunds shown by **18:12:44.596 UTC**.
- Commission closet transfer verified at **18:13:04.244 UTC**.
- No database-wait, unknown-send, restart or crash messages appear in this log.
- Capture-start to owner-end: 15 intake calls, 27 replay classifications, 27 scan
  starts, 24 delivery acknowledgment calls. This is not a replay-intake explosion.
  Compare the earlier November 9 report's 411 intake calls, but do not treat
  different traffic windows as a controlled benchmark.

The owner's smoother-run observation is supported by recorded forward progress
and settlement despite host pressure. Priority dispatch/cleanup budgets and replay
bounds are plausible contributors; however local source placement does not verify
an installed build, and this log has no scheduler/phase telemetry to quantify each
change. Do not infer per-bid receipt latency from cycle-flushed summary timestamps.
An exact before/after causal percentage or higher traffic count is not established.

**Conclusion:** the event demonstrates a working financial pipeline while the
remaining shared host bottleneck is active paging/I/O pressure. Expensive static,
Home and browse reads amplify exposure to that pressure. Address RAM headroom and
then profile those measured read paths; the evidence does not support increasing
financial concurrency, changing bid rules, raising timeouts as a fix or blaming
financial-lock contention for the recorded broad slowdown.
