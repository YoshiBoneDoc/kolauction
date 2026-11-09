# November 9 giveaway review

Read-only review of six CSV captures under `scripts/11-9-2026 snapshots/` plus
seven error events supplied in chat. No production connections, SQL, deployments,
worker starts, financial actions, migrations or runtime edits performed.

## Capture validity

Three complete statistics exports cover 13:27:10.224–13:34:13.857 UTC (423.633s)
and 13:34:13.857–13:41:21.069 UTC (427.211s). Same database and stats reset;
no deallocations or removed entries. Interval 2 has one new/unbaselined entry;
its historical counters are not assigned to this interval. Reproducible deltas:
`scripts/11-9-2026 snapshots/analysis/interval-1.csv` and `interval-2.csv`.
Only matched top-level entries are combined by RPC below. These are observed
statement execution counters, not end-to-end latency percentiles or a complete
accounting of cancellations/in-flight work. Nested timings must not be added to parents.

The definition-hash export contains eight signatures, but not Home/public browse,
projection helpers or bot replay/staging definitions. Hashes alone do not establish
that every recent optimization or browser/Worker/bot build is installed.

## Measured changes

| RPC | Interval 1 calls / total seconds / mean ms | Interval 2 calls / total seconds / mean ms |
| --- | --- | --- |
| Bid history (all matched signatures) | 54 / 9.170 / 169.8 | 32 / 26.294 / 821.7 |
| Account access | 67 / 11.493 / 171.5 | 55 / 20.898 / 380.0 |
| Home poll feed | 26 / 7.283 / 280.1 | 16 / 14.774 / 923.4 |
| Static detail (all matched signatures) | 17 / 10.311 / 606.5 | 14 / 14.072 / 1005.1 |
| Public browse | 5 / 1.827 / 365.4 | 12 / 8.252 / 687.7 |
| Home cards | 7 / 4.389 / 627.0 | 6 / 5.083 / 847.2 |
| Bot handled-mail | 15 / 1.212 / 80.8 | 13 / 8.146 / 626.6 |
| Bot ingest | 7 / 1.886 / 269.4 | 411 / 8.902 / 21.7 |
| Saved auctions | 41 / 2.977 / 72.6 | 30 / 6.214 / 207.1 |
| Public live detail | 90 / 1.927 / 21.4 | 68 / 5.558 / 81.7 |

Lower calls and higher mean execution across unrelated reads suggest a shared
resource/latency episode in addition to any per-function inefficiencies. They do
not establish CPU saturation, a traffic threshold, a bad index or a single root cause.
The Home count is low: these exports do not support a Home-origin request flood.
Bot ingest's sharp call increase is real but not proof of new payments or duplicates.

## Pressure and error correlation

13:34:29.831 pressure capture is idle: no blockers or financial lock. It is ~20–29s
after the first public read timeouts and cannot explain their active waits.

13:40:58.154 pressure capture overlaps the second timeout cluster:
- PID 438945 bot_handled_mail: active 6.004s, no reported wait or blockers;
  timeout logged 13:41:01.186.
- PID 438463 static detail: active 5.945s, no reported wait or blockers;
  timeout logged 13:41:00.908.
- Also bid history and poll reads, plus unknown active operations, with no reported
  blockers. Six active client backends have no reported wait; three other active
  backends report ClientRead. ClientRead is not database lock contention.
- No financial advisory-lock holder/waiter; no blocked sessions. This argues against
  financial-lock contention at that instant, not against every earlier transient lock.
- 18 total backends vs max_connections 60; connection exhaustion is not shown.
  This does not rule out a separate API pool queue.
- JIT off. Physical database block-read counter stays at 9510 across both pressure
  captures. No evidence here of JIT or a surge of PostgreSQL buffer-miss reads.
  OS scheduling, CPU credits, underlying disk writes or other resources remain unmeasured.
- Database temp bytes rose ~10.0 MB; the matched statement deltas attribute temp
  block writes to administration/instrumentation, not the observed application RPCs.
  Raw SQL was intentionally excluded, so the exact administration queries are unknown.
  Avoid adding heavyweight diagnostic work during peak traffic.

