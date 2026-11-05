# kHub handoff for the next chat

Updated November 5, 2026 with implemented website and bot performance work through migration 230. Older investigation and raffle context is retained below.
Read this before proposing work, then inspect the relevant code. The website is live; the Oracle bot holds real players’ Meat and items.

## Latest implementation: website and bot performance (November 5, 2026)

The owner subsequently authorized and Codex implemented the performance work below.
The earlier investigation-only restriction is historical. Read current code before
proposing another optimization; several earlier recommendations are now complete.
**Next priority:** verify installed SQL and deployed versions, complete the separate
rollouts as needed, then measure ordinary/peak traffic. No production capacity
benchmark or outage root cause has been established.

### Website read pressure: migrations 228 and 229

- [Commitment polling](src/lib/raffleCommitmentRefresh.js:1) now has serialization,
  hidden-page pausing, jitter, exponential failure backoff and focus cooldowns.
  [Shared commitment transport](functions/api/public-raffle-commitment.js:1) uses
  the existing bounded cache class through a separate named object, with five-second
  snapshots and no stale fallback. It exposes only public commitment metadata and
  completion, never names, holdings, totals, manifests, proof or browser credentials.
  Private fairness status is cached for a minute; full proof remains opt-in.
- [Raffle reads](src/lib/raffleReads.js:1) reuse the bounded auction memory cache
  with token scoping, coalescing, two request slots and failure cooldowns. Lists,
  details, personal counts and history reuse successful reads for fifteen seconds;
  management changes invalidate cached data and force authoritative refreshes.
- [Account loading](src/lib/auth.js:75) reads administrator/raffle permissions and
  pending invitation status in the existing account-access RPC after 228. Older
  schemas retain permission-read fallback. Personal ticket history uses a new
  fifty-receipt page RPC, preserves exact totals, private ticket label offsets and
  refund status, and has a player-leading purchase index. The old RPC is retained.
- [Pending trades](src/components/PendingTrades.jsx:36) show a lightweight count
  while collapsed (two-minute cadence); full twelve-card pages load only when
  expanded and refresh every thirty seconds. SQL derives the count predicate from
  the installed full reader, preserving eligibility without building card projections.
- Shared detail pages refresh active private context every sixty seconds, closed
  private detail every 120 seconds and unpublished drafts every thirty seconds.
  Closed detail polling is sixty seconds. Public live price/deadline verification,
  status transitions, authorization scoping and post-write reads remain in place.
- [Confirmed bids](src/lib/confirmedBid.js:1) return without waiting for display
  reconciliation. The selected page refreshes authoritatively without also fetching
  pending trades; the form shows refresh progress and blocks repeat submission
  during successful-bid reconciliation. Failed/uncertain writes are never retried
  automatically. Other trade actions retain their reconciliation behavior.
- [Cross-tab account refresh](src/lib/coordinatedRefresh.js:1) shares only hashed
  resource keys, timestamps and opaque change signals. Each tab performs its own
  initial/focus/explicit reads; periodic followers independently recheck within
  five minutes. Storage/Web Locks failures fall back locally. Account reads have
  a twelve-second deadline. Administrator UI reuses the account's verified flag.
- Presence heartbeats run at ninety seconds with backoff/jitter and the existing
  cross-tab coordination; admin counts cover three recent minutes. They pause in
  [browser busy mode](src/lib/trafficPressure.js:1), which slows optional polling
  after repeated slow/failed display reads and recovers with hysteresis. Live
  auction refreshes, authoritative writes, financial locks and Worker limits are
  unchanged. Busy mode is a local pressure hint, not proof of database saturation.
- Diagnostics include safe Worker origin/queue timings and the read-only
  [traffic snapshot SQL](scripts/traffic-diagnostics.sql:1). Current SQL already
  has inlineable visibility, maintained bid counts and keyset bid-history pages;
  do not recreate these or add speculative indexes. Migration 227's narrow
  history/activity changes were already present and left untouched.

