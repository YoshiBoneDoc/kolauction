# Home timeout follow-up — November 7, 2026

Production logged SQLSTATE 57014 at 16:52:15 UTC (11:52:15 Eastern), while
`read_home_cards -> home_cards_core -> is_abandoned_escrow_draft` was executing.
This establishes a database statement timeout, not its duration, caller identity,
traffic pressure or a financial failure. Connection age is not query duration.
Idle-tab recovery is a separate browser issue and does not explain away this log.

The owner supplied installed definitions. Home's recent section filters
`status='completed'` and then invokes the abandoned-draft helper. That helper only
returns true for cancelled/expired/voided listings, so the second predicate cannot
exclude any completed row. Migration 236 removes that one redundant call site.
All other abandoned-draft checks, visibility, ranking, page limits and projections
remain. The helper itself and financial routines are unchanged. A strict helper
body check aborts the migration if installed semantics differ from the inspected
version; no timeout, index, Worker limit or financial safeguard changes.

The disposable projection suite preserves the previous Home core, adds 1,000
completed listings, compares complete old/new payloads (except server_time) across
anonymous/owner/other/restricted/admin contexts, and profiles the recent selector.
It also preserves the existing browse/privacy checks and financial fingerprints.
Validation passed. Five recent-selector executions measured 5.001–5.288 ms /
683 shared buffer hits before, versus 1.133–1.434 ms / 446 hits after. Full Home
response parity and the financial fingerprints passed for all five viewer contexts.
These are constituent-query measurements, not whole-Home timings.

These fixtures do not reproduce production capacity or prove the timeout's sole
cause. Home still evaluates other ranking and projection work.

## Rollout

After verified prerequisites through 235, apply
`supabase/migrations/queue/202611070236_home_recent_filter.sql` once. The identical
`bot/supabase/migrations/202611070236_home_recent_filter.sql` is a standalone copy,
not an additional migration to run on the same database. No website/cache deployment
or bot restart is needed for this SQL-only change. The agent did not apply SQL or
run a connected worker. Do not edit/move already-applied scripts or reset counters.

After application, check Home as a guest and signed-in user, including returning
after idle. Capture new complete statistics snapshots over comparable intervals;
compare `read_home_cards` latency/calls and timeout frequency with Worker origin/
queue telemetry. If timeouts persist, capture controlled nested constituent plans
for the remaining Home work rather than claiming this change resolved the cause.
Browser retry fixes and this server-side optimization require separate verification.
