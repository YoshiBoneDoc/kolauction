# kHub handoff

Updated November 6, 2026. Local implementation includes migrations through **235**.
Read this, then inspect the relevant code; the roadmap and older rollout notes may
lag implementation. Source placement does not prove production installation.

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

## Rollout state and next steps

- Owner explicitly confirmed **233 applied**. Files **232–235** are now in the
  parent migration directory and the queue contains no SQL. Application of **234
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

## Workspace rules

Preserve existing edits and diagnostic exports. New website SQL belongs in
`supabase/migrations/queue/`; matching standalone copies belong in
`bot/supabase/migrations/`. Never relocate existing migrations or force-add ignored
`bot/`; include it in the owner's separate release/backup process. Keep secrets out
of source/logs/public payloads. Use project-relative code links with relevant lines.
**Do not modify `bot/QUICKSTART_README.md` unless the owner explicitly requests it.**