Website details and rollout: [read-pressure notes](docs/TRAFFIC_READ_PRESSURE_ROLLOUT.md:1).

### Bot work scheduling: migration 230

- The ignored [worker](bot/src/worker.mjs:105) retains responsive inbox intake and
  fresh solvency checks before transfers. It reads fresh safety state every cycle,
  retaining only versioned capabilities for up to ten minutes (or until revision
  changes). Invalid safety/plan responses stop processing; cached safety is never
  used. Full diagnostics remain available through existing inspection commands.
- A fresh post-intake plan combines delivery/Buy discovery and task hints. Dispatch
  discovery is refreshed after maintenance; only an unchanged same-cycle hint is
  reused. Hints never authorize a send. Auction maintenance runs for due/settling
  auctions or new intake, otherwise once a minute. Idle closet work is spaced by
  a minute, expedited by intake/dispatch work. Optional announcement/reminder
  checks are spaced by a minute and yield to backlogs; notifications may be delayed.
- Raffle state/supply/delivery changes append private wakeups without taking
  financial/account/parent row locks. No-op updates do not append work. Waiting
  work retains a sixty-second reconciliation fallback and the thirty-minute notice
  boundary. Due-only draw selection excludes deferred manifests before loading
  payloads, while retaining installed intake/grace/fairness barriers. Beacon
  failure backoff persists across restart (5, 10, 20, 40, then sixty seconds),
  without changing the committed round or input hash.
- Refunds/item returns use a **transaction-wide fifty-record budget**, across at
  most ten raffles and at most twenty item returns per raffle. Existing message
  splitting may create multiple deliveries per record. Each batch atomically
  reduces the exact raffle reserve and creates deduplicated queue liabilities;
  unprocessed records keep their reserves. Partial batches remain due. Verified
  prize/return/advance/refund barriers still gate final settlement. No parallel
  connected sender, automatic uncertain-send retry or financial-lock removal.
- [Bot telemetry](bot/src/performance.mjs:1) emits bounded `[BOT_PERFORMANCE]`
  minute aggregates: worker RPC/cycle counts, errors, empty results, elapsed times,
  latency buckets, completed phase durations, yields and oldest pending-delivery
  age. No payloads, recipients, credentials, raw errors or PostgreSQL telemetry
  writes. Separate market/catalog and operator calls are outside these aggregates.

Bot details and rollout: [bot scheduling notes](docs/BOT_WORK_SCHEDULING_ROLLOUT.md:1).

### Verification and deployment boundaries

- Website validation in this session: **185 focused JavaScript tests**, Cloudflare
  build and changed-source lint passed (existing context-export warnings remain).
  The broader website suite still has pre-existing failures; comparison runs found
  no newly failing tests from this performance work. Full lint also picks up
  generated build files. These are recorded results, not new checks for this edit.
- Bot validation: **443 offline tests passed on Node 24.22.2**. The isolated
  full-schema PostgreSQL lifecycle suite passed, including a 110-purchase
  cancellation, exact partial liabilities, rollback, concurrent ticks, restart,
  wakeups, service-only access and unchanged deferred commitments. Transfers use
  simulated evidence; these tests do not prove real delivery timing or capacity.
- Local paired plans showed less work for the pending summary than the full reader
  on small fixtures. Do not extrapolate those timings to production peak traffic.
- Current website files: migrations [227](supabase/migrations/202611050227_narrow_detail_history_reads.sql:1),
  [228](supabase/migrations/202611050228_raffle_read_pressure.sql:1) and
  [229](supabase/migrations/202611050229_background_read_efficiency.sql:1) are in the
  parent directory; [230](supabase/migrations/queue/202611050230_bot_work_scheduling.sql:1)
  remains queued. Matching standalone SQL is under `bot/supabase/migrations/`.
  **Locations do not verify installed definitions.** Do not move or rerun files on
  the owner's behalf; verify prerequisites and apply each script only once per DB.
