# November 6 diagnostic follow-up

## Verified evidence

Recomputed all three adjacent intervals and the full interval directly from the
four original exports using `scripts/queryStatsDelta.py`. UTC 17:08:36.784010 to
18:18:05.585661 is 12:08–1:18 Eastern, 1.158 hours. Every comparison has zero removed,
unbaselined/reset entries and deallocations. Original exports and existing analysis
files were preserved. RPC statistics cannot identify client build versions, call
parameters, unique visitors, browser rendering, or internal execution plans.

Full-window execution seconds (rounded): legacy detail context 30.467 / 279 calls;
static detail 23.489 / 83; history 25.010 / 272; public Home 16.041 / 36; public browse
14.378 / 60; account access 20.025 / 628; saved auctions 8.705 / 245; filtered browse
4.224 / 5. History/static totals combine multiple statistic identities, not only
the largest row. Do not add nested statement times to their callers.

Inbox completion 13.263, opening claims 12.428, replay classification 11.688 and
scoped gift state 11.457 sum to 48.836 seconds. Replay has 560,674 shared hits;
these are buffer accesses, not distinct pages or physical disk reads. This interval
does not establish earlier replay-timeout amplification.

## Implemented

- Public Home cache origin now selects the existing `read_home_cards` RPC from
  migration 231. Previously only direct website Home used it. This avoids the
  older detail-rich projection. Public fields, section membership, totals and
  authorization parity are covered by the disposable projection suite. The old
  public Home RPC remains compatible. Cache freshness, invalidation, serialization,
  bounded queues and overload behavior are untouched.
- Migration 232 adds authenticated `read_saved_auction_ids`. The bookmark indicator
  hook previously fetched full cards and discarded every field except ID. The new
  read retains the full list's 72-hour final-outcome exclusion and unavailable IDs,
  without card, visibility or preference projection work. The saved panel and
  explicit preference actions keep the full reader. Existing in-flight coalescing,
  memory bounds, lifetime and action overlay remain. Cache keys and rendered state
  now include the current authorization token, so same-user token changes cannot
  reuse an older authorization's ID state. Nothing private is persisted or shared.
- The global auction error consumer is isolated from the route shell. Context
  publication no longer subscribes the entire App/Routes tree merely to display
  the error banner. Actual route consumers still receive auction updates normally.
  No memoization, polling slowdown or route architecture rewrite was added.

## Investigated, unchanged, and unresolved

Current `src/lib/auctions.js` uses `read_auction_viewer_context`, not the legacy
context endpoint. Migration 177 intentionally retained the legacy RPC with history
for older clients. Older tabs/builds or deployment differences can explain its
calls; the snapshots cannot distinguish them. Verify deployed fingerprints and
build IDs before attributing calls to either explanation.

Migration 160 makes `visible_auctions` a SQL SECURITY INVOKER function, allowing
predicate pushdown; the legacy source name alone does **not** prove a whole-market
scan. A proposed direct-table replacement was discarded. New detail readers
already constrain IDs, history already uses bounded keyset pages and narrow
authorization (177/227), and labels use the maintained bidder-label table. The
local detail suite passes history scope, aliases/privacy, pagination/revisions,
admin evidence, counters and financial-definition checks. Remaining static/history
internal costs have not been isolated with representative production distributions.
No claim is made that these costs are solved by this release.

Public browse already uses cached discovery and page-limited public projections;
192 evaluates restrictions by distinct seller. Home selection/ranking and exact
browse counts still need representative constituent plans. Account state already
consolidates flags and invitations and coordinates timer refreshes across tabs;
mount/focus/token-change reads preserve prompt access checks. Aggregate calls do
not justify extending their freshness or suppressing explicit checks. No account
refresh behavior was changed.

Bot replay compares exact payloads and checks receipts, pending jobs/mail and
review/gift evidence. Retention and receipt/state indexes already exist (117),
scoped gift reads exist (231), and safety/claim calls cannot be removed based on
aggregate time. The disposable intake suite verifies existing indexed retention
and lookup access paths plus recovery/accounting/proof invariants. It does not
reproduce this capture's payload sizes or replay buffer volume. No bot runtime,
financial lock, send retry, safety check or concurrency changed.

