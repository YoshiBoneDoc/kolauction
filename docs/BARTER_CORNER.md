# Barter Corner

Implemented locally November 14, 2026. Queued migration **273** must be applied
once after owner-confirmed 272, then deploy the website. No production SQL,
website deployment, bot restart or real asset transfer was performed. This is
not activated merely by adding the files.

## Rules and scope

- One eligible item type per listing; its listed quantity must have at least
  **40,000,000 Meat total market value** at creation. The server uses the existing
  catalog and market-price ledger, rejecting missing/unavailable quotes, future
  timestamps and quotes observed or checked more than 26 hours ago.
- Direct only. An optional minimum offer value is fixed at creation. A submitted
  offer must **exceed** that minimum, if set. It need not exceed the currently
  accepted offer. An offer must contain positive Meat or item value, with up to
  ten distinct item types. Quantities and exact numeric arithmetic are bounded;
  offer value cannot exceed the existing 20 billion Meat bid limit. Listing market
  value must fit the browser's exact integer range.
- Market estimates are snapshotted at submission. Changing market prices do not
  rewrite the immutable offered quantities, Meat, estimates or accepted history.
  Fresh quotes are authoritative on the server; browser estimates are advisory.
- The host can accept, reject or request item changes on a pending offer. Requests
  mark unwanted item IDs with X; all others are checkmarked. The bidder sees the
  original offer and feedback and can submit a new immutable offer. Only one
  pending offer per bidder/listing is allowed; pending offers may be withdrawn.
- Accepting an offer replaces the current highest bid even when its estimated
  value is lower. Previous acceptances remain in public accepted history. Pending,
  rejected, withdrawn and change-requested offers never enter public history.
- Hosts can cancel a live listing before any offer has been accepted. The detail
  page asks for confirmation; the server verifies the host, restrictions, deadline
  and accepted-offer guard under the same listing lock as submission/review.
  Cancellation hides the listing from browse/notices and closes bidding/review,
  preserving existing offers and feedback. Accepted trades cannot be cancelled.
  This requires queued **285** after 283 and a website deployment; not applied
  to production. The matching ignored bot migration is an alternative SQL copy.
- **Deadline interpretation:** offers and host decisions close at the scheduled
  deadline; no automatic extension is added. The last accepted offer wins. An
  unreviewed pending offer does not win. If there is no accepted offer, no trade
  is due. This interpretation was stated during implementation; it is not a new
  ordinary-auction lifecycle rule.
- Host and winning bidder see the exact winning exchange and both KoL identities
  after the deadline. They exchange items/Meat manually under Direct trade rules;
  support is linked. The site does not collect, verify, reserve or send assets.

## Architecture and privacy

Separate private `khub_bot.barter_auctions` / `barter_offers` tables and explicit
RPC projections guarantee separation from All Auctions, Home ordinary listings,
ordinary bidding, bot intake/settlement and Meat-based accounting. No changes to
ordinary auction SQL, commissions, escrow reserves or bot financial processing.
Barter trades do not enter ordinary settlement confirmations, completed-sale
statistics or leaderboard financial totals; those would need explicit component
accounting and moderation integration, rather than treating estimates as Meat.

Creation and offer/review writes reuse verified-trader and ban protections. Direct
ignore visibility applies to browse/details/submission; host decisions also check
both directions of ignores and current bidder restrictions. Private offer reads
are limited to the host or the submitting bidder. Anonymous visitors see accepted
history and public listing facts without bidder identities. Tables are not granted
to browser roles; RPC execution is allowlisted.

Per-listing row locks serialize submissions, withdrawals and decisions without
holding the global asset-transfer lock. Publication and submission tokens dedupe
uncertain user retries. Reviews preserve immutable decisions; duplicate identical
reviews are harmless and cannot move the current pointer back to an older offer.
No automatic write retries occur. Reads reconcile after successful or failed writes.

Browse pages use 24 rows plus one lookahead; private offers and accepted history
use 20 plus one. Search and ordering happen server-side before pagination. Three
sorts follow existing auction semantics: Ending Soon, Newest, Recent Activity
(latest submitted offer, unbid last, creation/id tie breakers). Supporting indexes
bound deadline/newest/activity and owner/pending reads. Search is a literal,
case-insensitive substring, limited to 120 characters. No cache Worker changes.

