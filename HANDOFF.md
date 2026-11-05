# kHub handoff for the next chat

Updated November 4, 2026 for the raffle handoff; older performance context is retained.
Read this before proposing work, then inspect the relevant code. The website is live; the Oracle bot holds real players’ Meat and items.

## Working standards

- Lead with the answer or exact command requested. Keep explanations brief and
  concrete. If asked for a command, provide the command without a lecture.
- Label commands **Mac** or **Oracle/Ubuntu**, and state the working directory
  when needed. Give complete, copyable commands; never reuse an incident’s IDs
  or evidence as if they applied to another transaction.
- Inspect before diagnosing. Separate confirmed findings, hypotheses, defensive
  hardening, and unverified production state. Do not invent a real-world example
  to justify a hypothetical edge case. Say when evidence is missing.
- Preserve precise UI/copy requests. Make the smallest relevant change; avoid
  unrelated refactoring, features, optimizations, or policy changes.
- Continue authorized work through implementation and appropriate verification.
  Avoid repeated permission questions. Do not deploy, apply production SQL,
  restart the live bot, or send real assets as a test.
- Preserve existing edits and untracked files. Do not reset, auto-commit, or push.
- **Do not edit `bot/QUICKSTART_README.md` unless the owner explicitly requests
  that guide change.** It is the owner’s personal command guide; its contents and
  order are not generated from other documentation. See [project instructions](AGENTS.md:1).
- Update this handoff or the roadmap only when requested. Roadmap entries should
  be short, unfinished tasks, not a history of completed work or speculative bugs.
- Use descriptive project-relative code links, such as
  [delivery processing](bot/src/worker.mjs:1). IntelliJ absolute-path navigation
  has been unreliable; do not claim links were verified.

## Current implementation and orientation

- Start at [routing](src/App.jsx:1), [authentication](src/context/UserContext.jsx:1),
  [auction provider](src/context/AuctionsContext.jsx:1) and [RPC service](src/lib/auctions.js:1).
  Browse filters, sorting, totals and pagination are database-backed, not a full
  client-side auction dataset. The memory cache retains separate resources per
  authorization scope; browsing preferences are separate from private data.
- Cloudflare has two Workers: [website runtime](workers/site/index.js:1) serves
  Vite assets and four API routes; [cache runtime](workers/public-auction-cache/index.js:1)
  uses named Durable Objects for shared public snapshots. Browser JWTs/cookies
  never enter the shared listing transport. Private context and writes go to Supabase.
- Shared paths include Home, eligible browse/seller lists, featured giveaway,
  banner and public detail static/live state. Detail pages also read private
  context/bid history; they are not wholly cached. Ignore relationships and private
  filters can select direct reads. Writes refresh authoritative data.
- Implemented: Sell/Buy/Bundle listings, Direct and Escrow settlement, KMail
  registration/recovery, feedback withdrawal and moderation inboxes, bans/appeals,
  seller profiles, trade totals, multi-select polls, player ignores, admin analytics,
  site activity, and giveaways with Last Bid/Random Draw/Split/Surprise Me conditions.
  Use [giveaway notes](README.md) for condition and funding constraints.
- Current local SQL extends through 202. Prefixes including 150, 151, 160, 167
  and 199 have multiple filenames: use full filenames and prerequisites. Raffle
  migrations 197–202 currently sit in the parent directory; the queue has no SQL.
  File location alone does not verify the production schema or deployed runtime.

## Recent focus: raffle backend (activation disabled)

- Admin creation, preview/detail pages, management UI and private personal ticket
  counts/history are implemented. Public data exposes the winner and selected
  prize, never ticket totals, other players' holdings or revenue. Reads are bounded;
  management refresh is explicit. See [raffle pages](src/pages/Raffles.jsx:1).
- `RAFFLE <uuid>` buys tickets with an exact positive multiple of the ticket price.
  Repeat purchases are supported; durable receipts prevent duplicate processing.
  Payments processed at/after closing are refunded, even if sent before closing.
  [Gift intake](bot/src/incoming-gifts.mjs:10) recognizes RAFFLE/SUPPLY in the outside
  note and preserves verified acquisition proof, sender identity and deduplication.
  Existing outbound gift fallback supports Hardcore/Ronin, with wrapping funded
  only from spare bot Meat. Inside-note commands never execute.
- `SUPPLY <uuid>` accepts optional, partial/repeated listed-item deposits from the
  current admin/raffle owner. It is item-only: Meat rejects the whole request and
  returns all attachments via ordinary refunds. No automated Mall purchasing,
  PURCHASE command or active Meat-contribution accounting remains.
