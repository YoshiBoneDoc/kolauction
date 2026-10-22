# kHub handoff for the next chat

Updated October 22, 2026. Start here, then inspect the relevant code before editing.
**The website is live and the bot handles real players' assets.** Older chat history
and historical setup notes are not reliable descriptions of current behavior.

## Read this first

- The user prefers direct action and short explanations in plain language. Explain
  where commands run: **Mac/IntelliJ terminal** versus **Ubuntu/Oracle terminal**.
  Avoid jargon and repeated permission questions for already-authorized work.
- Preserve small, precise design/copy requests. Do not redesign unrelated sections.
- **Do not update ROADMAP.md unless the user explicitly asks.** It is user-maintained
  and can contain completed or outdated tasks; confirm against code before acting.
- Use descriptive, project-relative IDE links, for example
  `[poll controls](src/components/HomePoll.jsx:1)`. Absolute paths reportedly do not
  navigate correctly in IntelliJ. Do not claim navigation was verified.
- Preserve existing edits and untracked files. Never reset, auto-commit, push,
  deploy, apply hosted SQL, or start a live bot merely as a verification step.
- New chats must distinguish **implemented locally**, **SQL applied by the user**,
  **website deployed**, and **Oracle bot upgraded**. These are separate operations.

## What runs where

Project: `/Users/adityayadav/Desktop/IntelliJ Projects/kolauction`.

| Piece | Location / reference | Hosting |
| --- | --- | --- |
| Website | [React/Vite app](src/App.jsx:1), [root package scripts](package.json:1) | Cloudflare |
| Accounts, auction transactions and financial ledger | [database documentation](supabase/README.md:1) | Supabase Auth + PostgreSQL |
| KoL middleman worker | [bot commands and operations](bot/README.md:1) | Oracle Ubuntu, Docker |

