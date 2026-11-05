# kHub — KoL Auction Hub

React/Vite auction website with Supabase Auth/PostgreSQL and a separate Oracle
KMail worker for **kHub (#3888760)**. Start new sessions with [the handoff](HANDOFF.md).
See [unfinished work](ROADMAP.md), [database reference](supabase/README.md) and
[bot operations](bot/README.md). Repository state does not prove production rollout.

## Architecture

| Component | Entry point | Runtime |
| --- | --- | --- |
| Website | [React routes](src/App.jsx:1) | Cloudflare Worker + Vite static assets |
| Website API | [site adapter](workers/site/index.js:1) | Root `wrangler.jsonc` |
| Shared snapshots | [cache Worker](workers/public-auction-cache/index.js:1) | Separate Worker / SQLite Durable Objects |
| Auth and authoritative state | [RPC client](src/lib/auctions.js:1), `supabase/migrations/` | Supabase |
| Asset handling | [bot worker](bot/src/worker.mjs:1) | Oracle Ubuntu / Docker |

The website Worker serves `/api/public-auctions`, `/api/public-banner`,
`/api/public-auctions/invalidate` and `/api/giveaway-image`; unknown API routes return
JSON 404 instead of SPA HTML. The repository's Amplify files are legacy scaffolding.

## Implemented functionality

- Sell, Buy and Bundle auctions; Direct settlement and automated Escrow deposits,
  funded bids, refunds, winner deliveries and seller payouts.
- Server-authoritative minimum increments, buyouts, late-bid extension for ordinary
  Sell auctions, custom deadlines and receipt-time safeguards.
- KMail registration/recovery, verified KoL identities, profile histories, seller
  profiles, private balances/reservations and public trade totals.
- Raffles with private ticket histories, commitment verification, durable draws,
  prize supply and fulfillment; operational availability depends on deployed gates.
- Feedback/withdrawal, trade queries, account bans/appeals, reviewed public ban
  gallery, admin inbox, analytics, announcements and multi-select polls.
- Player ignores with server-side visibility filtering; site activity tracking.
- Admin giveaway preset; Last Bid, Random Draw, Split and Surprise Me conditions.
  Non-Last-Bid conditions require Escrow. Giveaways require the exact next minimum,
  reject self-outbids and do not extend their deadline. Draws/allocations are persisted
  before delivery. Actual prize recipients are marked in bid history.

### Read and cache boundaries

[The provider](src/context/AuctionsContext.jsx:1) loads bounded database pages, not
an entire market dataset. Its memory cache is scoped to viewer authorization;
private auction datasets are not persisted in browser storage. Preferences are separate.

[The public transport](src/lib/publicAuctionReader.js:1) shares allowlisted public
rows without browser cookies/JWTs. Home needs no card-context read; signed-in viewers
may need a cached ignore-eligibility check. Eligible browse/seller pages add private
context separately. Own/others, affected ignore pools and signed-in All-status views
can use direct reads. Actions use live authorization and authoritative post-write refreshes.

Public detail static/live snapshots are combined with private context and bid history;
details are not wholly cached. Public live TTL is two seconds; static TTL five minutes.
Active private context refreshes every 60 seconds, closed private detail every 120
seconds and unpublished drafts every 30 seconds, with authoritative refreshes on
transitions/actions. Live browse reuses private context per auction for up to 60
seconds, scoped to authorization; status changes and reservation expiry invalidate it.
Featured giveaway shares the listing object, with a 30-second TTL; banner has a separate object.

Listing snapshots are fresh for 30 seconds and normally usable up to five minutes
while refreshing; known bid-invalidated snapshots must revalidate. Each object
serializes origin reads, spaces starts by one second, allows four distinct pending
keys, uses an eight-second fetch deadline and a 30-second origin-failure cooldown.
These overload protections can produce temporary 503s. Never bypass privacy or flood
Supabase with per-visitor fallback reads. HTTP responses are `no-store`; Durable
Objects, not a blanket CDN rule, own shared storage. See [deployment](docs/CLOUDFLARE_SITE_DEPLOYMENT.md).

### Totals and reference data

Public lifetime trade value includes completed Sell prices and paid Buy fulfillments;
items sum actual component quantities; trades count completed Sells and paid Buy
fulfillments. Deposits, refunds, donations and commission are not added as trade value.
Record bids and giveaway totals are separate measures. Aggregate snapshots are
advisory display data, never financial authorization.

The bot refreshes KoLmafia item data weekly. Tradeable or giftable items are eligible,
excluding package wrappers. The website has a five-minute catalog cache and bundled
fallback; database validation remains authoritative. `npm run update:items` refreshes
checked-in reference data, not the live deployment.

## Development and verification

Use Node 24 (also used by CI and required by the bot). From the website root:

```sh
npm ci
npm run dev
```

Use `.env.example` for public Supabase settings. Plain Vite does not emulate the
Durable Object API; use direct reads locally or a configured Worker preview.

```sh
npm run build
npm run lint
node --test tests/*.test.mjs
npm run security:check
```

Python database suites under `tests/` use disposable PostgreSQL clusters; inspect
individual prerequisites. Do not run a live bot or financial writes as tests.

## Deployment

[Deployment reference](docs/CLOUDFLARE_SITE_DEPLOYMENT.md) contains exact settings,
bindings and verification. Website: Cloudflare Git integration uses
`npm run build:cloudflare` and root Wrangler configuration. This build defaults shared
caching to true and emits `/khub-build.json`; plain `npm run build` does not enable it.
GitHub Actions validates/dry-runs the website and deploys **only the cache Worker**.
SQL application and Oracle bot rebuild/restart are manual, separate steps.

`bot/` is deliberately gitignored and absent from fresh website clones. Never force-add
it. Keep private bot releases and credentials backed up separately. A website commit
cannot identify the live Oracle image. Run only one KoL-connected worker across hosts.

## Performance investigation

Performance work through migration **231** is implemented locally: bounded raffle
reads and commitment polling, consolidated background account reads, lighter pending
trade/Home/card projections, per-auction private caching, and reduced idle bot work
and gift-state payloads. Recovery, privacy and financial barriers remain in place.
See the [current handoff](HANDOFF.md:1) for verification and rollout status, and
[231 rollout notes](docs/SCOPED_READS_AND_QUERY_STATS.md:1) for the latest changes.
SQL 231 must precede the website release; the ignored bot ships separately.

Production impact and the reported peak-traffic incident still need measurement.
Use [complete statistics snapshots](scripts/query-stats-snapshot.sql:1) and the
[delta tool](scripts/queryStatsDelta.py:1) approximately 24 hours apart; cumulative
exports cannot reconstruct the last day. Correlate RPC latency/calls with database
waits/resources and Worker/bot telemetry. Do not reset counters or run financial-write
`EXPLAIN ANALYZE` on production. The [roadmap](ROADMAP.md:1) may contain completed items;
check code before starting another optimization.

## Secrets and documentation boundaries

Publishable Supabase keys belong in public build settings; service-role keys, KoL
passwords, SSH keys and invalidation signing secrets do not. Build/package scans
reject private material. `npm run security:install` installs the local staged-file
check; ignored paths do not remove already-committed secrets from Git history.

Primary documentation is this README, the bot/database READMEs, handoff and roadmap.
Keep the personal QUICKSTART_README unchanged unless explicitly authorized; the
current consolidation leaves it untouched. Obsolete phase documents have been
removed from the bot packaging list after consolidation.
