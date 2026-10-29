# Public reads and worker efficiency — migrations 148–149

These changes are implemented and tested locally. They are not deployed by Codex.
The personal bot quickstart guide is unchanged.

## What changed

1. **Reusable public aggregates.** Price-range bounds and hot-auction IDs are
   computed into one private database snapshot, at most once every 60 seconds.
   Public cache misses and optional bot maintenance refresh it. Concurrent
   rebuilds use a separate, nonblocking advisory lock; no financial lock is used.
   Existing uncached calculation functions remain available for verification.
   These values are display hints, never financial authority. Price bounds and
   popularity indicators can lag, with additional normal browser/cache latency.
   Current bid acceptance, deadlines, fees, reserves, payouts and refunds continue
   using the original live database checks.

2. **Public seller-list caching and private overlays.** Eligible seller listing
   pages now use the existing global Cloudflare cache and coalescing/backpressure.
   Cache entries contain only the existing allowlisted public auction facts.
   Their routing key includes the public seller-profile UUID, as the public URL
   already does; names, account state, financial summaries, reservations, bid
   histories and admin data are excluded. Seller summaries come from a separate
   direct RPC using the existing calculations. Authenticated cards still receive
   current, private context. The Seller Profile statistics tab reads only the
   summary rather than fetching and discarding an auction page.

   Detail pages, private profiles, Mine/Others filters, forced post-action reads
   and signed-in All-status listings remain direct. Keeping the latter direct
   preserves owner/admin draft visibility and pagination. No mixed private
   response was moved into shared storage. The existing public reader flag is
   still `VITE_SHARED_AUCTION_CACHE=true`; there is no new dependency or secret.

3. **Indexable literal searches.** Case-insensitive substring matching uses
   escaped LIKE patterns and GIN trigram indexes for item names and a bundle
   candidate expression. Bundle component matches are rechecked individually,
   preventing matches across the boundary between two names. `%`, `_`, backslash,
   trimming and case behavior remain literal. A seller/creation-time composite
   index supports seller history access. Broader index tuning, resource settings,
   deep-pagination changes and query-specific rewrites await fresh production
   statistics; no speculative financial indexes or memory settings were changed.

4. **One private identity lifecycle.** The existing private account-access RPC
   now includes the current user's KoL identity. Auction forms and account linking
   reuse it, eliminating separate ten-second profile polls. Only a visible,
   pending verification challenge requests a faster account refresh. Those
   requests share the account scheduler's single-flight, five-second wake dedupe,
   hidden-tab pause and failure backoff. No identity is placed in shared storage.

5. **Cheaper empty bot cycles.** After ingestion and bot_tick, a fresh read-only
   hint contains pending-delivery presence and the existing Buy preparation list.
   Empty queues skip dispatch solvency/claim work; Buy preparation avoids reading
   its list twice. Closet queue preparation reports whether anything is pending,
   so an empty queue skips its liabilities/claim read. Hints are never cached and
   never authorize a send. New work arriving just after a hint is handled on the
   next normal cycle. Nonempty work retains all original balance, reserve, review,
   durable claim, acknowledgment, uncertain-send and recovery checks. One worker
   and one KoL session remain. Display-maintenance failures do not restart the bot;
   the maintenance request has a two-second client deadline and a one-minute cadence.

## Deployment

- Apply queued migration **148**, then **149**, after 147. The index builds in 148
  are ordinary transactional index builds; schedule this migration outside a
  giveaway, since building them can briefly block writes. No financial rows are
  rewritten or deleted.
- Deploy the updated shared-cache Worker and website together. The Worker now
  uses `read_public_auction_page` and `read_public_home_auctions`; it needs 148.
- Update/rebuild the bot using the existing deployment procedure. Migration 149
  advertises the feature so old installations retain their previous path.
- Keep secrets and the service-role key out of the website and public cache.
  The deployment order matters: the new website expects the identity and seller
  context RPCs supplied by these migrations.

## Verification and follow-up

- The offline SQL suite applies all migrations and compares new public rows,
  totals, pagination and seller summaries against the existing readers. It tests
  permissions and snapshot reuse across different searches.
- A 6,000-row disposable search fixture checks old/new row-set equivalence and
  actual EXPLAIN ANALYZE/BUFFERS plans selecting both GIN indexes. This establishes
  index usability, not a measured production speedup for every query.
- Simultaneous 200-visitor cache tests verify coalescing for Home/browse and seller
  listings, including invalidation, bounded queues, failure cooldown and privacy.
- Bot tests cover idle savings, fresh hints across cycles, insolvency and malformed
  responses, plus the existing full financial/recovery suite.
- In 24–48 hours, use `scripts/diagnostics/query_performance_followup.sql` once.
  It reads accumulated query statistics without resetting them. Compare total
  execution time, calls, latency, rows and temporary-block writes; then inspect
  plans for the specific heavy queries. Do not run EXPLAIN ANALYZE on financial
  write functions against production. Capacity/connection-pool changes should
  follow actual memory, active-connection and lock evidence, not a guessed limit.
