# kHub handoff for the next chat

Updated October 27, 2026. Read this before proposing work, then inspect the relevant
code. The website is live; the Oracle bot holds real players’ Meat and items.

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

## Immediate unresolved incident: seller payout D-1523

Auction **#1075**, **The Nuge’s favorite crossbow ×1** (item 7201), sale price
**200,000,000 Meat**. Standard tiered fee: **5,110,000**. Seller payout:
**194,890,000 Meat**, recipient **player #705792**, reference **D-1523**.
Recipient/amount come from the owner’s logs; no live lookup was performed here.

The bot reported an unconfirmed send at 10:28AM and again after an owner-directed
retry at 10:34AM on October 27. It isolated the payout rather than automatically
resending, allowing other deliveries to continue. The generic REVIEW line does
not establish the cause. No detailed transport evidence has been supplied yet.

The owner then sent the payout manually in a gift package. They initially could
not find the Sent entry, but subsequently **found the package and confirmed it
is still there; the recipient simply has not opened it**. Do not suggest sending
another payout. Opening is not required for a successfully sent package to count
as sent. The bot’s deletion path inspected here targets Inbox, not Sent.

Previously supplied reconciliation instructions were to stop the worker, save
`lookup D-1523` to `D-1523-before-resolution.json`, then use `resolve D-1523 sent`
only after confirming the manual payment. **It is unknown whether the owner ran
those commands.** Do not assume the ledger is reconciled or that the whole
auction is complete; the item delivery is a separate obligation.

Next diagnostic evidence, if the file was saved, from **Oracle, `~/khub-bot`**:

```bash
cat D-1523-before-resolution.json
```

Otherwise inspect current read-only evidence before proposing further steps:

```bash
sudo docker compose run --rm --no-deps bot node src/cli.mjs lookup D-1523
```

A later `resolve` may replace evidence, so missing original evidence must be
acknowledged. No diagnosis yet proves that the performance changes caused this
send failure. Investigate the actual saved evidence before changing transport.

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

## Recent completed local work to preserve

These are implementation notes, **not proof of current production deployment**.

- Phase 1: shared, authorization-scoped in-memory auction dataset/cache;
  client-side filtering/sorting and pagination; deduplicated/serialized loading;
  previously loaded data retained on temporary failures, explicit initial errors.
  Session storage holds browsing preferences, not private auction datasets.
- Phase 2: browsing no longer triggers financial maintenance. Bot expiration and
  server-side deadline validation cover Sell, Buy and Direct auctions. Do not
  weaken financial locks or validation to reduce read latency.
- Phase 3: retention indexes/fixed cutoffs, justified delivery indexes and durable
  handled-receipt replay checks. Skipped ingestion must still allow delivery
  recovery and safe cleanup; unresolved financial mail must remain recoverable.
- Gift-only collectibles are eligible for Buy/Sell listings; package wrappers are
  excluded. Ordinary attached gift items are **not** gift packages. Classification
  follows KoL mail type, not item name or giftability.
- A valid outside package command takes precedence over inside text. Inside-only
  auction-command intent returns the contents with corrective instructions;
  it never executes the inside command. Explicit outside DONATE is preserved.
- Parser corrections distinguish acquisition tables from Valentines. Legitimate
  or ambiguous Valentines remain protected/reviewable. Further hardening covers
  note separators, explicit item quantities, mailbox structure and exact visible
  send acknowledgments. Meat extraction was intentionally left unchanged in the
  later hardening pass. Missing quantities/unknown wrappers were defensive checks,
  not demonstrated production incidents.
- Normal transaction logging consolidates intake/outcome/confirmed references.
  **REFUNDED only after confirmation**, never merely queued. Errors, retries,
  reviews and debugging remain visible; do not remove diagnostic failures.
- Escrow Protection Guarantee is permanent and uncapped for verified automated
  escrow errors, with exclusions. The full policy is on auction creation;
  Info’s comparison table and Update Log link there. Do not restore old 1M caps.
- Buy detail funding UI, compact history, owner-only financial summary and
  admin-only readable reservation audit are implemented. Enhance-image controls
  are hidden; their code remains. Avoid undoing these small design decisions.

Relevant references:
[transaction audit](bot/REGRESSION_AUDIT.md:1),
[parser hardening](bot/PARSING_HARDENING.md:1),
[inside-package commands](bot/INSIDE_GIFT_COMMANDS.md:1),
[Buy detail UI](src/components/BuyAuctionDetails.jsx:1),
[auction read cache](src/lib/auctionReadCache.js:1).
Migrations 117–122 document recent changes; inspect the actual files and applied
state before suggesting SQL. Matching bot copies are alternatives, not a second
set to execute.

## Verification evidence and limits

The previous local parser-hardening run reported **282 Node tests and nine
isolated PostgreSQL suite runs passing**. Later targeted SQL coverage includes a
200M crossbow settlement: exact seller payout/fee, numeric recipients, once-only
asset deliveries, repeated ticks/receipts, uncertain payout isolation, unrelated
queue progress, restart persistence and verified-Sent recovery. Admin audit
privacy tests and frontend checks also passed during their implementation.
These historical results are not a fresh run and do not prove live KoL transport,
Oracle balances, deployed versions, current queues, or production lock health.

Original raw Jimmyking incident HTML and the original reported gift envelope were
not recovered. Tests combine public upstream fixtures/archived response fragments
with explicitly constructed variants. Do not call reconstructed fixtures captured
production mail or infer regression introduction dates from missing bot history.

For new relevant changes, inspect package scripts and run focused existing tests.
Bot runtime targets Node 24+; local Node 22 tests required
`NODE_OPTIONS=--experimental-sqlite`. SQL tests create disposable local PostgreSQL
clusters. Do not start a real worker or use production credentials for tests.
Do not spend time rerunning unrelated suites for documentation-only changes.