The bot is **kHub (#3888760)**. The owner/admin is **teres Minor (#3552305)**.
The server has been referred to as `khub-bot-network`; deployment directory is
`~/khub-bot`, Compose service `bot`, container `khub-bot`, login user `ubuntu`.
Confirm the current host/IP privately when needed; do not reuse an old chat's IP.

The whole **bot directory is deliberately gitignored**. Website Git pushes do not
update Oracle. A fresh website clone will not contain the bot. Do not force-add it.
Local bot changes require a separate bundle/upload/container rebuild for deployment.
The hosted website and Docker bot keep running when the laptop is off or SSH closes.
Only one KoL-connected bot instance may run: Oracle OR Mac, even in read-only mode.

## Documentation and migration workflow

- [Root orientation](README.md:1).
- [Website/database operations and migration notes](supabase/README.md:1).
- [Mandatory migration instructions](supabase/migrations/AGENTS.md:1) and
  [queue instructions](supabase/migrations/queue/README.md:1).
- [Bot command cheat sheet](bot/README.md:1), [deployment](bot/DEPLOYMENT.md:1),
  [recovery/operations](bot/OPERATIONS.md:1), [message examples](bot/MESSAGES.md:1).
- [Live item catalog](supabase/ITEM_CATALOG.md:1),
  [standalone catalog operations](bot/ITEM_CATALOG.md:1).

**New website migrations go in `supabase/migrations/queue/`.** The user runs SQL
manually, then moves successful scripts to the parent directory without renaming.
Do not move them for the user or rerun historical scripts indiscriminately.
Keep matching standalone copies directly in `bot/supabase/migrations/` (no queue).
Tests must resolve scripts from either website location.

At this handoff, scripts **through 076 are physically in the parent directory**;
the queue contains only its README. Under the user's convention this suggests they
were applied, but **this is not independent verification of hosted database state**.
The assistant has not run hosted migrations or deployed the website/bot.

Current local Git status still contains the latest poll changes, the new voter-list
component and untracked migration 076. Inspect `git status` before continuing; do
not assume the newest work was committed or deployed. Generated `build/index.html`
can also be modified; some build files were historically tracked despite ignores.

## Latest work: polls (075–076)

The current seeded question is exactly:

> Should sellers have the option to end auctions early if they’re happy with the current bid?

- Logged-in, unrestricted users see a large yellow banner at the homepage bottom
  before voting. **One immutable vote per account per poll** is enforced in SQL,
  including opposite simultaneous submissions and retries. New polls allow new votes.
- **Latest requirement supersedes the original disappear-after-voting behavior.**
  After voting, show live Yes/No totals and percentages in a subtle yellow box,
  aligned bottom-left within the homepage content, including on return visits.
- Refresh while visible every 30 seconds and on focus; do not restore voting from
  an older background response. Failed results refresh must not enable voting again.
- Guests see no poll/results. Ordinary users never receive voter identities and do
  not receive active totals until they have voted.
- Admins see live totals and can expand **View voters** for usernames grouped by
  Yes and No, both on the homepage and in the poll manager. This uses a separate
  database-authorized endpoint; hiding a frontend control is not authorization.
- `/admin/polls` is linked from the admin inbox and homepage banner. It supports
  private editable drafts, publishing later by button, concluding a poll, and an
  atomic **Conclude current & publish** action. Only one poll can be live.
- Drafts are not scheduled automatically. The admin publishes when ready.
- Concluding freezes totals in a permanent snapshot. Previous polls/results remain
  in the admin archive; closed polls cannot reopen and live questions cannot change.
- Admins can publish/hide concluded aggregate results alongside the next homepage
  poll. Ordinary viewers only see those archived results if explicitly published.
  Concluding an unpublished poll removes its ordinary live-results box.
- Archived totals survive later account/vote cleanup. Voter lists reflect accounts
  and vote records still on file; names are not part of published summaries.

Relevant implementation:
[homepage banner](src/components/HomePoll.jsx:1),
[aggregate display](src/components/PollResults.jsx:1),
[private voter lists](src/components/PollVoters.jsx:1),
[admin manager](src/pages/AdminPolls.jsx:1),
[RPC service](src/lib/polls.js:1),
[poll schema/management](supabase/migrations/202610220075_homepage_poll.sql:1),
[live totals and private voter RPC](supabase/migrations/202610220076_live_poll_results.sql:1).
Migrations 075/076 do not require a bot rebuild or restart.

## Recent auction/UI work to preserve

- [Shared navigation](src/components/AuctionNavigation.jsx:1) appears across pages.
  No duplicate Back/Home headers. Active links are darker red with glow, **not bold**.
  Navbar links/buttons have **no outline in any focus state**; keyboard focus uses
  text color/glow. Wall of Shame retains its own background behind the navbar.
- [Homepage carousel](src/components/PopularAuctions.jsx:1) cycles left-to-right
  through every active listing before repeating, with no duplicate DOM cards.
  Pause/hover/keyboard/reduced-motion behavior and saved position on return matter.
  Session storage contains only carousel IDs/progress, not private auction data.
- Homepage cards have larger sprites, **Bid/Min above the largest price text**, a
  trade badge centered between the price section and aligned countdown, and uniform
  dimensions. Do not turn them into All Auctions cards again.
- [All Auctions](src/pages/AllAuctions.jsx:1) has a three-column compact grid,
  two columns on tablets, one on mobile. Keep fixed card geometry when bidding opens;
  only one inline form opens at a time. No modal bidding.
- The toolbar uses **36px-high** controls. Search/status labels are visually hidden
  but retained for accessibility. Ending Soon / Newest / Recent Activity share one
  segmented outline; Most Bids and Price sit beside them with 20px, 2.5px-stroke
  chevrons, 8px label gap, both directions when neutral and one when selected.
- Sorts are mutually exclusive; Escrow/Direct are independent persistent toggles.
  Their final selected color is **light blue**, off is neutral white. My Auctions,
  status, search and trade filters combine and reset pagination. Ending Soon is default.
- Sorting/filtering runs **before database pagination**. Recent Activity means latest
  accepted bid, not creation time; unbid auctions come last. Bid count is total valid
  bids, not unique people. Do not sort/filter only the loaded page.
- Trade badges use shared styling via
  [TradeTypeBadge](src/components/TradeTypeBadge.jsx:1). Avoid page-specific palette drift.
- Hot 🔥 markers on compact cards use top `ceil(10% × active_count)` bid-count ranking
  across the entire live pool, independent of filtering/pages. Zero-bid auctions do
  not qualify; expired/held/restricted-seller listings do not enter the live pool.

References: [card layout](src/components/CompactAuctionCard.jsx:1),
[browsing helpers](src/lib/auctionBrowsing.js:1),
[route-backed reads](src/lib/auctionRefresh.js:1),
[storage/mapping](src/lib/auctions.js:1),
[global styling](src/index.css:1).

## Auction rules and financial behavior

### Escrow

Seller sends `LIST <auction number>` with exact items. Accepted deposits start the
full auction timer. Bidders send `BID <auction number>` with their **full** bid in
Meat. Prior leading bids and rejected/excess attachments are returned. Buyouts end
bidding; payout/item deliveries are separate recorded obligations.

[Migration 074](supabase/migrations/202610220074_unfunded_escrow_expiry.sql:1) expires
unfunded drafts **24 hours after creation**. Bot ticks, website finalization and
intake clean them up; late deposits are returned exactly once. Processing time,
not KMail sent time, decides acceptance. Active/funded auctions are untouched.
If a draft has linked support/audit/ledger history, cancel it instead of deleting
those records. Seller-facing deposit instructions explain the deadline.

Early access limits the **starting/minimum bid** for new escrow listings to 1M
Meat; do not accidentally cap subsequent bids/final prices at 1M. Displayed early
access loss protection is up to 1M per affected user for verified system-caused loss.

Current fees are **marginal tiers**, not the old flat 7.5%:

| Portion of final sale price | Commission |
| --- | --- |
| First 1m | 5% |
| Next 9m | 4% |
| Next 90m | 3% |
| Next 900m | 2% |
| Above 1b | 1% |

Sum tier charges with integer arithmetic, then round down once. A 10m sale costs
410k and pays the seller 9.59m. Direct/unsold/cancelled sales have no commission.
Preserve historical/frozen fees and special discounts; never retroactively rewrite
queued payments. PostgreSQL computes actual settlement; frontend helpers estimate.
See [fee helper](src/lib/escrowFees.js:1) and
[fee migration](supabase/migrations/202610210069_tiered_escrow_fees.sql:1).

### Minimum bid increases — both trade types

| Current highest bid | Required increase | Round increase up to |
| --- | --- | --- |
| Below 1k | 10 | — |
| 1k–under 10k | 100 | — |
| 10k–under 100k | 1k | — |
| 100k–under 1m | 10k | — |
| 1m–under 10m | 3% | 10k |
| 10m–under 100m | 2% | 100k |
| 100m–under 10b | 1% | 500k |
| 10b+ | 0.5% | 500k |

Bracket comes from the **existing highest bid**. Round the required increase up,
then add it. Use exact integer/BigInt/numeric math across UI, SQL and bot replies.
First bid meets the seller floor; exact calculated minima are valid; buyouts are
exempt and may be below an ordinary next increment. Example: 1.75m → minimum 1.81m.
See [shared frontend calculation](src/lib/bidIncrements.js:1) and
[SQL rules](supabase/migrations/202610220071_hybrid_bid_increments.sql:1).

### Direct trades, reports and feedback

Direct auctions are implemented, not a proposal. Bids happen on the website;
players exchange in-game within 48 hours unless they agree otherwise. Both submit
completion/incomplete responses. **Trade completion and optional thumbs feedback
are separate systems.** Do not turn negative feedback into an incomplete trade.

Completed profile counts wait for both parties' completion/resolution. Incomplete
marks count only after the 48-hour grace period; administrator-excluded reports
must not count against the target. Dismissing a report or resolving a support ticket
alone does not prove the trade happened or grant a completed-trade point. Inspect
current SQL before changing these rules; multiple migrations refine them.

Support queries work for Direct and Escrow participants, with grouped admin threads.
Banned users get a restricted login/appeal screen, optional image evidence, and
server-side permission checks. Admin ban controls account for existing auction
obligations; hiding a page is not a substitute for database ban enforcement.
The admin can view bidder/seller identities; regular users retain active-bid anonymity,
and guests/restricted users do not get player names. See the
[Info page](src/pages/InfoPage.jsx:1) for current user-facing rules.

## Accounts, catalog and bot gotchas

- New accounts/recovery use **REGISTER** and **CREDENTIALS** / **FORGOT LOGIN** KMail,
  not public email signup. One linked account per KoL player; temporary credentials
  arrive by KMail.
- **Legacy email/username code is retained for reference only**, potentially for a
  different future project. Do not enable, extend, migrate or repair those old
  flows for kHub. The owner confirmed that **all legacy accounts were testing
  accounts and were deleted before launch**. There are no remaining legacy users
  to support, migrate or recover. Do not flag legacy email password recovery or
  confirmation-email resend as outstanding work or a launch risk.
- Account requests are durable. One initial attempt + two immediate retries, then
  five-minute spacing for later attempts. Account work is time-bounded and must not
  permanently block auction finalization/deliveries. See the bot README for current
  failure notices and retry details; do not reset reserved account secrets on retries.
- The maintained KoLmafia catalog supplies items/images and tradeability. Bot refreshes
  weekly, keeps the last valid snapshot on failure, and retries later. Both UI and
  SQL reject untradeable listings. Catalog sync does not require weekly redeploys.
- Delivery IDs (`D-…`), closet IDs (`C-…`), auction numbers and full UUIDs are different.
  Use lookup to find a specific message's recipient, assets and actual reference.
- A blocked/preparation-failed message is set aside; unrelated funded messages continue.
  Interrupted/uncertain sends use automatic Sent Mail checks when possible, then
  isolate and alert the admin rather than blindly resend. Closet transfers can defer
  while uncertainty remains. Never mark a delivery sent just to silence logs.
- `resolve ... sent` records success; **it does not send/check anything**. Require
  actual matching evidence or a genuinely confirmed manual refund. Missing Sent Mail
  alone is not proof of failure, especially for gifts. Never reuse example IDs/evidence.
- Hardcore/Ronin recipients receive gift-shop packages, using a fresh recipient check
  or an explicit normal-mail restriction rejection. Unknown failures/timeouts do not
  justify another send. Wrapping uses spare bot funds, not held player obligations.
- Gift notes use ` | ` instead of newlines to avoid the game's stray `nn` rendering.
  Regular KMail keeps normal paragraph formatting. All incoming gift packages are
  donations; normal invalid funded mail is refunded. Unsupported unfunded/system
  mail may remain untouched for manual review; that log is not itself a stopped bot.
- Historical log lines persist across restarts. Use fresh logs and current inspection
  before claiming an old incident is still active. Some earlier incidents were fake
  prelaunch trades; **current live transactions must not be treated as disposable**.

## Verification and operating commands

From the **project root**:

```bash
node --test tests/*.test.mjs
npm run build
python3 tests/database_test.py
python3 tests/polls_database_test.py
```

Other focused SQL suites cover escrow expiry, hot ranking, hybrid increments and
fees. They create disposable **local PostgreSQL** databases via `pg_config`, `initdb`,
`pg_ctl`, `psql`; they never apply hosted SQL or send KoL messages. Local server/socket
and Chrome tests may need sandbox escalation. Start long commands with a 10-second
yield and poll their session; do not start a real bot to test frontend/SQL changes.

Latest completed verification: **233 frontend tests**, production build, full local
DB regression, focused poll lifecycle/privacy/concurrency/upgrade tests, and mocked
Chrome tests for post-vote geometry, refresh, admin names, archives and guest privacy.
The bot JavaScript suite was last reported at 136 passing tests in earlier work;
it was not rerun for these UI/poll-only changes. Use Node **24+** for bot tests/runtime.
Targeted ESLint passes; the repo emits an existing `.eslintignore` deprecation warning.
Temporary browser harness/logs may still exist under `/private/tmp/kolauction-browser-check/`
and `/private/tmp/khub-live-polls-*`; they are disposable, not tracked project assets.

On **Ubuntu**, from `~/khub-bot`:

```bash
sudo docker compose ps
sudo docker compose logs --since=1m -f
sudo docker compose exec bot npm run inspect
sudo docker compose exec bot npm run health
```

Ctrl+C in the **Docker log viewer** only exits viewing. Ctrl+C in a **local foreground
`npm start`** stops that local bot. `inspect` checks the shared ledger; `health` checks
that runtime's supervisor. Neither is proof that every delivery succeeded.

For a deliberate server restart use `sudo docker compose restart`; source updates
need upload/extraction then `sudo docker compose up -d --build`. Environment changes
need recreation, following the bot deployment guide. Do not rebuild/restart for
migration 075/076 alone. The top of the bot README contains lookup/reconciliation
and bundle commands; prefer it over improvising financial corrections.

## Credentials, backups and remaining uncertainty

Never print or copy secrets from website environment files, `bot/.env`, `bot/keys/`,
SQL dumps or private mail. Browser publishable configuration is not a service-role
key. Keep the ignored bot and credentials in separate private backups. The ignored
`khub-backup_10-21-2026` directory contains private database backup material.

Do not assume the current Oracle container has every local worker change or that
the last website build is deployed. Check status without disturbing the live worker.
No remote deployment, hosted SQL execution, live sends or financial reconciliation
was performed as part of this handoff. Remaining feature/audit items belong to the
user's roadmap; verify each against code before proposing it as unfinished work.
