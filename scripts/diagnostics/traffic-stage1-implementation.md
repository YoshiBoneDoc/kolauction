# Giveaway readiness: first implementation batch

Implemented locally October 28, 2026. Not applied to production or deployed.

## Changes

- Home uses one `read_home_auctions` call. Each Explore ordering, High Rollers and Recent Trades is capped at 24 entries; overlapping entries are projected once, at most 120 rows. Explore selects distinct item representatives before limiting. The existing full-list navigation remains available.
- All Auctions requests one server-filtered, sorted 24-row page, preserving total counts, ranges, ownership, auction kind, trade type and session preferences. Removed full-history downloads and the alternative multi-page homepage scan.
- Search is debounced 250 ms. Rapid price-range changes wait 250 ms before their first request, with stable slider bounds while loading. Superseded reads are canceled; selected results are never replaced with a partial or differently filtered result.
- Cache entries remain scoped to authorization and retain stale results only for the same resource. Identical reads coalesce, reads serialize, unused history is bounded, and explicit post-write refresh targets the current page even after navigation.
- Home/browse refresh every 60–72 seconds, with positive jitter; pending reads every 30–36 seconds. Hidden-page suspension, error backoff and detail-page deadline refresh behavior remain.
- Migration 126 adds a bid activity lookup index, calculates bid counts/activity across all matches only when required for sorting, and otherwise calculates them for the selected page. The global price-bounds aggregate joins market/catalog data instead of repeatedly calling market lookup functions. Existing privacy projection functions are reused.
- The filtered browser reader preserves the prior client lifecycle behavior: server-active overdue lots remain finalizing, and canceled lots sort by cancellation time. Public Seller Profile reader overloads remain untouched.

## Deployment order

1. Apply `supabase/migrations/queue/202610280126_bounded_auction_reads.sql` in Supabase SQL Editor, after migration 125. This creates the new homepage endpoint before the website requests it. The migration is rerunnable; the owner moves the successful script per the repository convention.
2. Deploy the matching website build. A missing endpoint produces an explicit load error, with no fallback to full-history downloads.
3. Verify Home (all Explore tabs, High Rollers, completed carousel), browsing/search/range/ownership/kind filters and pagination as guest and signed-in user. Existing open browser tabs need the new website code to receive these changes.
4. Observe database latency, timeouts and bot queue age during the next controlled traffic test. No bot image rebuild is required for this batch.

No production SQL, website deployment, live bot restart, game login or real transfer was performed. The gift-accounting overlap and bot retry/inspection changes belong to the second batch and are not fixed here.

## Verification

- Focused Node tests: auction service/provider/cache/refresh, browse session/ranges/ordering, rendered cards and inline interactions pass. Includes cancellation/privacy, stable slider bounds, bounded section membership and explicit initial errors.
- `python3 tests/bounded_auction_reads_database_test.py`: passes against a disposable PostgreSQL cluster with all migrations. Covers migration reruns, username masking for guests/restricted users, private drafts, exact global counts/order before pagination, market-bound equivalence, actual Buy creation/funding/projection, and unchanged financial function definitions.
- On 152 synthetic lots and 4,000 bids, an ordinary read's bid-index loop count fell from 304 to 48. One representative run measured 44.705 ms before and 39.939 ms after; timings varied between runs and do not establish a production speedup or capacity.
- Eight concurrent website reads plus bot inspection/finalization finished within a local 10-second statement budget. Website reads also completed while another transaction held the financial advisory lock. This is a small synthetic concurrency test, not a production-sized staging load test.
- Frontend build succeeds. Targeted ESLint has no errors; existing context fast-refresh and build chunk-size warnings remain.

### Existing failures distinguished from regressions

The broader Node run had seven unrelated failures, reproduced on a temporary checkout of the pre-change HEAD: one private-profile rendering assertion, one market-label assertion, and five public-profile layout/default assertions. These are in `auction-lifecycle-render.test.mjs`, `market-prices.test.mjs` and `seller-profiles.test.mjs`. Their components were not changed in this batch.

The existing `bot_only_finalization_database_test.py` passes its first six verification groups, then fails its high-value parsed-bid fixture at the assertion following `stage([parsed[1]])`. Running the same suite with migration 126 omitted reproduces that failure. This batch does not claim a fully green financial suite or alter that fixture/financial behavior.

## Remaining evidence gaps

We still lack production query plans, lock-wait/CPU metrics and measured visitor/request counts from the giveaway. Reduced request amplification is established by bounded calls and query work; a safe visitor limit and the precise cause of the original database delays are not established. Shared server caching and infrastructure sizing remain separate follow-up decisions.