- Website sequence: required SQL through 229 → cache Worker → website Worker/assets
  built with `npm run build:cloudflare`. Bot sequence: SQL through 230 → separately
  bundle/rebuild the Oracle bot using the owner's guide. The bot-only release does
  not require another website deployment. A website push never ships ignored bot
  changes. Future capability changes must update both safety/full status revisions.
- Codex did not apply production SQL, deploy, start/restart the live bot, send real
  assets, commit or push during this work. The owner may have performed separate
  actions; verify runtime state directly. Preserve existing edits, backups, single
  worker operation and the personal quickstart. Handoff/roadmap changes remain
  owner-requested only; this handoff update was explicitly requested.

## Historical investigation: heavy-traffic regression audit (November 5, 2026)

This was an investigation-only audit. It changed no code, configuration, database
state or deployments; its documentation was separately authorized. The owner later
authorized the implementation summarized above. Treat the findings below as the
pre-implementation baseline, not as a list of entirely unfinished work. Keep
`bot/QUICKSTART_README.md` unchanged.

The owner reports that the site was very fast under heavy traffic after extensive
optimizations roughly two days earlier, but subsequently became unresponsive
around intense last-second participation in a popular “raffle.” Clarify whether
this meant an ordinary website auction/giveaway bid or a `RAFFLE` ticket purchase
via KMail: those have different intake/write paths. Do not treat the reported event
as confirmed database CPU saturation or a demonstrated lock incident.

### Evidence and deployment boundaries

- The supplied screenshot showed “Public listings are temporarily busy” and
  unavailable live auction data, rather than the React render-error fallback.
  The owner subsequently identified timeout errors in PostgREST calls to the
  six-argument `read_auction_page`, `read_auction_detail_static`, and
  `read_auction_bid_history(p_id,p_known_revision)`. The pasted SQL identifies RPCs;
  it supplies neither actual parameter values nor plans, elapsed times, wait events,
  traffic counts, or proof of whether execution or lock waiting consumed the time.
- Compared the November 3 baseline `3e3b507` with current HEAD during the audit.
  The core files `src/context/AuctionsContext.jsx`, `src/lib/auctionRefresh.js`,
  `src/lib/publicAuctionReader.js`, and existing shared-cache Worker paths showed
  no recent feature changes across that comparison. Thus do not assume the shared
  auction cache itself was recently disabled or rewritten. New raffle paths add
  traffic outside its protection.
- Local code, Git history, migration locations and historical offline test passes
  do not identify deployed Cloudflare code, installed Supabase definitions, or the
  ignored Oracle bot image. Verify all three separately. The older activation,
  schema-version and “raffles disabled” descriptions elsewhere in this handoff are
  historical context, not a fresh verification of current runtime state.
- At audit start/end the working tree already contained changes to
  `tests/auction_detail_cache_database_test.py` and the untracked parent-directory
  `supabase/migrations/202611050227_narrow_detail_history_reads.sql`. They were left
  untouched. Recheck current status and file locations; do not reset or relocate
  the owner's files. Matching bot SQL is managed separately.

### Prioritized findings and recommended fixes

1. **High priority: direct commitment polling amplifies closing-time traffic.**
   Confirmed in [commitment refresh](src/lib/raffleCommitmentRefresh.js:1): direct
   Supabase summary reads repeat every five seconds after closing; failed reads
   retain that cadence without exponential backoff or jitter. Focus can trigger
   immediate reads without a cooldown. A pending draw keeps polling until complete;
   hidden pages pause, requests are serialized within each watcher, and completed
   draws stop. There is no cross-viewer coalescing. Illustrative only: 500 visible
   pages at five-second intervals could generate roughly 100 summary RPCs/second;
   this was not measured during the incident.
   **Fix:** reuse existing backoff/jitter and focus throttling; coalesce/cache safe
   commitment metadata through the existing Worker architecture. Preserve access
   checks for private status/tickets and keep full proof reads explicitly opt-in.
   Expected impact high during concentrated raffle traffic; complexity low–medium;
   risk low if metadata and private scopes stay separated.

