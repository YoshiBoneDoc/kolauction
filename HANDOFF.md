# kHub handoff

Updated November 5, 2026, through implemented migration 231. Read this first, then
inspect relevant code: documentation and the roadmap can lag implementation.
Repository state does not establish what is deployed. The live bot handles real
players' Meat and items.

## Project essentials

- React/Vite website on Cloudflare; Supabase Auth/PostgreSQL holds authoritative
  state. A separate Oracle Ubuntu/Docker KMail bot operates **kHub (#3888760)**.
- Sell, Buy and Bundle listings support Direct and Escrow settlement, funded bids,
  refunds, deliveries and payouts. Giveaways support Last Bid, Random Draw, Split
  and Surprise Me. Raffles have separate ticket, supply, commitment/draw and
  fulfillment paths; do not confuse raffle purchases with website auction bids.
- Registration/recovery, verified identities, private balances/reservations,
  histories, feedback, moderation, bans/appeals, ignores, polls and trade totals
  already exist. Inspect existing implementations before proposing replacements.
- Start at [routes](src/App.jsx:1), [account context](src/context/UserContext.jsx:1),
  [auction provider](src/context/AuctionsContext.jsx:1),
  [read service](src/lib/auctions.js:1) and [bot worker](bot/src/worker.mjs:1).
  See [README](README.md:1), [database guide](supabase/README.md:1),
  [bot operations](bot/README.md:1) and [roadmap](ROADMAP.md:1).

## Safety and architecture

- Supabase RPCs authorize writes and enforce visibility/accounting. The bot uses
  durable receipts, financial serialization, fresh solvency checks and recovery
  barriers. Keep one KoL-connected worker; never automatically retry an uncertain
  asset send, remove financial locks or use cached safety as transfer authority.
- Website and public-cache Workers deploy separately. Shared snapshots use bounded
  Durable Objects with origin serialization, queue limits and failure cooldowns.
  They contain allowlisted public data and never browser JWTs/cookies or holdings.
  Private reads go directly to Supabase with authorization-scoped memory caches.
- Listing pages are database-paginated. Public live prices/deadlines remain distinct
  from private context; actions reconcile against authoritative state. Preserve
  overload protection rather than increasing concurrency to mask slow origins.
- Raffle receipts/draw inputs and settlement are durable and restart-safe. Preserve
  ticket privacy, committed randomness, intake/grace barriers and exact reserves.
  Verify current feature gates in code and production; older activation notes are
  not evidence of today's runtime state.

## Recent performance work — implemented

- **227–229:** narrower history/activity reads; backed-off/coalesced raffle and
  commitment reads; public commitment caching; consolidated account flags;
  paginated personal ticket history; lightweight collapsed pending-trade counts;
  slower private polling, cross-tab coordination and browser pressure backoff.
  Confirmed bids return before display reconciliation without automatic write retry.
  See [website rollout](docs/TRAFFIC_READ_PRESSURE_ROLLOUT.md:1).
- **230:** fresh per-cycle bot safety with versioned capability reuse, post-intake
  work plans, due/idle maintenance scheduling, private raffle wakeups, persistent
  beacon backoff and bounded refund batches. Safe `[BOT_PERFORMANCE]` aggregates
  expose RPC/phase/cycle latency, empty work and backlog signals.
  See [bot rollout](docs/BOT_WORK_SCHEDULING_ROLLOUT.md:1).
- **231:** lightweight Home and Buy/closed card projections; distinct-seller
  restriction checks; per-auction private live-browse caching (60 seconds, 256
  entries, 24-ID batches). Scoped bot gift state omits unrelated posted history
  while retaining observed/unposted/unopened records and all unresolved holds.
  Empty isolated intake uses two state reads instead of three. Invalid state stops
  processing; opening/recovery/final reconciliation safeguards remain intact.
- Complete [statistics snapshots](scripts/query-stats-snapshot.sql:1) and an
  [interval comparator](scripts/queryStatsDelta.py:1) replace misleading cumulative
  “last 24 hours” interpretation. Capture two complete exports about 24 hours apart;
  resets, eviction and missing baselines are flagged rather than guessed.
  See [231 rollout, measurement and profiling](docs/SCOPED_READS_AND_QUERY_STATS.md:1).

## Latest verification and next steps

- Latest checks: **451 bot tests passed** on Node 24; disposable PostgreSQL lifecycle
  and projection suites passed, including privacy, accounting and recovery checks.
  Website build and changed-source lint passed. Full website suite: 521 passed,
  21 failed; all failing names also occur in a HEAD baseline comparison. Do not
  describe the full suite as green. Four statistics-delta tests and five cache
  tests passed. Local fixture timings are not production capacity measurements.
- SQL 227–230 is in the parent migrations directory; **231 is queued**. Matching
  bot SQL lives under `bot/supabase/migrations/`; apply each migration once per
  database, not once per copy. Verify installed definitions and prerequisites.
- For the latest release: SQL 231 first, then website and bot independently. The
  new website Home RPC requires that SQL. Build with `npm run build:cloudflare`.
  A website push does not deploy the ignored bot. This work did not apply production
  SQL, deploy, restart the bot or send real assets.
- Next priority: verify deployed website/cache/bot versions, then measure ordinary
  and peak traffic. Correlate RPC volume/latency, Worker queue failures, database
  waits/resources and bot phase timings. No outage root cause or production savings
  has been established. Profile remaining expensive reads before adding indexes
  or changing scheduler/concurrency limits. Some roadmap items are already done.

## Working rules

Preserve existing edits and keep secrets out of source, logs and public payloads.
`bot/` is intentionally gitignored: include changes in its separate release and
backup process; never force-add it. New website SQL belongs in
`supabase/migrations/queue/`, with matching bot SQL; do not relocate existing files.
Keep the owner's personal `bot/QUICKSTART_README.md` unchanged unless explicitly
asked to edit that guide. Use project-relative code links with relevant lines.
