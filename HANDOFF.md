# kHub handoff

Updated November 7, 2026. Local implementation includes migrations through **239**.
Read this, then inspect the relevant code; the roadmap and older rollout notes may
lag implementation. Source placement does not prove production installation.

## Guiding principle for every change

**Performance, database load and scalability are requirements for all new features,
modifications and optimizations—even outside performance work.** Across the website,
Workers, database and bot, inspect and reuse existing caching, request coalescing,
efficient SQL, pagination and concurrency bounds before adding new mechanisms.
Preserve prior improvements and avoid redundant reads, polling or competing
infrastructure as traffic and auction activity grow. Never trade correctness,
freshness, privacy or financial safety for speed.

## Start here

React/Vite website on Cloudflare, Supabase Auth/PostgreSQL for authoritative state,
and a separate Oracle Ubuntu/Docker KMail bot operating **kHub (#3888760)**.
Website, public-cache Worker, database SQL and bot are independent releases.

- [General reference](README.md:1), [database guide](supabase/README.md:1),
  [bot operations](bot/README.md:1), [roadmap](ROADMAP.md:1).
- [Routes](src/App.jsx:1), [account context](src/context/UserContext.jsx:1),
  [auction provider](src/context/AuctionsContext.jsx:1),
  [read service](src/lib/auctions.js:1), [worker](bot/src/worker.mjs:1).
- Auctions, Buy orders, bundles, giveaways, raffles, saved auctions/reminders,
  registration/recovery, balances, histories, feedback, ignores, moderation,
  bans/appeals, polls and trade totals already exist. Inspect before rebuilding.
  Raffle purchases have separate intake/draw/fulfillment paths from auction bids.

Bot investigation reference: [architecture, cycle/poll flow, locks, recovery and pressure points](bot/README.md#architecture-and-execution-reference). November 10 local-code snapshot; deployment and bottleneck attribution remain unverified. Reuse this map before repeating the investigation.

## Invariants to preserve

- SQL RPCs authorize writes and enforce visibility/accounting. Display caches,
  maintenance snapshots and browser permissions never authorize financial actions.
- Keep one KoL-connected worker across hosts. Preserve financial locks, durable
  receipt/payload deduplication, fresh solvency checks, full inbox scans, gift proof,
  recovery barriers and unknown-send protections. Never automatically retry an
  uncertain asset send or financial write. Reconcile actions against authoritative
  state; do not increase Worker/transfer concurrency to mask slow reads.
- Preserve raffle ticket privacy, committed randomness, persisted outcomes, exact
  reserves and receipt/intake grace barriers. Verify deployed feature gates.
- Shared Durable Objects contain allowlisted public data only, with serialized
  origin reads, bounded queues and failure cooldowns. Do not send browser JWTs,
  cookies or private holdings to them or bypass overload protection with visitor
  fallback reads. Private data stays in authorization-scoped browser memory.
- Database pagination, public live prices and private identity/context are separate.
  Authorization changes and explicit actions require fresh private reconciliation.

## Completed locally

- Bounded history/raffle reads, consolidated account flags, coordinated private
  refreshes, pending-trade summaries, lightweight Home/cards, scoped gift state and
  scheduled bot work already exist. Fresh safety is separate from reusable versioned
  capabilities. Invalid safety/state responses stop processing.
- Latest follow-up: public Home cache origin reuses card projections; bookmark
  indicators use private ID-only SQL **232**; **233/235** reuse seller checks and
  avoid correlated seller-pool rescans; **234** reuses history permission flags,
  selects scoped gifts as a set and skips liabilities only when no unopened gift
  exists. Actual gift claims still acquire the financial lock, reject an active
  opening attempt and compute fresh liabilities before granting a claim.
- Website changes isolate the route-shell error subscription, lazy-load invitation
  UI, scope saved-ID memory reuse to authorization and coalesce explicit refreshes
  received during pending reads. Live-price polling is unchanged.
- [November 6 evidence, review and measurement plan](docs/NOVEMBER_6_PERFORMANCE.md:1)
  contains details. [Earlier website rollout](docs/TRAFFIC_READ_PRESSURE_ROLLOUT.md:1),
  [bot scheduling](docs/BOT_WORK_SCHEDULING_ROLLOUT.md:1) and
  [scoped reads](docs/SCOPED_READS_AND_QUERY_STATS.md:1) explain prerequisites.

## Home timeout follow-up

The November 7 production Home timeout occurred inside the abandoned-draft helper;
it does not establish traffic pressure or an idle-session cause. Installed definitions
show a redundant abandoned-draft check on completed recent results. Queued **236**
removes only that call site; helper semantics, visibility and finances remain intact.
Apply once after verified 235; no runtime deployment/restart. See
[Home timeout evidence and rollout](docs/HOME_READ_TIMEOUT.md:1). Production resolution
is unverified; distinguish SQL timeouts from browser stale-request recovery.

## Rollout state and next steps

- Owner explicitly confirmed **233 applied**. Files **232–235** are now in the
  parent migration directory; **236 is queued**. Application of **234
  and 235 has not been explicitly confirmed**; verify installed definitions before
  running anything. Do not infer installation from moved files or rerun confirmed SQL.
- If outstanding, apply **234 then 235**, once per database. Website and ignored bot
  migration copies are identical alternatives, not two scripts to apply. Earlier
  website changes require 232; public Home cache routing requires 231.
- Website/cache deployment versions and the live bot image remain unverified.
  Deploy the website with `npm run build:cloudflare` if these changes are unshipped;
  the Home origin change needs its separate cache Worker deployment. SQL 232–235
  needs no bot binary update/restart. Older bot scheduling/scoped-state runtime
  changes still need their own release if not already installed.
- No production SQL, deployment, connected worker or asset send was performed by
  this agent. Owner actions and local verification are separate evidence.

## Verification and unresolved issues

Latest Node 24 checks: **451 bot tests passed**; six relevant disposable PostgreSQL
suites passed, including privacy, accounting, solvency, gift isolation and recovery.
No local financial regression was found. Website: **528 passed, 21 failed**; exactly
the same failing names occur in the clean HEAD baseline. Do not call the full suite
green. Build, changed-source lint and secret scan passed; existing Fast Refresh and
large catalogue chunk warnings remain. These checks do not verify live balances.

The November 6 capture is a clean 69-minute interval. Aggregate RPC time does not
identify internal plans, client builds or outage causes. Legacy detail callers,
remaining static/detail internals, replay/inbox-completion costs and actual browser
latency remain unresolved. Fixtures demonstrate avoided work, not production
capacity. Measure deployed versions and equivalent traffic with complete snapshot
pairs, Worker queues/errors, database waits/resources and bot phase telemetry.
Do not add speculative indexes or increase compute/concurrency without evidence.

## Mr. A Sell payments — local implementation complete, activation disabled

See [financial invariants, tests and rollout](docs/MR_A_PAYMENTS.md:1).
Queued [237](supabase/migrations/queue/202611070237_mr_a_direct_payments.sql:1)
and [238](supabase/migrations/queue/202611070238_mr_a_escrow_payments.sql:1)
support ordinary Direct/Escrow Sell and Bundle payments. Locked rates use a fresh
indexed market quote; physical Meat/Mr. A composition remains separate from bid
value through intake, reserves, refunds, buyout, capped fees and delivery. Existing
receipt/gift proof, locks, scan barriers and unknown-send recovery remain intact.
238 defaults new mixed Escrow creation to disabled; only the service-role/owner
activation RPC can enable it. Turning it off never abandons existing obligations.

Website/cache projections, exact KMail instructions, seller fee-waiver displays,
Direct notices, support queries and bot reports are integrated. Matching ignored
bot SQL copies and parser/report changes require their separate release. Apply
once per database after verified 236; deploy compatible website/cache/bot versions
before explicitly enabling creation. Do not downgrade accounting with live mixed
obligations. Personal bot quickstart remains unchanged.

Node 24: 20 feature tests passed; full website 549 passed/21 failed, same failing
names as clean HEAD. Full mocked bot: 457 passed. New mixed Escrow and Direct SQL
suites plus seven relevant existing financial suites passed. Legacy bundle suite's
card-context assertion fails identically on clean HEAD; new mixed Bundle tests
pass. Build, changed-source lint and secret scan passed. No browser visual QA,
production migration/deployment, connected worker or real transfer was performed.

Independent audit: [confirmed fixes and rollout blockers](docs/MR_A_AUDIT.md:1).
Apply additive **239 after 238** before enabling new mixed escrow. It fixes large
Mr. A gift proof and missing-row activation guards; matching ignored bot copy and
review-reader fix exist. Rate editing no longer resets cleared input. Audit checks:
expanded mixed Escrow, Direct, receipt-time, incoming-gift and resilience SQL suites
passed; 27 targeted Node tests passed; full bot 458 passed; website 550 passed/21
failed with no new failing names. Build/lint/secret checks passed. Nothing was
activated, deployed or applied to production.

## Workspace rules

Preserve existing edits and diagnostic exports. New website SQL belongs in
`supabase/migrations/queue/`; matching standalone copies belong in
`bot/supabase/migrations/`. Never relocate existing migrations or force-add ignored
`bot/`; include it in the owner's separate release/backup process. Keep secrets out
of source/logs/public payloads. Use project-relative code links with relevant lines.
**Do not modify `bot/QUICKSTART_README.md` unless the owner explicitly requests it.**

## Buy deposit confirmation wording

Queued [240](supabase/migrations/queue/202611070240_buy_funding_message_layout.sql:1)
puts Purchase funds and Commission reserve directly under the activation sentence,
then the simplified promotional-reserve explanation. Formatting only; financial
records and frozen/sent messages remain unchanged. Identical ignored bot copy
exists. Disposable `buy_funding_message_database_test.py` passed exact 4M/170k
(4.25%) output and row-preservation checks. Not applied to production; no bot
binary update is needed after the owner applies SQL. Personal quickstart untouched.

Home Mr. A indicator: additive queued migration **241** adds `mr_a_rate` to
`public_listing_projection`'s existing whitelist. Home cards already render the
icon but previously received no acceptance metadata. Apply once after 240; no
financial functions, extra queries or polling changed. Matching ignored bot SQL
copy included. Mr. A Direct disposable database regressions pass with mixed and
Meat-only projection/privacy assertions. Not applied to production; cached cards
must expire or be invalidated after installation.

November 7 traffic follow-up: see `docs/NOVEMBER_7_TRAFFIC_PRESSURE.md`. Owner
noticed slowdown during Mr. A Sell creation; creation's financial-lock contention
is a hypothesis, not established by cumulative counters. Queued additive **242**
replaces Home's correlated seller-pool rescan with a join; local 1,000-seller plan
scans fall 1,000 → 1 but total time improves only ~4%. Privacy/parity/financial
regressions pass. New read-only `scripts/traffic-pressure-snapshot.sql` captures
waits/blockers and financial-lock holders without raw SQL; stats snapshot adds
optional JIT counters. Need a during-incident capture and a short snapshot pair;
no new retries/TTLs/polling, deployment, production SQL or live bot action occurred.

Additional incident evidence: November 7 exports (9)/(11) span 56.106 seconds:
read_auction_page 2 calls/7.262s, public browse 1/2.128s, bot ingest 391/3.609s.
Pressure export (10) was idle, no blockers/financial lock, JIT off. Timeout logs
pinpoint Buy history in full read_auction_page and public_listing_page separately.
Queued **243** reuses permissions within Buy history; 120-fulfillment JSON parity
and 100-row/privacy checks pass for five roles. No inference of Sell-only history,
old browser builds, duplicate bot payments or current CPU exhaustion is warranted.
Current Profile/Seller requests can still call the six-argument reader. Both SQL
optimizations remain local; verify rollout and measure public browse separately.
Measured Buy history 243: local 100-row host reads ~27ms → ~3.2ms (~88% less time),
exact output/privacy parity retained. Live incident resolution remains unverified.

Earlier logs show a 23:14–23:15 UTC cluster across Home, full/static detail,
viewer deal_quote and narrow public detail startup. They predate the idle 23:27
capture; varying cancellation frames do not identify a single root cause or prove
Mr. A creation contention. Pressure diagnostic now includes bounded active RPCs
and allowlisted role timeout/planning overrides; locally validated (including a
synthetic role timeout). Need current rollout status/resource graphs/during-stall
capture before declaring resolution. No additional speculative migration added.

Further local pressure reductions: queued cache live reads recheck fully covered,
<=2s verified states after earlier work completes; original timestamps and scoped
invalidation remain authoritative. Two overlapping queued keys now need one origin
read; 61 cache/detail tests pass. Deploy separate cache Worker, no TTL/polling or
concurrency increase. Queued **244**, after 243, builds existing public-card JSON
whitelist directly instead of serializing all private auction columns then filtering.
Local 120-card cost ~15.8→11.8ms (~25% less); whole JSON/privacy parity across all
fixture auctions/five roles and financial-definition suite pass. Matching ignored
bot SQL copy included. No deployment/production SQL/live transfers; current outage
root cause and production capacity remain unverified. See November 7 pressure doc.

November 8 payout KMail: queued additive **245** (after 244) formats mixed seller
payments as Winning bid / Total bid value / Commission / Your proceeds / Attached.
Reuses existing guarded multi-item KMail batching for mixed sale_meat rows; gifts
keep known-unsent split fallback. Ledger/dedupe rows, locks, envelope limits and
unknown-send protections unchanged. Frozen/sent/uncertain bodies not rewritten.
Mixed escrow SQL suite passes combined envelope, exact wording/assets, gift split,
unknown/reconciled/repeated acknowledgments and legacy financial tests. Stop sole
worker to apply SQL then resume; no binary/site rebuild. No production action run.

November 9 Admin Analytics Users charts: additive queued **246** extends the existing
`read_admin_new_users` response with rolling 24/168/720-hour registration counts,
using one bounded pass over the existing registration index and reusing the 7-day
count for the existing list. Website adds compact responsive chart panels with
exact-count hover titles and accessible counts; weekly list/search/pagination remain.
No application-owned successful-login event source was found. User Activity explicitly
shows unavailable, with no inferred visits/session-refresh counts or fabricated zeros.
No new polling/browser requests. Matching ignored bot migration copy exists; apply
once per database, deploy website separately; no bot restart required. Six targeted
Node tests, disposable PostgreSQL count/list/access tests, build, changed-source lint
and secret scan passed. No production SQL/deployment or browser visual QA performed.
Personal quickstart unchanged.

November 9 shared font-poll hearts: queued **247** adds private per-poll/account/font
hearts, desired-state idempotent authenticated writes, active font/free-text poll and
restriction checks, a 100-font/account/poll cap, voter and ranking indexes, and
cascade cleanup. Existing feed returns only the viewer's active-poll hearts;
existing administrator inbox thread read includes top 50 aggregate counts, sorted
most to least with alphabetical ties. Compact scrollable ranking precedes written
responses. No extra read requests/polling/shared-cache changes. Heart clicks now
write to Supabase; old browser favorites are not imported as votes. Apply 247 once
then deploy website; matching ignored bot copy exists, no bot restart needed.
33 targeted Node tests and disposable free-text/poll-heart SQL regressions pass;
build, changed-source lint and secret scan pass. No production SQL/deployment or
browser visual QA. Personal quickstart unchanged.

November 9 login activity: queued **248** adds private, indexed minimal login events
from server-side password AMR claim inserts (one per session); no browser callback,
full audit logs, polling or shared cache changes. Existing Users RPC computes both
series in one bounded 30-day account-grouped pass. Chart shows recording start and
partial-history notice; registration list/counts remain. Retention deletes at most
100 >31-day records per login; idle data waits for later logins. Matching ignored
bot SQL copy exists. See docs/LOGIN_ACTIVITY.md for Auth-trigger prerequisites,
post-install login smoke test and recovery. Seven targeted Node tests and disposable
PostgreSQL tests passed, including rollback/dedupe/refresh/privacy/retention. No
production SQL or deployment; hosted Auth behavior remains to be smoke-tested.

November 9 visit analytics supersedes login activity: queued **249** extends existing
90-second presence RPC to sessionize visits after >=30 minutes without activity,
coalescing signed-in tabs/devices by account and keeping guests separate. Existing
admin Users RPC returns active-account, visit-start and guest series from one indexed
30-day read; registration/list behavior unchanged. Chart uses Unique Active Users /
Total Visits, with guest/coverage definitions collapsed. No added requests/polling,
shared caches or financial locks. Retires custom 248 password recording via a no-op function (no Auth table alteration); previous
login records retained. Bounded 50-row retention batches on existing heartbeats.
See docs/SITE_VISIT_ANALYTICS.md. Seven Node tests, disposable SQL visit/account/
guest/registration/privacy tests, build/lint/security checks passed. No production
SQL/deployment or browser visual QA. Personal bot quickstart unchanged.

November 9 giveaway diagnostic review: docs/NOVEMBER_9_GIVEAWAY_PRESSURE.md and
scripts/11-9-2026 snapshots/analysis/interval-{1,2}.csv analyze complete 13:27–13:41
UTC pairs. Broad second-interval read degradation despite fewer private calls;
bid history/account/polls/static detail total ~76s observed execution. Overlapping
13:40:58 pressure capture matches bot/static timeout PIDs, with no blockers or
financial lock and JIT off. CPU/resource cause remains unverified. Bot ingest 7→411
calls is consistent with optional replay-read timeout fallback; require worker logs
before attributing to replay/new mail. 42501 is the older 249 managed-Auth-table
ALTER failure, separate from read pressure. No production SQL/deployment/runtime
changes; proposed optimization priorities and missing evidence are in the report.

November 9 additional giveaway captures extend review through 14:24:51 UTC:
three new adjacent interval deltas and updated docs/NOVEMBER_9_GIVEAWAY_PRESSURE.md.
Broad recovery: final bid history/account/poll means ~47/52/54ms, but Home ~624ms,
static detail ~309ms and full page ~1257ms (six calls). Live detail request rate
~3x incident with lower mean, so do not blame raw polling volume. Prioritize installed
Home/full/static/public-browse plans for persistent cost; retain resource/CPU-credit
and replay-log investigation for transient episode. No new blockers/JIT/connection
exhaustion observed; idle snapshots do not prove incident resolved. No runtime edits
or production actions in this review.

Later November 9 read timeouts: docs/NOVEMBER_9_LATER_READ_TIMEOUTS.md reviews
16:30:23 UTC Home (site_trade_totals startup) and 20:33:55 UTC browse
(deal_quote/deal_score). Current totals reader is a cached singleton SELECT, so
cancellation there does not prove aggregate recomputation; earlier Home work may
have consumed its budget. Browse scoring before pagination is a concrete profiling
target, not yet a proven faulty inner plan. Morning captures do not cover these
times. A one-off read-only definition diagnostic collected targeted installed
code/index/stat metadata without executing app readers; validated in disposable
PostgreSQL and subsequently removed after review. No speculative fix, migration or production action.

Later timeout follow-up export (00:18:36 UTC Nov 10) confirms read-only singleton
site_trade_totals, expected catalog/market-price/snapshot primary keys, Home seller
LEFT JOIN and direct card whitelist in production at capture. Home has five
visible_auctions call sites; public browse scores candidates before seller exclusion.
Prioritize measured visibility/quote reuse with privacy/JSON parity, not another
milestone cache or duplicate indexes. Metadata is later than errors and does not
prove incident-time plans/root cause. Details appended to later-timeout document.
No runtime/SQL/deployment changes.