2. **High priority: newer raffle reads bypass auction caching/coalescing.**
   [Raffle details](src/pages/Raffles.jsx:22) query `mystery_raffles` and prizes
   directly, alongside `read_my_raffle_tickets`; [Home/browse raffle listings](src/hooks/useHomeRaffles.js:17)
   and personal counts also use direct Supabase reads. Reads are bounded but repeated
   mounts/navigation/manual refreshes repeat them without the auction reader's
   authorization-scoped retained cache.
   **Fix:** reuse the existing scoped client cache for private totals/history and
   short-lived raffle snapshots. Share only explicitly safe data through existing
   cache machinery; do not put club-only names, private holdings, JWTs or cookies
   into an anonymous public snapshot. Expected impact high with many viewers or
   frequent reloads; complexity medium; risk medium due to authorization boundaries.
   Important distinction: [auction route selection](src/lib/auctionRefresh.js:6)
   returns no normal auction request for raffle URLs. A raffle page does not itself
   start ordinary auction-page polling. The reported auction RPC timeouts suggest
   wider database pressure or simultaneous auction traffic, not those calls being
   issued directly by the raffle screen.

3. **High potential impact: expensive auction readers and uncertain deployment.**
   Before migration 227, [history authorization](supabase/migrations/202611030177_detail_history_pages.sql:25)
   builds viewer context just to decide visibility. The legacy page reader also
   calculates latest activity across matching rows before pagination even when it
   does not determine sorting. Migration 227 narrows authorization and defers that
   calculation, preserving visibility, names, cursors and timestamp outputs.
   [Private detail reads](src/lib/publicAuctionReader.js:59) still reach Supabase
   per viewer; completed/Buy listings choose full detail on refresh. Shared public
   caching does not eliminate this cost. These expensive paths largely predate the
   newest features, so distinguish existing bottlenecks from new regressions.
   **Fix:** verify actual installed definitions and whether 227 was applied before
   proposing more changes or rerunning it. Obtain representative plans for remaining
   private projection work. Complexity low–medium; risk low with the existing privacy
   regression suite. Potential production benefit is unmeasured.

4. **Potentially high impact: shared financial-lock contention.**
   [Raffle intake isolation](supabase/migrations/202611050209_raffle_intake_isolation.sql:31),
   ticket ingestion, drawing and settlement use the financial advisory lock shared
   with auction work. New raffle intake adds transactions at that serialization
   boundary. This is a credible contention path, not evidence that it caused the
   outage. Ordinary read RPCs should not be described as directly waiting for this
   advisory lock without a demonstrated call path/wait event.
   **Fix:** measure lock wait versus execution time and identify longest holders.
   Move only proven nonfinancial work out of locked transactions where safe.
   Do not remove the global lock, parallelize the connected bot, weaken receipt
   deduplication, bypass complete-scan/uncertain-intake stops, or release settlement
   early. Investigation first; implementation complexity depends on evidence;
   financial changes carry high risk.

5. **Moderate impact: expanded site-wide account/invitation reads.**
   [Profile loading](src/lib/auth.js:75) calls account access, administrator status
   and raffle access. [Account refresh](src/context/UserContext.jsx:87) repeats
   periodically. The globally mounted [invitation popup](src/components/HighRollersInvitation.jsx:53)
   adds a read on focus with no dedicated in-flight coalescer/cooldown.
   **Fix:** return self-only access flags and pending-invitation status together
   from the existing account-access RPC and use its lifecycle. Existing role and
   membership checks on server writes remain authoritative. Complexity low–medium;
   risk low; aggregate traffic reduction is more important than any one small query.