Five filtered/private calls do not reveal their filters or authorization contexts.
Representative combinations, internal selection/count/ranking costs and production
plans remain unresolved. No speculative index was added. This follow-up does not
complete internal profiling of every expensive RPC.

## Local verification and measurements

Disposable PostgreSQL suites: `auction_detail_cache_database_test.py`,
`public_listing_projection_database_test.py`, `saved_auctions_database_test.py`,
`bot_intake_performance_database_test.py` all passed. Tests use temporary local
clusters and no real network transfer or bot worker. Local shared-memory access
required running those clusters outside the sandbox.

Saved full-reader five execution times: 6.595, 6.325, 5.787, 5.640, 5.120 ms;
IDs-only: 3.187, 3.360, 3.297, 3.632, 3.417 ms. The suite checks ownership,
anonymous rejection, final-outcome expiry and ordered ID/full-row equivalence.
Home fixture envelope: old 24.191 ms, cards 12.959 ms. These are small fixtures,
not production capacity or tail-latency claims.

Focused Node run: 101 passed (cache suites, saved service/hook, private refresh,
auth), including malformed ID responses and same-user token scope changes.
Changed-source ESLint: zero errors, existing UserContext Fast Refresh warning.
Cloudflare production build passed. Initial JS remains approximately 495.5 kB
(148.2 kB gzip); routes are already lazy, the catalogue fallback and proof verifier
are already separate chunks. No demonstrated initial-download reduction is claimed.
No browser trace/React Profiler capture was collected; route-shell render isolation
is a code-path improvement, not a measured browser latency claim. The full website
suite was not rerun; see HANDOFF for known baseline failures.

## Exact rollout order

1. Confirm installed prerequisites through 231 and record installed function
   fingerprints independently from source migration locations. Do not replay
   already-installed SQL merely because a file is present.
2. Apply `supabase/migrations/queue/202611060232_saved_auction_ids.sql` once through
   the normal SQL process. The identical ignored standalone copy is
   `bot/supabase/migrations/202611060232_saved_auction_ids.sql`; do not apply both.
   Check authenticated execution and anonymous denial. A timeout rolls back.
3. Deploy cache Worker through the established deployment process. It requires
   SQL 231's existing `read_home_cards`, not 232. Retain flags/bindings/object names.
   Existing Home snapshots age out under unchanged freshness rules.
4. Deploy website Worker/assets with `npm run build:cloudflare` after SQL 232.
   Check `/khub-build.json`, login/logout, bookmarks, saved panel and error retry.
5. No bot binary rollout/restart is required. Include the SQL copy in normal
   standalone packaging; never force-add ignored bot files. Never launch another
   connected worker. Website rollback can use the old full reader; leave the
   additive SQL installed. Cache rollback can use the legacy public Home RPC.

No production SQL, deployment, connected worker or real asset send was performed.
The owner's QUICKSTART guide was untouched.

## Repeatable post-deployment measurement

Record database fingerprints, website build ID, cache Worker version/flags and
Oracle image separately. Retain existing counters; capture complete snapshots just
before rollout, after warmup and at the end of comparable ordinary/peak windows.
Run the comparator on adjacent pairs and the full interval, checking exclusions
before ranking totals. Compare calls, execution time per call, buffer/temp activity
and total execution seconds for both old/new Home, saved IDs/full reads, all detail
RPCs, account access and the four intake RPCs. Normalize for page visits/intake
volume; old clients may continue legacy reads. Do not interpret missing new-entry
baselines as zero cost. Capture another baseline once new RPC identities exist.

Correlate Worker origin/queue/error telemetry, browser request counts and p95/p99,
database waits/resources and BOT_PERFORMANCE phase latencies at the same times.
Check stale/provisional displays and permission/action reconciliation, not only
latency. Compare equal public filter/page requests and private viewer contexts.

Use controlled read-only query-plan profiling with
representative active Sell/Buy, reservations, closed/private/ignored/admin IDs;
repeat warm paired measurements. Extract constituent reads or use controlled
nested auto_explain without parameter/payload logging to locate internal costs.
For filtered browse, obtain actual redacted filter shapes and authorization roles
before designing fixtures/indexes. For replay, use synthetic matching/changed
payloads at representative sizes and historical table cardinalities; explain the
read-only classifier, never opening claims or financial writes on production.
In browser DevTools capture cold Home/browse network waterfalls and React Profiler
commits under polling before/after; separate transfer, parsing and rendering costs.

