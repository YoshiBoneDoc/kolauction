# Closet recovery and one-time soft retry

Current policy: migration `202610290144_closet_soft_retry.sql`, applied after 143
and 142. Stop workers, apply outstanding migrations in order, install/rebuild the
matching bot archive, then restart. The personal Quickstart guide is unchanged.

## Owner-approved policy

A closet transfer gets **one automatic soft retry** after approximately five
minutes of readable, unchanged closet checks. This is an explicitly authorized
heuristic, not proof that KoL cannot complete the original request later. It
applies only to moving owned/unencumbered assets into the bot's own closet.
It does not enable retries of KMails, payouts, refunds, or escrow processing.

SQL requires five successful minute-scheduled readings spanning at least four
minutes, plus the original baseline and at least five elapsed minutes. The five
most recent readings must be readable and equal the original closet balance.
Partial/unexplained changes, competing unresolved closet writers, or changed
transfer terms stop automatic retry. Failed reads do not count. A short grace
period, up to roughly ten minutes, permits five good reads after a transient
read failure; inability to establish that window remains a review.

The retry budget has one row per transfer and survives restarts, lost RPC
responses and repeated observations. A failed retry is observed but cannot
receive another automatic soft retry. A submission that never entered the game
call may refresh its readiness/claim without spending a physical retry. Explicit
operator reconciliation does not replenish the automatic allowance.

## Checks before the retry

- Restore session readiness through GETs and verify the actual closet form.
- Read fresh balances before claiming the retry. If the expected closet increase
  has appeared, cancel the retry and record completion without another deposit.
- Quarantine unexpected/partial changes or changed asset/quantity instead.
- Keep all normal escrow liabilities, review holds and operating reserves intact.
  Where protected assets exist, require enough unencumbered headroom for both a
  possible late original and the retry. Without protected holdings, a single
  owned item stack can still be retried. Insufficient headroom leaves it queued.
- Require a recent pre-retry snapshot and a one-time durable submission fence.
- Hold later closet moves of that asset while this retry waits. Other funded
  operations and unrelated closet asset types continue.

A very late original request can still create a duplicate closet deposit. The
owner has explicitly accepted this bounded closet-only risk because the assets
remain in the same account and can be withdrawn. The policy does not claim that
five minutes guarantees server non-execution.

## Existing reviews and operator display

Existing 143 reviews caused solely by an unchanged/unknown outcome receive a
fresh observation window when 144 is applied. Original queued/request timestamps
and all prior observations are retained. Contradictory or partial-change reviews
are not automatically reopened for retry. This includes C-1061-style legacy
attempts: the new window can authorize the soft policy without inventing an old
submission fence.

`issues` lists active observation as an automatic wait. `issue C-...` and
`income M-...` show **SOFT RETRY 1/1** as queued, awaiting confirmation, completed,
or needing review. The audit records a `soft-retry` decision explicitly rather
than falsely recording that the original request definitely never executed.

## Foundation retained from 143

Session GET redirects to main/login are investigated before claiming new work.
Unrecognized forms or redirects to choice/action pages do not authorize writes.
An interrupted claim that was never armed can safely return to pending; stale
actors cannot arm or submit it afterward. An exact attributable closet increase
can confirm completion despite unrelated inventory activity. Already-completed
queued rows are repaired without depositing again; queued rows conflicting with
an unresolved authorized request are held for review.

Schedules, leases and observations live in PostgreSQL. Due work is bounded to
five attempts sharing one snapshot per minute. Indexed lookups return recent
observations rather than exporting historical records. Manual reconciliation
retires old schedules. Existing single-writer rules and holds for uncertain
outgoing deliveries remain intact. Do not manually alter a watched closet asset
or run another bot against the same account during recovery.

## Evidence and validation

The saved C-1061 evidence was an HTTP 302 to `/main.php` and unchanged immediate
balances. The installed primary client source, kol.js 0.15.4 (`dist/Client.js`
and `dist/domains/Closet.js`), establishes session/password-hash handling and the
modern Meat form; supported legacy and modern forms are recognized on the actual
returned page. No documented KoL five-minute execution bound, request-status
lookup by our C-reference, or server deduplication guarantee was found.

Sources: https://github.com/loathers/kol.js and
https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2

Offline bot tests and disposable PostgreSQL tests cover both form variants,
GET-only readiness restoration, one request per submission, durable attempt and
retry fencing, late-success cancellation, strict one-retry lifetime budget,
stale snapshots/readers, reserve protection, partial changes, legacy upgrade,
item transfers, manual reconciliation, and continued financial operations.
Tests simulate observation/deadline eligibility rather than sleep five minutes.
No live KoL mutations or production SQL are performed by these tests.
