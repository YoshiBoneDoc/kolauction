# November 7 traffic and creation slowdown

Owner reported a slowdown while creating a Sell auction accepting Mr. A payments.
No live database, bot, deployment or transfer was accessed.

## Evidence and limits

`Supabase Snippet Untitled query (6).csv` contains eight function-definition hashes,
not a statistics baseline. `(7).csv` is a complete snapshot captured at
2026-11-07 23:21:17.750110 UTC; counters began October 29. Do not treat cumulative
rankings as the current outage or infer installed SQL from filenames/hashes alone.

Compared (7) against the saved November 6 17:08:36.784010 UTC export with
`scripts/queryStatsDelta.py`: 30.211379 hours, zero removed entries/deallocations,
73 unbaselined/reset identities. Those identities have no inferred deltas.
Selected matched top-level identities (not combined across overloads/users):

| RPC | Calls | Execution seconds | Average ms |
| --- | ---: | ---: | ---: |
| read_auction_page | 1,332 | 880.417 | 660.974 |
| read_my_account_access | 12,626 | 483.147 | 38.266 |
| read_home_cards | 709 | 316.072 | 445.800 |
| bot_handled_mail | 4,651 | 299.708 | 64.439 |
| bot_gift_intake_state_scoped | 9,322 | 286.668 | 30.752 |
| bot_finish_inbox_scan | 4,653 | 280.201 | 60.219 |
| read_auction_detail_static | 749 | 253.090 | 337.904 |

These do not establish present concurrency, CPU saturation, lock waits, client
builds or exact internal plans. Never sum nested statements into their callers.

## Confirmed change

Queued additive **242**, after 241, changes only Home's `active` CTE. Its correlated
lookup rescanned a materialized distinct-seller pool for each auction. A left join
uses that pool once and retains `not r.restricted` semantics (including NULLs),
visibility, ranking, counts and projection. No TTL, polling, retry UI or financial
behavior changes. Identical standalone bot SQL copy included.

Disposable PostgreSQL fixture: 1,000 distinct sellers, seller-pool scans
**1,000 → 1**, total Home inner plan **970.134 → 933.021 ms** on this run.
The modest total reduction means other Home work remains significant. This is
not a claim that the live outage is fixed. Existing suite verifies parity across
anonymous/owner/buyer/restricted/admin viewers and unchanged financial definitions.
The older projection test now excludes physical payment fields, which lightweight
cards intentionally omit; acceptance metadata remains in the comparison.

## Creation-specific investigation and next capture

`create_mr_a_auction` and its Direct helper acquire advisory lock **3888760** and
reuse the established creators. Market validation is one primary-key price read;
terms are updated in the same transaction. Creation can wait behind bot financial
work, but the supplied counters cannot prove it did. Do not remove the lock, retry
uncertain creation, or change transfer concurrency to hide that wait.

Run `scripts/traffic-pressure-snapshot.sql` DURING a slowdown. It is read-only and
reports grouped sessions/waits, blocker PIDs/ages and holders/waiters for the
financial lock without exporting query text or parameters. It also reports DB
counters/settings, not CPU metrics; obtain CPU/connection graphs separately.
Capture `scripts/query-stats-snapshot.sql` twice several minutes apart over the
same traffic episode. It now also exports optional JIT counters without resetting
anything; older exports/delta tooling remain compatible. Verify deployed website
and cache Worker build IDs before attributing legacy RPC traffic to current code.

## Validation and rollout

- Public listing PostgreSQL regression suite passed, including new Home plan,
  viewer/privacy parity and financial-definition checks.
- New pressure diagnostic executed successfully in a separate disposable cluster.
- Four query-stats delta unit tests passed.
- Only local synthetic databases were used. No production SQL applied.

Apply 242 once after verifying 241 and installed function definitions. The patch
fails closed on unexpected source. No website, cache Worker or bot binary change
is needed for this SQL optimization; allow existing shared snapshots to refresh.
Current lock contention, production resource saturation and remaining static/detail,
account and bot replay costs remain unresolved pending the incident capture.

## Additional captures and timeout logs

Exports (9) → (11), UTC **23:26:30.922582 → 23:27:27.028550**, provide
**56.105968 seconds**, zero removed entries/deallocations and one new instrumentation
identity (excluded from deltas). Export (8) repeats the eight function hashes.
Matched application deltas include:

| RPC / statistic identity | Calls | Total seconds | Mean ms |
| --- | ---: | ---: | ---: |
| read_auction_page / -5372426022816326384 | 2 | 7.262 | 3,630.895 |
| read_public_auction_page / 1696099813536978682 | 1 | 2.128 | 2,128.042 |
| bot_ingest_mail | 391 | 3.609 | 9.229 |
| read_my_account_access | 8 | 1.883 | 235.322 |

`create_mr_a_auction` has no call delta in this window. Successful statement counters
do not represent the full work of statements canceled by timeout. Ingestion counts
do not distinguish new mail, durable replays or retries; do not skip receipt checks
or add an in-memory accepted-payment cache based on those counts.

Capture (10), UTC 23:27:15.247848, shows no blocked sessions, financial lock holder
or active client queries; 11 clients wait on ClientRead. JIT is off, configured
max_connections is 60 and database numbackends is 15. This instant does not support
connection exhaustion or ongoing financial-lock blockage, but cannot exclude an
earlier transient episode. Historical temp_bytes/deadlocks/session counters have
an October 2 reset, not the short-window boundary; no current spill conclusion.

Owner's logs establish statement timeouts at UTC 23:26:14.632 and 23:26:12.016:
- Six-argument `read_auction_page` in `buy_history`, through the full public_auction
  wrapper chain. Current Profile and some Seller reads can still use this signature;
  it is not proof of an outdated browser. Arguments/auction kind are not in the log.
- Ten supplied arguments dispatch to `read_public_auction_page`'s 12-argument
  signature and time out in `public_listing_page`. This is a separate path; fixing
  Buy history alone cannot establish resolution of this public browse failure.

Queued additive **243**, after 242, materializes viewer ID/name permission/admin
permission once inside `buy_history`. Previously permissions repeated for every
fulfillment (including two username checks and repeated administrator checks).
No cross-request permission caching, limit, ordering, history fields, delivery
checks, authorization or financial function changes. The installed-source patch
fails closed on unexpected layout. Matching ignored bot SQL copy included.

Local fixture validates exact before/after JSON equality across guest, host,
fulfillment seller, restricted and administrator viewers on 120 fulfillments,
including the 100-row cap. The full public listing regression suite passes with
financial definitions unchanged. Production impact is not yet measured. No new
polling, retries, read TTLs or uncertain write retries were introduced.

Measured 100-row Buy-history fixture (host, three local executions): original
**27.833 / 27.052 / 27.213 ms**, optimized **3.096 / 3.215 / 3.173 ms**—about
**88% less time** in this fixture. This verifies avoided repeated authorization
work, not production latency or resolution of the independent browse timeout.