## Installed-definition follow-up: migration 233

The owner supplied two SQL-definition exports from Supabase. They confirm the
installed legacy/new detail split, bounded history authorization, inlineable
visibility, the 207 replay exception, and public browse's delegation to
`khub_bot.public_listing_page`. This establishes those definitions at export time,
not the identity of the clients responsible for the earlier capture. The exports
contain no execution plans or representative request parameters.

Both public browse and all three private filtered-page overloads evaluate
`profile_is_restricted` per matching listing. Unlike Home/card reads, they had
not adopted per-seller evaluation. Migration 233 first selects candidates with
all existing search, visibility, status, trade and price predicates. It evaluates
restrictions once per distinct relevant seller **within that statement**, then
excludes restricted future-active listings before counting/ranking/pagination.
Closed/past-deadline listings and All-status behavior retain their original rules.
This is neither a shared cache nor an authorization snapshot reused across requests.
No ranking, projection, private field, index, scheduler or financial routine changes.

The migration patches exactly four definitions and aborts on unexpected anchors.
The disposable projection suite preserves old readers and compares complete
responses (excluding only `server_time`) across public/private newest overloads,
active/all/ended/on-hold/cancelled/expired/completed statuses, ending/recommended/
activity sorts, signed-out/owner/other/restricted/admin viewers, active banned
sellers, direct-trade ignores, seller/others/browse views, selective/no-match
searches, trade/price filters and page two. Financial fingerprints are unchanged.
All checks passed.

Five local public-browse envelope timings with 1,000 active listings from one
seller, searching that fixture, ordered by ending:

| Reader | Execution milliseconds |
| --- | --- |
| Before 233 | 176.724, 165.504, 171.802, 166.603, 162.889 |
| After 233 | 64.313, 63.696, 62.904, 65.345, 64.014 |

These fixtures demonstrate avoided repeated checks when listings share sellers.
They do not predict production savings or establish the root cause of the five
slow private requests. The additional candidate materialization has a cost;
measure diverse-seller and actual selective request distributions after rollout.
Static detail/history internals, bot replay/intake and browser traces remain open.

Apply queued `202611060233_browse_seller_checks.sql` after verifying prerequisites
through 232, once per database. Its identical standalone bot copy is under
`bot/supabase/migrations/`; do not apply both copies. No website, cache or bot
runtime deployment is required specifically for 233. Existing release order still
applies for the earlier website/cache changes. Source 232 is now in the parent
migration directory following the owner's move; location alone is not installation
proof. No existing migrations were moved by this follow-up, and QUICKSTART is
unchanged. Do not apply 233 until the normal owner review/application step.

After applying, capture new complete interval baselines and compare
`read_public_auction_page` and each filtered-page identity at equivalent traffic,
including counts, failures, buffer activity and latency. Follow the preceding
measurement plan; do not reset counters or interpret local timings as capacity.

## Combined remaining-read release: migration 234

The owner reported migration 233 applied. Do not rerun it. This release packages
all further justified changes together, without needing another export or separate
runtime rollout for each SQL change.

### Changes and evidence

1. Bid history resolves administrator and username permissions once in a
   statement-local materialized `viewer_flags` CTE. Previously the same stable
   checks were invoked repeatedly across up to 50 projected bids. Authorization,
   UUID/amount keyset pagination, revision shortcuts, giveaway winner markers,
   closed identity rules and administrator delivery references are unchanged.
   The disposable suite compares the full old/new response for anonymous, owner,
   bidder, restricted and administrator viewers, active/settling/awaiting-trade/
   completed states, and revision arguments. Existing scope, ignore, pagination,
   counter and maintenance checks also pass.
2. Scoped gift reads derive the wanted ID set from observed IDs, unposted or
   unopened gifts, opening/isolated attempts (both mail ID and requested ID), and
   unresolved reviews. A left join finds unposted gifts instead of a correlated
   receipt probe in the historical-row OR predicate. All original fields and
   unresolved holds remain; no history is deleted and no arbitrary limit is added.
   Old/new complete responses match on a 5,000-posted-gift fixture. Lifecycle tests
   retain observed/unposted/unopened evidence, reviews and isolation holds.
