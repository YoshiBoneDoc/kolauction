# kHub — KoL Auction Hub

React/Vite auction website with Supabase Auth/PostgreSQL and a separate Oracle
KMail bot operating **kHub (#3888760)**. Start new sessions with the
[current handoff](HANDOFF.md:1). See the [database guide](supabase/README.md:1),
[bot operations](bot/README.md:1) and [roadmap](ROADMAP.md:1); inspect current code
before treating older documentation as unfinished work or deployed behavior.

See the [bot architecture, cycle diagrams and recovery reference](bot/README.md#architecture-and-execution-reference) for task priorities, database locks and high-traffic risks.

## Development principle

**Consider performance, database load and scalability in every feature, change and
optimization across the website, Workers, SQL and bot.** Build on existing shared
caching, request coalescing, efficient queries, pagination and bounded concurrency
where practical. Preserve established optimizations; avoid redundant reads,
unnecessary polling, expensive unbounded operations and competing infrastructure.
Design for growing traffic and auction activity without compromising correctness,
data freshness, privacy or financial safety.

## Architecture

| Component | Entry point | Runtime |
| --- | --- | --- |
| Website | [Routes](src/App.jsx:1), [auction provider](src/context/AuctionsContext.jsx:1) | Cloudflare Worker + Vite assets |
| Website API | [Site adapter](workers/site/index.js:1) | Root Wrangler configuration |
| Shared public snapshots | [Cache Worker](workers/public-auction-cache/index.js:1) | Separate Worker / SQLite Durable Objects |
| Authorization and accounting | [RPC client](src/lib/auctions.js:1), [account context](src/context/UserContext.jsx:1) | Supabase Auth/PostgreSQL |
| Asset handling | [Bot worker](bot/src/worker.mjs:1) | Oracle Ubuntu / Docker |

The website adapter serves public auction/banner reads, invalidation and giveaway
images; unknown API routes return JSON 404, not SPA HTML. Amplify files are legacy
scaffolding. SQL, website, cache Worker and bot have separate release lifecycles.

## Existing functionality

- Sell, Buy and Bundle listings; Direct and Escrow settlement, funded bids, Buy
  reservations/fulfillments, deposits, refunds, winner deliveries and seller payouts.
- Server-authoritative increments, buyouts, custom deadlines, receipt-time checks
  and late-bid extensions for ordinary Sell auctions.
- KMail registration/recovery, verified KoL identities, private balances, saved
  auctions and at-most-once reminders, profile/seller histories and trade totals.
- Giveaways: Last Bid, Random Draw, Split and Surprise Me. Non-Last-Bid conditions
  require Escrow. Giveaways require the exact next minimum, reject self-outbids and
  do not extend deadlines. Outcomes persist before delivery; history marks recipients.
- Raffles: private tickets, prize supply, commitments, verified randomness, durable
  draws and fulfillment. These use separate intake/accounting from auction bids;
  availability depends on deployed feature gates.
- Feedback/withdrawal, trade queries, ignores and visibility filtering, moderation,
  bans/appeals, reviewed ban gallery, admin inbox/analytics, announcements and polls.

## Financial and privacy boundaries

SQL RPCs enforce authorization, visibility, accounting and deadlines. Browser state
and cached permissions are advisory. Writes reconcile against authoritative reads;
uncertain financial writes and asset sends must never be automatically retried.

The bot uses financial serialization, durable receipts and exact payload checks,
fresh solvency checks, full inbox scans, gift proof and recovery barriers. Preserve
unknown-send protections, protected assets, exact raffle reserves and persisted
outcomes. Run only **one KoL-connected worker across all hosts**; never remove locks
or increase transfer concurrency as a performance shortcut.

Listings are database-paginated. Public static/live facts are separate from private
identity, reservations and history. Shared cache requests contain no browser JWTs
or cookies, and responses contain only allowlisted public fields. Private read
caches are authorization-scoped memory, not shared or persistent browser storage.
Explicit actions, authorization changes and status transitions retain fresh checks.

Public live state has a two-second TTL; listing selection normally refreshes every
30 seconds. Durable Objects serialize origin work and retain bounded queues,
timeouts and failure cooldowns. HTTP responses are `no-store`; objects own storage.
Temporary overload failures must not trigger per-visitor origin floods or expose
unverified prices as live. See [shared-state rules](docs/SHARED_LIVE_STATE_ROLLOUT.md:1)
and [deployment/cache settings](docs/CLOUDFLARE_SITE_DEPLOYMENT.md:1).

Trade totals count completed Sell value and paid Buy fulfillments, with actual
component quantities; deposits, refunds, donations and commission do not inflate
trade value. Totals are display snapshots, never financial authority. The bot
refreshes KoLmafia item data weekly; tradeable or giftable items are eligible except
package wrappers. The website caches catalog data with a bundled fallback, while
SQL remains authoritative for item validation. `npm run update:items` updates the
checked-in reference data, not production.

## Development and verification

Use **Node 24**, also required by the bot. From the website root:

```sh
npm ci
npm run dev
```

Configure public Supabase settings from `.env.example`. Plain Vite does not emulate
Durable Object APIs; use direct reads or a configured Worker preview locally.

```sh
npm run build
npm run lint
node --test tests/*.test.mjs
npm run security:check
```

Python database suites under `tests/` use disposable PostgreSQL clusters; inspect
individual prerequisites. Never use a live bot or real financial transfers as tests.
Current validation and known baseline failures are recorded in the handoff; the
full website suite is not green. Local fixtures are not production capacity tests.

## Deployment and current release

[Deployment instructions](docs/CLOUDFLARE_SITE_DEPLOYMENT.md:1) define bindings and
settings. Cloudflare Git integration builds the website with
`npm run build:cloudflare`, enabling shared caching by default and emitting
`/khub-build.json`. Plain Vite build does not enable shared caching. GitHub Actions
validates/dry-runs the website and deploys **only the separate cache Worker**.
Database application and Oracle bot rebuild/restart remain manual, separate steps.

New website migrations belong in `supabase/migrations/queue/`. The owner moves them
after application; do not move existing scripts or infer installed state from file
placement. Matching ignored bot SQL copies apply to the same database: run each
migration once, not once per copy. Verify prerequisites and installed definitions.

Local performance work is implemented through **235**: lightweight public Home,
private bookmark IDs, per-seller browse checks, bounded history with statement-local
permissions, scoped gift reads and lower idle work, plus refresh/render/load changes.
The owner confirmed 233 applied; later SQL installation and application deployment
versions need confirmation. If outstanding, apply **234 then 235**; deploy unshipped
website changes afterward. The earlier Home routing change also needs a cache
Worker deployment. SQL 232–235 needs no bot restart. See the
[handoff](HANDOFF.md:1) for current status and
[performance evidence/review](docs/NOVEMBER_6_PERFORMANCE.md:1) for rollout details.

`bot/` is deliberately gitignored and absent from fresh website clones. Never
force-add it; preserve its separate release/backup process. A website commit does
not ship the bot or identify the live Oracle image. Earlier bot capability/runtime
changes require their own rollout if not already deployed.

## Diagnostics and known limits

Use [complete statistics snapshots](scripts/query-stats-snapshot.sql:1) and the
[interval comparator](scripts/queryStatsDelta.py:1) on baseline/after exports;
cumulative counters cannot reconstruct an arbitrary historical window. Check resets,
eviction and missing baselines; nested execution times can overlap. Correlate RPC
costs with Worker queues/errors, database waits/resources and bot phase telemetry.

During slowdowns, run the [pressure snapshot](scripts/traffic-pressure-snapshot.sql:1)
in Supabase SQL Editor. It captures active operations, waits and blockers without
executing application readers.
Use controlled representative fixtures for deeper query-plan profiling; never run
financial-write `EXPLAIN ANALYZE` on production or reset shared counters.
Production savings, legacy-client provenance and some detail/intake/browser costs
remain unresolved. No past outage root cause has been established.

## Secrets and documentation

Publishable Supabase keys belong in public build settings. Service-role keys, KoL
passwords, SSH keys and invalidation secrets do not. Build/package scans reject
private material; `npm run security:install` installs the staged-file check.
Ignoring a path does not remove previously committed secrets from Git history.

Keep this README general and the handoff focused on current state. Detailed evidence
and procedures belong in linked technical documents. The owner's personal
`bot/QUICKSTART_README.md` must remain unchanged unless explicitly requested.

The [November 7 Home timeout follow-up](docs/HOME_READ_TIMEOUT.md:1) adds queued
SQL 236 to remove a redundant abandoned-draft check on completed Home results.
Local parity/profiling passed; production resolution remains unverified.

Optional Mr. A payments are [implemented locally](docs/MR_A_PAYMENTS.md:1) for
Direct/Escrow Sell and Bundle auctions, using locked market-validated rates,
physical-asset accounting and Meat-capped commissions. Queued SQL 237–239 and
compatible website/cache/bot releases are required. New mixed Escrow creation
remains disabled until explicit owner-controlled activation; nothing was deployed.

The [Mr. A audit](docs/MR_A_AUDIT.md:1) records confirmed fixes and remaining
rollout requirements; apply audit migration 239 before any mixed escrow activation.

Additional local traffic optimizations: queued live reads can reuse freshly verified
auction state without renewing its two-second TTL; additive SQL **244** constructs
public card JSON directly. See [evidence and rollout](docs/NOVEMBER_7_TRAFFIC_PRESSURE.md)
for regression results and the remaining incident-diagnosis limits. These changes
require their separate SQL/cache Worker rollout; no production resolution is claimed.
