# Later November 9 public-read timeouts

Two supplied PostgreSQL error events, reviewed against current migration sources.
No production connection or mutation. Existing giveaway snapshots end at 14:25 UTC
and cannot characterize resource pressure at either later event.

| Time UTC / Eastern | RPC | Cancellation context |
| --- | --- | --- |
| 16:30:23.207 / 11:30:23 AM | read_home_cards | site_trade_totals during startup |
| 20:33:55.564 / 3:33:55 PM | read_public_auction_page | deal_quote → deal_score → public_listing_page |

Both explicitly say statement timeout (57014). They are four hours apart, not a
single simultaneous failure cluster. Connection session_start_time is not query
start time; neither a ten-minute nor a 22-minute query duration can be inferred.
The normalized query IDs recur from morning but identify the RPC envelope, not
unchanged installed helper definitions, caller/build, role, request parameters or plan.

## Home: surprising cancellation location, not proof totals recomputation

Migration 174 split expensive milestone maintenance into refresh_site_trade_totals.
The current site_trade_totals function is a stable SECURITY DEFINER SQL function:
`select totals from khub_bot.site_trade_totals_snapshot where singleton`.
The snapshot has a boolean primary key constrained to true (migration 150).
The current read_home_cards wrapper concatenates home_cards_core output and that
snapshot. Its preceding Home selection can consume most of the statement budget
before totals starts; a cancellation there does not identify the dominant cost.
Alternatively, production may differ from expected definitions, or a short metadata
lock/resource stall could affect even a tiny read. No active-wait capture accompanies
this event, so none of those possibilities is established.

First verify installed function text and table/index metadata. If the function is
still read-only and singleton, do not add another totals cache/index or force
milestone recalculation in Home. Profile home_cards_core separately from the cheap
snapshot lookup, using a controlled read-only fixture or off-peak bounded probe.
If production differs, reconcile dependencies and prepare a targeted additive fix;
do not rerun historical migrations blindly. DDL at this exact time, if any, needs
correlation before blaming a metadata lock.

## Browse: real scoring path, unknown dominant plan

deal_quote expands one Buy component or the Sell/Bundle components, joins catalog
and market_prices and aggregates complete quantity-weighted values. deal_score uses
that quote and the next payable bid/buyout to rank deals. Migration 180 inserts
scores into the matching pool for recommended/best-value sorts, before pagination.
The context is consistent with that scoring path, but argument values were not
logged, so the requested sort/filter cannot be established from the envelope alone.
Cancelling at function startup does not prove planning or that helper alone used
the budget. The cheap per-row lookups can still accumulate over a large pool.

Verify installed definitions, pool cardinality and indexes/stats; then measure:
1. Matching/visibility/filter cost before quote work.
2. Number of deal_quote evaluations vs eligible matching rows and returned cards.
3. Bundle component expansion, catalog/market-price indexed lookups and sorting.
4. Repeated score/projection quote calculations and whether materialization or
   set-based component aggregation would eliminate repeated work without scanning
   irrelevant auctions. Keep filters/visibility before paging, correct ranking,
   complete bundle quotes, freshness and Buy semantics.

A possible optimization is an explicit early zero-score branch for expired,
inactive or giveaway rows before quote expansion, if the installed plan evaluates
quotes for those rows. Another is reusing a quote once per candidate. These are
candidates to measure, not confirmed fixes; preserve exact outputs and freshness
before proposing production SQL. No speculative index, financial change or timeout
increase is justified by this log alone.

## Concrete next capture

The one-off installed-definition diagnostic used for this investigation has been
removed after its results were reviewed (see the export findings below). It is not
part of the routine capture workflow. The retained diagnostics are
`scripts/query-stats-snapshot.sql` and `scripts/traffic-pressure-snapshot.sql`.

For another stall, capture traffic-pressure-snapshot.sql DURING it, plus a complete
query-statistics pair around the event. Obtain CPU/credit/memory/I/O and Worker
origin queue/error graphs for the exact timestamp, and the browse request's allowed
filter/sort values and build version (without JWTs or private payloads). Earlier
idle captures cannot rule out later CPU or lock pressure. The earlier anon 3s role
setting suggests public budgets may be tight, but neither event proves effective
role timeout at that later time. Do not raise it instead of measuring the work.

## Installed-definition export received at 2026-11-10 00:18:36 UTC

Reviewed `/Users/adityayadav/Downloads/Supabase Snippet Untitled query (6).csv`.
This is a later configuration snapshot, not contemporaneous execution plans.
It establishes the following at capture time:

- site_trade_totals is exactly the read-only singleton snapshot SELECT. Its table
  has the expected singleton primary key and approximately one live row. The old
  synchronous full-history totals refresh is not present in that reader.
- catalog(id), market_prices(item_id) primary keys exist. Do not add duplicate indexes.
- Home contains the seller-pool LEFT JOIN strategy from 242, and the public-card
  projection builds its whitelist directly as in 244. Missing these optimizations
  is no longer the leading explanation at capture time. Recent Home results also
  omit the redundant abandoned-draft check targeted by 236.
- Estimated live/dead rows: auctions 315/103; catalog 12103/41; market_prices
  8539/0; milestone snapshot 1/30. Estimates do not establish bloat, and a recently
  autoanalyzed table is not proof its relevant estimates are accurate. These small
  table sizes do not justify claiming the database is overwhelmed by table volume.

Concrete remaining code paths:

1. home_cards_core contains five visible_auctions() call sites: seller discovery,
   active candidates, high candidates, recent candidates and final projection
   (count verified mechanically from the exported definition). Each scan can repeat visibility work. Whether a shared filtered
   materialization saves time must be measured, because making it too broad can
   preserve more rows/columns than needed. Preserve anonymous/public vs authenticated
   ignore semantics and all section ordering/selection parity.
2. Public browse materializes candidates with deal_score, then evaluates per-seller
   restrictions in a later CTE. Thus the score is attached before final seller
   exclusion; measure moving score work after final matching while preserving totals,
   ordering and exact filtering. The outer candidates CTE's actual evaluation and
   plan need confirmation rather than inferred invocation counts.
3. deal_score calls deal_quote; selected cards also call deal_projection, which
   invokes quote again in the source implementation. Home additionally projects
   lot_market_value. The fields have different semantics (Buy quotes are per item,
   completeness/eligibility and freshness matter), so these must not simply be
   substituted for one another. Reuse shared component facts with parity tests.
4. Score eligibility (inactive/giveaway/expired) is expressed inside the final
   scalar subquery rather than as an explicit outer guard. PostgreSQL may already
   skip the quote for some cases. Verify calls/plan before claiming savings from
   moving that guard.

Updated recommendation: work on reducing repeated visibility and quote computation
in representative local Home/browse plans, then compare complete JSON outputs for
ordinary, guest, ignored, restricted and administrator viewers. Keep cached totals
as-is. No schema/index/cache/compute change is justified solely by this metadata.
The actual timeout cause and incident-time installed state remain unverified:
these definitions were exported hours after both errors, without a deployment
history or runtime plans. No additional production query is needed merely to
reconfirm the indexes or singleton table.