3. Gift-opening claims return no work before calculating liabilities when there
   are **no unopened envelopes at all**. The global financial advisory lock and
   preexisting opening-attempt barrier still execute first. Every actual envelope
   continues through the original fresh liabilities, raffle holds, wrapper/closet
   exclusions, protected Meat and claim logic. No solvency result is cached or
   reused; no candidate is claimed by the early return. Intake/claim/delivery/
   settlement function fingerprints other than the intentional claim edit are
   unchanged. Empty claims return SQL NULL and create zero attempts; actual-gift
   isolation and the full raffle lifecycle suites pass.
4. Private refresh focus cooldowns start at successful completion, avoiding an
   immediate second account read after a slow read. Ten explicit account events
   during a pending read coalesce into one follow-up after the existing five-second
   cooldown; previously they could be overwritten when the first read completed.
   Failure backoff, hidden-page pausing, timer cadences, token-change refreshes and
   cross-tab timestamps retain their rules. Live-price polling does not use this
   helper and is unchanged.
5. The invitation modal is a lazy chunk behind a small account-context gate.
   Guests and accounts known to have no invitation don't download it. Legacy
   invitation fallback and administrator preview remain available. This also keeps
   its account subscription out of the route shell. No speculative memoization or
   SDK replacement was introduced.

| Local fixture | Before | After |
| --- | --- | --- |
| 50-bid history, five executions | 23.005–24.505 ms | 7.986–10.112 ms |
| 5,000 posted gifts, scoped state | 12.006–13.295 ms; 5,866 shared hits | 4.791–5.015 ms; 1,021 shared hits |
| Empty gift claim, five executions | 5.372–6.355 ms | 1.645–2.026 ms |
| Initial production JS chunk | about 495.5 kB / 148.2 kB gzip | about 490.3 kB / 146.4 kB gzip |

These are fixture timings and emitted artifact sizes, not production capacity,
end-to-end browser latency or measured production savings. Slow-read refresh tests
verify request scheduling directly, including one follow-up for ten explicit events.

### Remaining costs reviewed without speculative rewrites

A disposable function-level static-detail profile measured about 15 ms total in an
active Sell fixture: about 6.5 ms inclusive in the public-auction wrapper chain and
2.3 ms in deal quoting. Inclusive wrapper times overlap and must not be summed.
This does not reproduce the captured 290 ms static-detail latency; flattening the
large projection chain without representative distributions would risk private Buy,
closed-outcome and admin behavior. It remains unchanged. The legacy detail reader
is supported for older clients; its source visibility is already inlineable. No
whole-market scan or current-client caller was established from the exports.

Replay classification still uses exact payload equality, the verified rejected-raffle
exception and pending job/mail/review/gift checks. Existing receipt/retention indexes
and full-inbox barriers remain. Local intake regressions verify those paths, but
neither the exports nor the fixtures reproduce the capture's replay input volume.
No replay, retention, scan-completion, financial serialization or worker concurrency
rewrite is included. Account access already consolidates flags and refreshes on
authorization changes; no extra freshness suppression was justified. Public Home
and filtered browse use the previously implemented 232/233 changes. There is no
claim that every remaining millisecond has been removed.

### Verification

- Node 24 bot suite: **451 passed, zero failed**. The offline lock test required
  local loopback access outside the sandbox; no connected worker was started.
- Node 24 website suite: **528 passed, 21 failed**. Clean HEAD archive baseline:
  **524 passed, 21 failed**, with exactly the same failing names. The ignored bot
  workspace and node_modules were shared into the baseline to satisfy existing
  source-reference tests. The full website suite is not green.
- Disposable PostgreSQL history/detail, raffle lifecycle, intake performance and
  gift isolation suites passed. New fixture setup initially violated existing
  completed-sale constraints; it was corrected to preserve confirmations and the
  fixed winner, then rerun successfully.
- Changed JavaScript/test-source lint: zero errors, existing UserContext Fast Refresh
  warning. Node 24 Cloudflare build, secret check (737 files), SQL-copy comparison
  and whitespace checks passed. The existing large catalogue chunk warning remains.

