# Bot bid-priority release

Updated November 10, 2026 after starvation/recovery review. Local implementation;
no production SQL, deployment, connected worker or transfer. Personal bot quickstart
unchanged. Bot files are ignored: include them in the owner's separate bot release.

## Priority and queue progress

Three new bid/buy messages received within a minute, or ten pending bid/buy
messages of any age, activate priority for one minute after last detection.
Confirmed replays do not activate it. Migration 250 also adds a boolean to the
existing cycle plan: an active auction within 90 seconds of closing (or <=30 seconds
overdue), with three accepted bids recorded within a minute. This renews priority
for a minute. Hints never authorize money/items and require no new polling RPC.

Priority ordinarily allows two delivery operations / two seconds per cycle. When
pending work has persisted for a minute, or the database's oldest pending delivery
is a minute old, it gets up to six operations / eight seconds. Fresh solvency,
claims, exact send/ack and unknown-send recovery are unchanged. Buy preparation
keeps one bounded operation per priority turn and its existing rotation.

Cleanup ordinarily allows two approved deletions / two seconds during priority.
At 12 approved messages, or with retained mail a minute old, it gets up to six /
eight seconds. Normal cleanup keeps 50 / ten seconds. Every deletion still requires
fresh database approval and one-second pacing. Failed deletions retain their source
mail, receive a one-minute cooldown, and rotate behind other eligible work. Duplicate
IDs from overlapping SQL approval branches are deduplicated. Approval-read failures
perform no deletions and have a 30-second cooldown; they do not back off financial
intake. Database approval still protects uncertain transfers and unsettled refunds.

Budgets yield BETWEEN operations; a single slow send/ack can exceed a budget.
Ordinary closet work waits up to five minutes before a bounded turn, even if priority
continues. Financial maintenance, complete scans and recovery remain mandatory.
Assets remain in inventory under unchanged ledger/reserve protection during deferral.

## Bounded replay progress

Each cycle attempts at most two 128-message classification reads, each with its own
two-second deadline. A rotating cursor and bounded exact normalized-payload SHA-256
fingerprints retain confirmed ordinary-mail progress (at most 10,000 entries).
A successful earlier batch survives a later failure. Changed payloads, missing mail,
recovery/capability state changes and ordinary five-minute expiry invalidate progress.
Expiry is suspended while an incomplete intake pass is actively resuming so expiry
cannot repeatedly erase progress. Restart loses only this memory optimization.

Only ordinary normal-mail BID/BUY/LIST/FUND/FILL/bid-help receipts can reuse progress;
gifts, account jobs, donation policy reviews and raffle intake keep their existing
fresh paths. Confirmed ordinary intake RPC outcomes also advance progress. There is
no success inference after an uncertain write. Durable pending bid/raffle queues
always override remembered results; source deletion and asset dispatch retain their
own fresh checks. Fingerprints are not financial authority or persistent storage.

Timeouts, malformed responses and other request failures have separate safe log
categories, without raw errors/payloads. Timeout cooldown is five seconds; malformed
or other failures use 60 seconds. Optional classification failures no longer enter
whole-worker exponential database backoff. Actual financial RPC failures retain it.

At most 24 ordinary unclassified fallback messages are processed per pass. Durably
pending bids are exempt: fresh bids continue in database-required receipt order even
if optional classification is unavailable. If ordinary fallback work remains,
approved cleanup can proceed, but the scan is not completed and asset dispatch,
settlement and optional sends wait until intake is safely accounted for. Partial
passes expose waiting counts and an explicit resumption reason. This is a safety
barrier, not permission to dispatch against unaccounted attachments. Special gift/
review paths retain existing proof rules rather than guessed terminal cache states.

## Optional work cannot be suppressed forever by priority

One optional worker task and one optional runtime task get opportunities per
completed cycle. Eligible overdue tasks rotate by scheduling deadline:

- Reminders retain their one-minute cadence even under financial backlog. An overdue
  opportunity may send one attachment-free reminder despite pending deliveries;
  existing permission/deadline checks and durable at-most-once claims remain.
- Bot-owned discovery: one-minute cadence, at most two extra minutes of deferral.
- Giveaway announcements: one-minute cadence, at most one extra minute of deferral.
- Market refresh and regular chat: one-minute eligibility checks, at most five extra
  minutes of deferral. Their own daily/six-hour schedules still prevent extra sends
  or refreshes. Market refresh remains background/nonblocking.

These are opportunity bounds plus cycle/operation latency, not hard wall-clock
execution guarantees. They never override shutdown, rollover, incomplete intake,
financial safety stops or underlying retries. No ambiguous optional send is retried.

## Sent Mail

Sent Mail remains evidence for uncertain-send recovery; no deletion was added.
It is not scanned on every ordinary poll. Recovery first requests ledger candidates
and only scans when nonempty, up to ten pages. Large history can slow recovery or
hide older evidence, but there is no evidence it slows normal inbox polls.

## Release and verification

These review fixes require only a separate bot rebuild/release; no additional SQL.
If outstanding, apply queued 250 once after verified 249 for the closing-window hint.
Its ignored bot copy is an alternative for the same database, not another script
to apply. Do not rerun an installed migration. No website release needed. Keep only
one connected worker. The bot works without 250 using inbox-based priority alone.

All 98 targeted tests passed on Node 24.22.2. These checks cover persistent inbox/outgoing queues across sustained
bursts, conserved fixture assets and no duplicate dispatch, classification outage
and partial success, exact-payload changes, expiry/resumption, recovery overrides,
new-bid progress, cleanup approval/deletion failures, optional task resumption and
reminder at-most-once behavior. Existing targeted scan-barrier, send-budget, replay,
market/chat and database-recovery tests are included. The full suite was not rerun.
Earlier mixed-asset PostgreSQL regressions remain separate evidence; no financial
SQL, financial lock or transfer-protocol definition changed in this review fix.

Measure actual receipt-to-intake age, retained inbox size, oldest pending delivery,
partial passes and classification failures with before/after statistics. Sustained
arrivals above bounded service capacity can still grow queues; slow individual KoL
operations can exceed budgets. These local simulations are not production capacity
proof, and genuine incomplete/unknown intake must still delay financial dispatch.
