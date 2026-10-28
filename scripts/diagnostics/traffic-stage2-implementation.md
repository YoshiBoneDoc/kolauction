# Giveaway readiness: second implementation batch

Implemented locally October 28, 2026. No production SQL, Oracle deployment,
worker restart, real KoL login or financial transfer was performed.

The [bot rollout and safety notes](../../bot/RESILIENCE.md) describe behavior,
deployment order and the boundaries of automatic recovery. Migration 127 is in
the website queue, with an identical standalone copy under `bot/supabase/`.

## Files

- `supabase/migrations/queue/202610280127_bot_resilience_and_gift_accounting.sql`:
  shared unqueued commission reserve, safe preparation deferral ledger/selector,
  minimal worker status and uncertain-row indexes, operator wait visibility.
- `bot/src/database-recovery.mjs`, `runtime.mjs`, `store.mjs`: explicit transient
  classification and bounded whole-cycle backoff, preserving durable recovery.
- `bot/src/worker.mjs`, `incoming-gifts.mjs`: lightweight status; idempotent
  known-non-attempt bookkeeping; transient errors remain database failures rather
  than malformed-gift reviews; uncertain sends retain the existing recovery path.
- `bot/src/health.mjs`, `supervisor.mjs`, `inspect-report.mjs`: database-wait
  health and visible preparation waits, without marking paused cycles successful.
- Bot test fixtures now provide `bot_worker_status`; new recovery and SQL suites
  exercise the updated contract. Packaging includes the new tests/rollout notes.

## Evidence

- All 323 bot Node tests pass. The new resilience SQL suite passes against both
  the website schema and the packaged standalone bot schema.
- The SQL reproduction yields the exact recorded 18,170 Meat liability gap
  (19,220 including reserve/wrapping). The old SQL incorrectly holds 24,520
  commissions as unknown surplus; corrected SQL holds zero in that constructed
  no-surplus case and retains all existing obligations and verified cash limits.
- A separate 777 Meat / three-item unidentified surplus remains protected before
  and after simulated payouts, fee queueing, closet completion and DB restart.
- Known-unsent bookkeeping deduplicates by delivery/attempt, refunds wrapping
  exactly once, does not starve unrelated refunds, and excludes real unknown
  sends from automatic retry.
- Lightweight status matches the full report's coordination flags/isolations,
  exposes no message/credential payloads, uses a partial uncertain-row index with
  10,000 sent notices and progresses while the global financial lock is held.
- The existing full-schema intake suite passes: receipt/replay/retention rules,
  financial locks, exact refunds, private audits and duplicate prevention remain.
- The existing finalization suite passes, including both exact 200M sale paths
  (confirmed and uncertain/restart/recovery).

The prior intermittently failing 200M fixture created its BID receipt before
committing the listing deposit. Parser/database startup could cross a clock
second, making the existing before-deposit receipt guard correctly reject it.
The fixture now creates the BID after activation. The production timing guard
and all financial assertions remain intact.

No historical review was resolved automatically. The original payout D-1523
has no newly recovered failure snapshot here; reproducing these refund failures
does not prove that every earlier gift incident had the same cause.
