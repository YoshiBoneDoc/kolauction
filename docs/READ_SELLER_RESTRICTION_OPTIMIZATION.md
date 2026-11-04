# Home and card-context restriction checks

Apply `supabase/migrations/queue/202611030192_memoize_read_seller_restrictions.sql`
after migration 191. The owner moves it to the applied directory after success.
The matching bot SQL file is an alternative copy; execute the script only once.
No website or Oracle JavaScript deployment is required for this SQL-only change.

Home previously called the seller restriction helper for every active listing.
Card context called it for every active Sell card. The updated readers materialize
restriction results once per distinct relevant seller within the same request.
They continue to use the installed ignore/visibility helper. Buy and closed-card
projections, ranking, limits, totals and existing authorization checks remain intact.
There is no cache across requests: a subsequent read evaluates current restrictions.
No financial locks, receipt handling, fees, balances or settlement functions change.

Verification: `python3 tests/read_seller_restrictions_database_test.py` creates an
isolated PostgreSQL cluster and applies the full migration chain. It compares
baseline and optimized JSON for anonymous, owner, bidder, restricted and admin
viewers; repeated-seller active listings; Buy/Bundle/closed cards; ignore relations;
and a restricted seller. It checks invalid/empty card inputs and verifies unchanged
financial function definitions. It prints paired warm timings without fragile
wall-clock assertions.

One mixed synthetic run: 15 card reads took 194.792 ms before versus 166.844 ms
after; five Home reads took 878.547 ms before versus 785.148 ms after. This fixture
has 120 additional listings sharing one seller. Benefits depend on repeated sellers
and the proportion of active Sell cards. These are local measurements, not live
latency or guarantees against future timeouts. The snapshot supplied by the owner
showed no active blockers; it cannot establish earlier contention. Query statistics
were cumulative. No production SQL was applied during development.