Role configuration: anon 3s, authenticated 8s, authenticator 8s statement timeout;
authenticator lock timeout 8s. The connection session_start_time in an error is
NOT the query start time. Do not interpret these logs as queries running 10–20 minutes.

Seven supplied errors:
1. 13:19:43 migration 249 ALTER auth.mfa_amr_claims: permission error 42501,
   unrelated to query complexity. That transaction cannot successfully install its
   changes. Corrected local 249 uses a no-op function instead; verify actual later
   success before concluding visit analytics is installed. Do not reapply successful SQL.
2. Home cards 13:34:01 and 13:40:45: 57014 timeouts, second in deal_score /
   minimum_auction_bid / bid_increment. Cancellation frame identifies where execution
   stopped, not which function consumed most time. Never change bid increments to fix reads.
3. Public browse 13:34:09: timeout at public_listing_page startup. Startup does
   not identify the expensive inner plan or the request filters.
4. Static detail 13:41:00: timeout in the legacy projection wrapper chain retained
   by Mr. A support. Not proof Mr. A accounting caused the outage.
5. Bot handled-mail 13:41:01: replay read timed out.
6. Bot scan staging 13:41:17: timed out while isolating raffle intake and checking
   a receipt. Single primary-key lookup frame does not prove a missing receipt index.

## Prioritized actions

1. Correlate exact 13:33–13:42 UTC (~08:33–08:42 EST) with CPU/CPU credits (if
   applicable), RAM, storage/I/O and API pool/connection metrics, plus cache Worker
   queue/error/origin latency. The overlapping pressure capture makes this the first
   incident-wide lead. If resources are confirmed exhausted, temporary capacity
   relief is reasonable while optimizing; no current evidence justifies blindly
   changing compute, work_mem, timeout or concurrency.
2. Profile private bid history, account access, polls and static detail first.
   Together these four consumed ~76.0s in interval 2, ahead of Home's ~5.1s in the
   measured completions. Check statement-local permission reuse, payload sizes,
   duplicated caller lifecycles and existing auth-scoped coalescing before adding
   caching. Do not remove fresh authorization, explicit action reconciliation or
   financial checks. Keep private data out of public caches.
3. Investigate replay failure amplification. Local inbox-replay.mjs aborts the
   optional batch check after 5s, returns an empty handled set and defers the next
   check for 60s. Worker then stages/ingests messages using durable SQL dedupe.
   The 411-ingest burst is consistent with that fallback, but requires worker phase
   logs/mail-count summaries to confirm. Optimize ID-first candidate filtering,
   expensive payload comparisons and safe bounded batches, preserving exact payload,
   receipt/gift proof, complete-scan and unknown-send barriers. Do not blindly skip
   retained mail, delete evidence, increase transfer concurrency or retry uncertain writes.
4. Home/public browse still need targeted installed plans: test representative
   pools, Hidden Gems scoring, rank/filter cost and per-card projection separately.
   Reuse quote/seller checks within a statement before adding another cache. Verify
   SQL 236/242/244 and separate cache Worker release via installed definitions and
   build evidence. Keep existing coalescing, cooldowns and live-price freshness.
   Log timeout contexts do not justify changing financial bid rules or adding a
   speculative index to receipts.
5. Review visit/presence maintenance as optional work: interval 2 has 18 heartbeat
   calls / 5.222s (~290ms mean), not a request flood. New history adds a second
   activity write and bounded cleanup; it should be measured and cleanup can be
   evaluated for migration into existing maintenance if meaningful. These captures
   do not identify which installed heartbeat body ran or prove it caused the incident.
6. Validate changes on representative disposable fixtures, including privacy and
   financial parity; then compare equivalent traffic intervals and failure counts.
   Improving an average alone does not establish timeout resolution or capacity.

Missing evidence: CPU/resource graphs, cache telemetry, bot phase/replay logs,
request filter shapes and installed Home/browse/helper definitions. Existing captures
already narrow the investigation; no blanket migration or timeout increase is justified.