### One coordinated rollout

1. Since the owner reports 233 applied, verify that prerequisite once; do not rerun
   232 or 233 solely because their source files are present.
2. Apply `supabase/migrations/queue/202611060234_detail_and_intake_reads.sql` once.
   Its identical standalone copy is
   `bot/supabase/migrations/202611060234_detail_and_intake_reads.sql`. Apply only one
   copy to the shared database. Unexpected layouts/timeouts abort the transaction;
   do not remove its safeguards to force application.
3. Deploy the website with `npm run build:cloudflare` for the private refresh fix
   and lazy invitation loading (plus any earlier website edits not yet released).
   Confirm `/khub-build.json`, prompt login/logout, invitation/preview, bookmarks,
   private history and explicit-action reconciliation.
4. No cache Worker change or bot runtime/restart is required **for 234**. If the
   earlier public Home Worker change has not shipped, it still needs its separate
   normal cache deployment; 234 does not deploy it. Include the ignored SQL copy in
   normal bot packaging; do not force-add it or start a second worker.
5. Collect fresh complete statistics baseline/after pairs under the measurement
   plan above. Prioritize history and scoped gifts per-call time/buffers, empty vs
   actual claim phase latency, error/lock rates and browser account read counts.
   Check unopened-gift backlog, review coverage and recovery telemetry alongside
   performance. Production changes must not silently alter privacy or safety.

This agent did not apply production SQL, deploy, start a connected worker, send
assets, move existing migrations, or modify QUICKSTART. Rolling the website back
leaves compatible SQL in place; existing RPC signatures are retained throughout.

## Review of the complete chat change set: migration 235

Reviewed all changes in this chat: 232's private saved IDs and token-scoped hook,
Home cache origin selection, route-shell subscription isolation, 233 browse seller
reuse, 234 history/gift reads and no-envelope claim, private refresh scheduling,
lazy invitation loading, and the read-only plan script. Existing user edits,
original snapshots, migrated SQL placement and QUICKSTART were preserved.

**Finding, fixed locally:** 233's scalar correlated lookup scans the materialized
seller restriction pool for each candidate. The one-seller fixture did not expose
that scaling problem. Migration 235 changes it to a LEFT JOIN on the pool's unique
seller ID, preserving missing matches, all exclusions, page counts, ordering and
payload fields. New tests create 1,000 distinct normally registered synthetic
sellers and inspect constituent EXPLAIN ANALYZE plans. With analyzed fixture
statistics, seller-pool scan loops fell from 1,000 to 1 and execution measured
161.539 ms before / 124.755 ms after. These are local measurements. Without fresh
statistics PostgreSQL can still choose nested loops; a join does not force a
particular production plan. No speculative index or planner setting was added.
Public/private payload parity and financial-definition fingerprints passed with
235 installed. Existing applied migration 233 was not edited or moved.

**Financial review:** no financial regression was found in the local review.
Additional targeted tests show the empty gift-claim path still waits for the global
financial lock and rejects an existing opening attempt even when there are no
unopened envelopes. Scoped state retains posted gifts outside the observed inbox
when referenced by either the attempt mail ID, requested mail ID or an unresolved
review, including reviewed legacy gifts. Old/new full scoped responses match.
All actual claims retain fresh liabilities, wrapper selection, raffle holds and
protected-funds checks. No cached display state authorizes a write. Transfer and
worker concurrency, durable receipt equality, solvency, recovery barriers,
unknown-send behavior and post-write reconciliation were not changed.

Review reruns passed: 451 offline bot tests on Node 24; disposable PostgreSQL
intake performance, full raffle lifecycle, gift isolation, saved-auction ownership,
detail/history and public/private projection suites. Website: 528 passed, 21 failed;
all failing names also occur in the clean HEAD baseline. This is not a green full
website suite. The read-only plan script contains only display reads and rolls
back; no production profiling or financial writes were executed by the agent.

Apply `supabase/migrations/queue/202611060235_browse_restriction_join.sql` once after
234. The matching ignored bot migration copy is identical; apply only one copy.
No runtime deployment or bot restart is required for 235. If 234 is not installed,
apply 234 then 235 in that order; do not rerun previously applied migrations. This
review does not verify live balances or deployed website/cache/bot versions.