- Closing freezes private inputs; [secure drawing](bot/src/raffle-draw.mjs:1)
  selects one equally weighted ticket and independently one weighted prize.
  Draw persistence, queue identities and settlement are restart-safe. Deposited
  prizes deliver automatically; missing prizes are acquired manually and supplied.
- `ADVANCE <uuid> <amount>` (whole Meat or shorthand such as `200m`) and the UI
  commit advances against available ticket proceeds, including pending/unknown
  advances. Shared financial locks prevent concurrent overcommitment. Over-limit
  KMail replies include the actual balance (200m against 140m is rejected).
- Raffle reserves enter shared liabilities; reserve-to-queue changes are atomic.
  Verified prize delivery precedes unused-item returns; verified returns/advances
  precede final net payout. Cancellation refunds tickets; canceled/empty raffles
  return deposits. Unknown sends never automatically resend or release settlement.
- [Latest KMail templates](supabase/migrations/202611040202_raffle_kmail_wording.sql:1)
  identify the raffle and transaction. Tickets show purchase count/range and equal
  chances; winners receive congratulations and a 30-minute closing-time target.
  Missing-prize notices include items, SUPPLY, available advances and ADVANCE.
  Genuine delay notices occur only after 30 minutes. Persisted keys prevent
  duplicate winner/delay notices, including across restarts.
- SQL: 197/198 preview/schema/odds; 199 backend and hard-disabled activation gate;
  200 manual fulfillment, advances, gift-proof fence and contribution removal;
  201 fulfillment notices; 202 wording. Matching bot copies are packaged separately.
  The worker requires raffle capability version 2 from 200; 199-only databases
  pause raffle processing while ordinary auction work continues.
- Prior local verification passed focused Node/gift/message tests on Node 24,
  website build/targeted lint, and [full-schema lifecycle/isolation tests](tests/raffle_lifecycle_database_test.py:1).
  Coverage includes identical-item escrow/Buy/other-raffle reserves, exact balances,
  concurrent bids/advances, verified gifts, replay, rollback, restart, uncertainty,
  notices, cancellation and zero tickets. Giveaway/relisting regressions also passed.
  These are historical offline results with simulated transfer evidence, not live
  delivery proof; no tests were run for this handoff update.

## Deployment and verification

- Website production settings: `npm run build:cloudflare`, then
  `npx wrangler@4 deploy --config wrangler.jsonc --keep-vars` in the existing
  Cloudflare Git integration. This build defaults shared caching to true; plain
  `npm run build` does not. `/khub-build.json` exposes the compiled flag.
- GitHub's [workflow](.github/workflows/deploy-cache-worker.yml:1) validates website
  routing/privacy and dry-runs the website, then deploys **only the cache Worker**.
  Supabase SQL and Oracle bot deployment remain manual and separate.
- Apply required SQL before dependent runtimes. Match Worker bindings and Supabase
  public credentials using [deployment setup](docs/CLOUDFLARE_SITE_DEPLOYMENT.md:1).
  No deployment or production SQL was performed in this documentation audit.
- Relevant local checks: `npm run build`, `npm run lint`,
  `node --test tests/*.test.mjs`; database suites under `tests/*database_test.py`
  use isolated PostgreSQL. Bot tests use its own package scripts and Node 24+ (`.nvmrc` is 24).
  The shell may still select Node 22; use installed Node 24 for bot tests requiring
  `node:sqlite`.
  Run checks appropriate to code changes; historical passes are not a current run.

## Earlier priority: traffic reliability (retain for follow-up)

The owner reports giveaway traffic still causes slow/erroring loads after caching
improvements. Supplied cumulative query exports identify expensive private reads:
card context ~406 ms average, detail context ~238 ms, authenticated auction-page
variants ~250–332 ms; public Home ~684 ms and browse ~376 ms. Public live detail
state averages ~9 ms. These are collection-period figures, not a giveaway timeline
or proof of CPU saturation. Account and bot polling add substantial call volume.

