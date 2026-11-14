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
