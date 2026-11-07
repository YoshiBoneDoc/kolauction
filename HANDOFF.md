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