Next: inspect private projections and bid-history work, obtain targeted plans,
correlate historical resource charts/cache error logs, then optimize and measure.
Preserve financial authorization and privacy. The cache has bounded queues,
origin deadlines and cooldowns; do not increase limits blindly. Routes are now lazy-loaded in [App](src/App.jsx:5), and the listing editor
loads the catalog dynamically. The catalog remains large; do not repeat the old
claim that it is statically imported into the initial bundle. Use the [performance diagnostics](README.md#performance-investigation).
A quiet database-pressure snapshot cannot reconstruct an earlier traffic spike.

## Runtime and deployment boundaries

- Website: React/Vite on Cloudflare. Database/Auth: Supabase PostgreSQL/Auth.
- Bot: separate Node worker on Oracle Ubuntu/Docker, directory `~/khub-bot`,
  Compose service `bot`, container `khub-bot`. KoL identity: **kHub (#3888760)**.
  Owner/admin: **teres Minor (#3552305)**.
- `/bot/` is deliberately gitignored and has no local Git repository. A website
  commit/build does **not** identify or update the Oracle bot. Do not force-add it.
  A verified last-working bot version has not been established from Git.
- Distinguish **implemented locally**, **tested locally**, **SQL applied by owner**,
  **website deployed**, and **Oracle image rebuilt/restarted**. Never infer one
  from another. Files in the migrations parent directory are not independent
  proof of production schema state.
- Only one KoL-connected worker may run. Database-only CLI `inspect`/`lookup`
  commands are safe alongside the worker; they do not start another inbox loop.
- Read [migration rules](supabase/migrations/AGENTS.md:1): new website SQL goes in
  `supabase/migrations/queue/`; matching standalone copies go directly in
  `bot/supabase/migrations/`. The owner applies SQL and moves successful scripts.
  Check both locations rather than relying on old documentation paths.
- Never expose `.env`, keys, account credentials, private backups, or raw player
  messages. Preserve ignored bot/backups; their existence is not proof of a
  complete, tested off-device backup strategy.

## Financial safety and failure isolation

- Numeric player IDs are authoritative recipients. Preserve exact integer
  amounts, receipt deduplication, atomic transactions and server validation.
- Keep the global financial advisory lock for genuine financial operations.
  Do not restore financial finalization to ordinary website browsing.
- One failed KMail, delivery, gift or account operation must not block unrelated
  users. Preserve existing isolation, retries, recovery and administrative tools.
  Legitimate insolvency/uncertain-intake/incomplete-scan safety stops are different;
  do not bypass them to make a queue appear healthy.
- Unknown sends must not automatically resend. Missing Sent Mail alone is not
  proof of non-delivery, particularly for packages. `resolve … sent` records
  success; it neither sends assets nor independently verifies the transfer.
- Stop workers before manual KoL sessions or financial reconciliation. Log out
  the manual session before resuming one worker. Prefer the owner’s existing
  [command guide](bot/QUICKSTART_README.md:1) over invented recovery commands.
- Settlement, winner items and seller payouts are separate tracked obligations.
  Preserve frozen fees, anti-sniping, receipt-time deadlines and refund accounting.

## Next Steps / Important Notes

- Keep raffles disabled. The database gate has a CHECK preventing activation;
  enabling requires a separate, explicitly reviewed migration after readiness review.
- Verify exactly which SQL revisions the owner applied and which website/Oracle
  runtimes are deployed. No deployment, production SQL, live-worker start or real
  asset transfer was performed by Codex during the raffle work. Apply prerequisites
  before dependent runtimes; separately bundle/rebuild the ignored Oracle bot.
  Do not rerun already-applied scripts; use incremental SQL if revisions differ.
- Migration 200 refuses legacy contribution records rather than deleting obligations;
  any such data needs reconciliation before upgrading. The overview in
  [raffle notes](docs/RAFFLE_BACKEND.md:1) contains older queue-location references;
  current migration files and runtime code take precedence.
- Manual management-UI/deployment review and actual production-version verification
  remain outstanding. Offline tests cannot guarantee KoL behavior or delivery within
  30 minutes. Rollover pauses shared transfers; closing/30-minute deadlines do not
  shift. Never bypass uncertain-send verification or run another connected worker.
- Preserve unrelated existing edits/untracked files. Continue focused work only;
  do not rewrite the owner's quickstart or treat older traffic tasks as a new audit.

## Verification boundaries

Use existing focused Node/browser and isolated PostgreSQL tests for relevant changes.
Never start a live worker or send real assets as a test. Historical suite counts
are not a current verification result or production capacity measurement. Missing
original incident payloads mean some fixtures are constructed, not captured mail.

Primary references: [website](README.md), [bot](bot/README.md),
[database](supabase/README.md), [deployment](docs/CLOUDFLARE_SITE_DEPLOYMENT.md),
[remaining work](ROADMAP.md). Do not regenerate the personal quickstart guide.
