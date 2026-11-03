# Shared live auction state — local implementation and staged rollout

No production deployment, migration application or live bot action was performed.
Financial validation, escrow accounting, dispatch safeguards and financial locks
remain unchanged. This is display caching, never transaction authorization.

## Behavior

The opt-in cache Worker path uses `LIVE_AUCTION_STATE=true`. Without it, the
existing listing response behavior remains; scoped failure handling and v1/v2
notification compatibility are available in either mode.

Full Home/browse/seller/featured selection refreshes at most once per shared key
per 30 seconds in normal traffic. Bids do not force those full projections for
every visitor. A separate RPC batches at most 120 public auction IDs and returns
only live prices, status, deadlines, bid counts and Buy availability. The object
reuses each auction's state across listing keys for two seconds. It retains no
more than 256 live states / 256 KB. Existing origin scheduling remains serial,
with one-second start spacing, four pending keys and eight-second origin deadlines.
There are no per-visitor Supabase fallback reads.

The frontend polls live-mode listings at five seconds plus existing jitter;
this is bounded polling, not push or an instantaneous-price guarantee. Private
card context remains at its previous one-minute cadence (seller context: 30 seconds), token-scoped and bounded
to 32 pages. A changed bid clears obsolete highest-bidder indicators until private
context catches up. Explicit action refreshes clear private overlays. Detail
context still uses its existing separate authorized refreshes and bid history.

Each accepted bid sends a v2 HMAC covering both global revision and public auction
UUID, queued transactionally through pg_net. No bidder, amount or private assets
are sent. Live state is invalidated only for the affected auction. Listing order
and membership may change even for auctions absent from an old page, so all
listing selections are marked delayed by revisions until rebuilt. The UI labels
that condition and suppresses claims of exact current counts/page totals. This
includes price filters: the prior selected page is explicitly provisional until
its next full database revalidation; it is not silently filtered client-side.
Missed notifications are reconciled by the two-second live TTL and 30-second
listing-selection TTL. Legacy v1 notifications conservatively invalidate all.
Out-of-order v2 notifications remain effective per auction. Invalidation metadata
is bounded to 512 auctions; evicted revisions become conservative global hints.

When live verification fails, cached catalogue facts can remain visible for up
to five minutes. Prices, outcomes, countdowns, availability and bid controls are
omitted. Seven card/detail render paths use the catalogue-only component. Browser
refresh failures similarly mark retained auctions unavailable, and featured
failures no longer leave an old bid advertised as current. Authentication/privacy
failures still clear private snapshots rather than using fallback.

A single failure pauses its RPC family for 30 seconds; live failures are scoped
further to their auction/batch IDs, so one failed auction does not block another.
Failure metadata is bounded to 48 entries. One Home timeout does not block live
reads. Config/key/auth failures, failures across two distinct RPC families, or
three distinct failing live batches in the current 30-second window open a global
30-second breaker. Recovery
probes still pass through the same serial bounded scheduler. A family timeout
cannot multiply concurrency. Missing RPC/permission/invalid-response failures do
not by themselves count as database-wide pressure. Existing eligible cached data
remains readable through breakers; unverified dynamic fields do not.

## Required owner rollout order

1. Review migrations 170/171/172 and local changes. Verify actual applied state;
   do not rerun an already-applied migration based only on its queued filename.
2. Deploy the new cache Worker with `LIVE_AUCTION_STATE` absent or `false`. It must
   accept both notification signatures before SQL starts sending v2. Retain the
   existing object names, bindings, public credentials and signing secret.
3. Apply unapplied 170 then 171 then 172 manually. Matching bot migration copies
   are alternatives, not a second set to execute. No bot rebuild/restart is
   necessary for this SQL-driven accepted-bid trigger or these public read RPCs.
4. Deploy the frontend with catalogue-only guards and live-state polling support.
   Keep the cache flag false until this deployment is confirmed. Older clients
   may still have open tabs: reload them before enabling the new protocol. Since
   open tabs cannot all be forced to reload, the new mode requires the opt-in
   request header described below; older clients continue the legacy response.
5. The opt-in header is `X-Khub-Live-State: 1`; the website proxy forwards only
   that fixed value, never browser credentials. Enable `LIVE_AUCTION_STATE=true` only on the cache Worker. Check HIT/live,
   provisional-order and catalogue-only behavior in a controlled preview first.
   Record source/deployed Worker versions separately from database SQL state.
6. Compare per-RPC interval statistics, queue/timeout codes, snapshot metadata,
   origin latency and database resource/wait charts for the same traffic window.
   Local fixture timings are not proof of production capacity.

Rollback the mode by setting the cache flag false while retaining the compatible
Worker and frontend. Do not roll back to a v1-only invalidation receiver while
SQL sends v2. Keep queued scripts in place until the owner applies and moves them.
No QUICKSTART guide changes are required.

## Validation

Focused Node suites exercise visitor coalescing, cross-key live reuse, scoped and
out-of-order invalidation, forged signatures, restart persistence, catalogue-only
privacy, global breaker escalation, bounded fallback age, private overlay scope,
queue release and actual server-rendered unavailable guards.

The isolated PostgreSQL suite applies the queued SQL to a disposable database,
checks public field parity, batch bounds, unpublished exclusion, RPC/sender ACLs,
bid revision increments and actual v1/v2 HMAC payloads using a local stub transport.
Financial function definition fingerprints match. No real notifications/assets
are sent by tests. The existing detail-history marker mismatch is independently
reproducible without migration 170 and remains separate.

Final local checks: 93 focused Node tests passed; both projection/live-state and
historical Buy privacy/availability PostgreSQL suites passed. Production build,
secret scan and changed-file lint passed (one existing Fast Refresh warning).
The full Node run passed 393 tests and retained the same 25 previously observed
failures, including the existing auth expectations and render/hook harness issues.
The new mode remains disabled unless the Worker flag AND client capability are
present. Catalogue/order delays are explicitly visible rather than silently
presented as live bidding information. No production effect has been measured.