6. **Moderate growing-data impact: personal raffle query shapes.**
   [Personal ticket history](supabase/migrations/202611040200_raffle_manual_fulfillment.sql:262)
   returns all personal purchases and checks refund delivery state per receipt.
   [Profile raffle history](supabase/migrations/202611050223_private_raffle_history.sql:21)
   filters by player, but the existing purchase index starts with raffle ID
   (`raffle_purchase_owner_idx(raffle_id,player_id)`). The query/index mismatch is
   confirmed; an expensive production scan has not been demonstrated.
   **Fix:** inspect plans for a player-leading index, paginate long purchase history,
   and separate lightweight totals from receipt/refund details. Do not introduce
   another maintained totals table without evidence justifying its write cost.
   Complexity low–medium; risk low after plans and isolation tests. This is less
   likely to explain an immediate closing-time spike than priorities 1–4.

7. **High visible impact, likely symptom: bounded shared-cache saturation.**
   The [origin scheduler](workers/public-auction-cache/scheduler.js:1) serializes
   origin work; [queue limits/cooldowns](workers/public-auction-cache/index.js:164)
   bound demand. Direct private/raffle reads sit outside that protection. Cache
   “temporarily busy” responses can therefore reflect upstream pressure even when
   the cache is successfully constraining its own load.
   **Fix:** correlate Worker categories, pending counts, origin latency and cache
   hit/miss behavior before altering limits. Do not blindly increase concurrency,
   retries, timeout thresholds or stale live-bid tolerance. Investigation first;
   changing limits carries medium–high risk of worsening database pressure.

### Existing behavior to preserve

- [Market-price reads](src/lib/marketPrices.js:4) already batch, coalesce and cache;
  do not add a second competing cache without a demonstrated gap.
- Raffle countdown rerenders are local display updates, not one database read per
  second. Market-price/result effects use stable dependency keys rather than the
  display clock. Do not blame the animation/timer alone for RPC volume.
- Existing private refresh has hidden-tab pausing, serialization, failure backoff
  and jitter. Reuse it rather than creating overlapping independent pollers.
- Keep shared public transport free of private credentials/data; preserve scoped
  caches, authoritative write refreshes, accurate bids, anti-sniping, financial
  authorization, exact accounting and failure isolation.

### Evidence needed to establish the incident's cause

- Exact incident timestamp/timezone, duration and affected URLs; auction/giveaway
  versus Mystery Raffle; participant/viewer counts and actual purchase/bid rate.
- Deployed website/cache build/config (`VITE_SHARED_AUCTION_CACHE`, live-state mode),
  installed RPC definitions/SQL revisions and exact Oracle bot version/image.
- Incident-period Supabase CPU, I/O, connections, transaction duration, wait events,
  blocking sessions/lock holders and resource limits. A quiet later snapshot cannot
  reconstruct an earlier spike.
- Incident-window call counts, errors and p95/p99 latency for the three timed-out
  auction RPCs plus newer raffle/account/invitation RPCs. Cumulative averages alone
  are not incident timelines or proof of CPU saturation.
- Representative parameterized query plans (`EXPLAIN (ANALYZE, BUFFERS)` in a safe,
  controlled setting) for actual user roles and representative bid/receipt volumes.
- Worker `[PUBLIC_CACHE]` codes, view/RPC family, scoped/global circuit state,
  pending queue counts, origin duration, cache state and retries during the incident.
- Browser Network traces separating public Worker requests from direct private
  Supabase requests; bot inbox/intake throughput, lock waits and finalization timing.
  Never expose credentials, authorization headers or raw player KMail.

Recommended sequence: verify deployment state → measure incident traffic/waits →
reduce commitment-poll amplification → reuse scoped raffle caching → consolidate
account checks → optimize measured SQL/lock holders. These are recommendations,
not approval to implement or deploy. No production benchmark or root cause was
established by this read-only audit.

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
- Current local SQL extends through 230; 230 is queued and 227–229 are in the
  parent directory at this handoff update. Prefixes including 150, 151, 160, 167
  and 199 have multiple filenames: use full filenames and prerequisites. File
  location alone does not verify the production schema or deployed runtime.

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