Website read coalescing is memory-only, scoped by account, with a ten-second reuse
window. Mounted pages and the signed-in host pending-bid strip refresh every 30
seconds only while visible. The strip is compact, limited to twenty listings and
links to each detail page. Account changes clear displayed private data immediately;
write notifications invalidate reads and refresh visible consumers. No private
payloads enter shared public caches or persistent browser storage.

## Account and seller histories

Queued **286**, after 285, adds `read_profile_auction_page` for merged account and
seller histories. Read-only adapters preserve the separate ledger and project
barters into the existing row format. Filtering, sorting, counts and seller pages
are computed after the union, never by appending a second page in the browser.
A bidder/auction history index supports account-scoped offer lookup. Latest own
offers appear only in the owner's profile response; seller responses contain no
private offer list. Winner IDs are limited to ended participants/admins. Ignore
visibility applies before selection and counts. Existing ordinary row projections
and seller financial statistics are reused without treating estimates as payments.

Both row types keep their existing classes, with a 20px barter symbol beside the
item name and `/barter/:id` navigation. Bid actions go to the barter page rather
than the ordinary bid form. Owner-only Relist buttons on cancelled/unsold barter
rows open a new Direct barter draft with the original item, quantity, optional
minimum and duration. No offers, winner, old deadline or financial state is copied;
normal creation validation and confirmation still apply. Accepted trades awaiting
settlement cannot be relisted. Host
acceptance determines displayed leading values even if an own pending offer is
worth more. This adds history visibility, not barter completion confirmations,
financial reporting or leaderboard integration.

Merged seller pages use the existing authorization-scoped browser read cache and
refresh schedule; they cannot reuse ordinary-only shared page membership without
breaking combined pagination. Home/All Auctions shared caching is unchanged. The
existing lightweight seller statistics RPC remains the summary fast path; a
barter-only host receives a statistics shell with no invented completed trades.
Apply SQL once, then deploy the website. No bot runtime update is required; the
matching ignored bot SQL is an alternative copy. Production application,
deployment and browser visual verification remain outstanding.

## Interactive practice auctions

Two compact DEMO / FAKE cards sit at the bottom, below live listings and
pagination. The host listing uses Grimacite gown. Item-based sample offers contain
four or five items; a separate Meat-only example remains. Guest-accessible
`/barter/demo/host` and `/barter/demo/bidder` routes use the real offer form/review
components with local callbacks, fixed sample items and illustrative prices. They
never call trading, catalog or market-price RPCs, invalidate real data, create real
auctions or affect account history/financial totals. Global site navigation and
presence behavior remain normal. Demo membership is separate from live filtering,
counts, sorting and pagination. Reloading or Reset demo discards practice changes.

Host examples include accepted, item-only, mixed and Meat-only offers; users can
accept a lower-valued offer, reject, mark unwanted items/request an increase, and
simulate the bidder's new revised offer. Bidder practice includes accepted,
rejected, change-requested, pending and superseded examples, an editable offer
builder, withdrawal and simulated host responses. Only one own pending offer is
allowed. Revisions create new offers and preserve originals. Preview auction
ending expires unaccepted offers and freezes the last accepted offer as winner.

This is a website-only release with no additional migration. Targeted tests cover
routes, transitions, shared controls' no-RPC practice behavior and unchanged real
confirmation/RPC adapters. Browser visual QA is unverified because the browser
host was unavailable during the local preview attempt; not deployed.

## Verification

- `python3 tests/barter_database_test.py`: disposable local PostgreSQL with all
  migrations; passes threshold/freshness, optional minimum, ordinary-table
  separation, idempotency, unauthorized review, pending privacy, feedback,
  lower-valued acceptance, accepted-only history, withdrawal, concurrent duplicate
  submissions/conflicting reviews, deadline/winner
  privacy, notices, ignores, bans, immutable decisions and bounded sorted paging.
- Targeted Node tests: **44 passed / 5 failed**. The five publication failures
  match the pre-change baseline. New separate-ledger publication, browse route,
  estimate and compact-offer checks pass. Full website suite was not rerun.
- Changed-file lint, production build, diff checks and secret scan pass. Existing
  ESLint-ignore and large catalog bundle warnings remain.
- Live browser visual QA, production installation/deployment and capacity under
  concurrent production traffic remain unverified. Local tests do not establish
  production capacity or actual player inventory/ownership.

The ignored `bot/supabase/migrations/202611140273_barter_auctions.sql` copy is a
backup/release alternative for the same SQL, not a second migration to apply. No
bot binary change is needed. The owner's personal quickstart guide is unchanged.
