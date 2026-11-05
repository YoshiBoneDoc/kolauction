# Bot work scheduling and database pressure (migration 230)

This release changes the ignored standalone bot and adds matching SQL. Local
implementation/tests do not identify the currently running Oracle image or schema.
It does not deploy, start a worker, apply production SQL, or send real assets.

## Apply order

1. Verify prerequisites through 229 against installed definitions. File location
   is not proof of application; do not rerun already-applied scripts.
2. Apply `supabase/migrations/queue/202611050230_bot_work_scheduling.sql` manually.
   The matching `bot/supabase/migrations/202611050230_bot_work_scheduling.sql` is
   the same script for standalone packaging: apply only one copy to one database.
   Move the queued website copy only after successful application. The transaction
   has a two-second lock wait and a sixty-second statement deadline. Unexpected
   installed function layouts abort the migration rather than silently changing
   safety rules. A timeout rolls back; inspect contention before retrying.
3. Bundle and rebuild the Oracle bot using the owner's existing quickstart.
   Its source is ignored by website Git: a website commit does not ship this bot.
   Stop the old worker before replacement. Never run a second connected worker.
4. Inspect capabilities, fresh safety responses and logs before normal operation.
   This release requires no website or Cloudflare Worker deployment.

The updated runtime retains the previous loop when the database has not advertised
`workerSchedulingVersion: 1`. SQL first is still the supported rollout order.
An old bot can use the existing RPCs after 230; those legacy raffle ticks now use
bounded accounting too. Rollback of the binary must not undo partial refund flags,
remaining reserves, queued obligations or existing receipts.

## Cadences and safety

- Full worker status is read at startup and at most ten minutes later, with an
  immediate reload if the fresh safety capability revision changes. Only version
  flags and the fixed mailbox-recovery capability are retained. Attention arrays,
  uncertainty, account pending state, mailbox isolation, closet review and site
  maintenance ownership are fetched fresh every cycle. Invalid responses stop
  processing; there is no fallback to cached safety. Future capability migrations
  must bump the revision in both the full and safety readers.
- Inbox scanning, gift evidence, complete-scan barriers and receipt deduplication
  stay on the existing cycle. A fresh post-intake plan shares delivery/Buy work
  discovery and due-task hints. Hints never authorize transfers. If any maintenance
  runs, dispatch discovery is read again; otherwise its same-cycle snapshot is
  reused. Saved reminders still make their own fresh priority check before claims.
- Auction maintenance runs immediately for due auctions, settling work, or new
  intake. Otherwise it runs once per minute. Buy and receipt-time maintenance
  performed inside complete inbox scans is unchanged. The existing financial lock
  remains. Incoming messages do not wait for a longer global polling interval.
- Idle closet housekeeping runs at most once per minute; new intake or dispatch
  work bypasses that idle delay. Full batches retain the existing five-second
  yield/rescan behavior. Solvency is still checked afresh before each transfer.
- Empty reminder and giveaway-announcement checks are spaced by a minute and yield
  to backlog work. This can delay optional notifications; their claims, deadline
  checks and uncertain-send rules are unchanged. Market/catalog refreshes already
  have their own cadences and were not given competing timers.

## Raffle work and exact accounting

State changes, supplies, queued obligations and delivery state changes append
small internal wakeups. They contain only raffle IDs, never player messages or
assets. Inserts do not take the financial/account/parent row locks. No-op delivery
or inventory updates do not append work. The tick deletes only visible committed
wakeups before processing; arrivals during a transaction remain for a later cycle.
A sixty-second fallback reconciles waiting work; the thirty-minute notice boundary
is also scheduled explicitly. Private access to wakeup rows is revoked.

Due-only draw readers reuse the installed intake, grace, frozen-input and fairness
barriers. Deferred manifests are excluded before reading their payloads. Future
beacon rounds wait until their fixed availability time; failed verified-beacon
retrieval persists backoff of 5, 10, 20, 40, then 60 seconds. A wrong raffle/round
cannot reschedule a different commitment. Restarts do not reset this schedule.

Refund and return processing uses a transaction-wide budget of 50 purchase/item
records across at most ten raffles, with at most twenty item returns per raffle.
Existing mail splitting can produce more than one delivery per record. Every
refund atomically marks its purchase queued, decreases held Meat by the exact
amount, and creates the matching deduplicated obligation. Every item return
atomically zeros only the processed inventory row and queues that exact quantity.
Remaining records retain their reserves. Incomplete batches remain immediately
due and rotate through the existing last-work ordering. No final settlement is
released before all batches are queued and all required transfers are verified.
Unknown sends never automatically resend. No parallel connected sender is added.

## Performance evidence

`[BOT_PERFORMANCE]` emits bounded minute aggregates plus a final summary at runtime
shutdown: RPC/cycle counts, failures, empty results, total/max elapsed time and
latency buckets (<10, <50, <250, <1000, <5000, >=5000 ms). Completed phase durations
cover intake, raffle work, auction maintenance, dispatch and cleanup. Yield counts
and the oldest pending delivery's age help distinguish backlog from idle checks.
The oldest-age lookup uses the existing pending-delivery index. Parameters, mail,
recipient IDs, URLs, credentials, raw errors and result bodies are never recorded.
These metrics cover the worker RPC path; separate catalog/market and operator
commands are not included. Metrics do not write telemetry into PostgreSQL.

Compare ordinary/peak periods at equal task volume: RPCs per idle cycle, empty
claims, cycle time, queue age, and database lock/execution timing. No production
benchmark or outage root cause is claimed by this release.

Offline validation includes full bot tests and the isolated full-schema lifecycle
suite, including cancellation batching, reserve preservation, rollback, concurrent
ticks, restart, wakeups, service-only access and frozen beacon commitments. Tests
use simulated delivery evidence and cannot prove real KoL delivery behavior.
