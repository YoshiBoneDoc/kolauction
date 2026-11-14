# kHub roadmap

Repository audit: November 2, 2026. Remaining work only; implementation is not proof
of production deployment. Start with [the handoff](HANDOFF.md:1).

## NEED TO FIX:
- Implement the lifetime completed-escrow-sales loyalty backend; the [leaderboard tier preview](src/pages/Leaderboards.jsx:59) includes a private personal-sales progress read/display; commission calculation and permanent tier settlement remain unimplemented. Thresholds: Base 0, Silver 50M, Gold 200M, Platinum 1B, Diamond 3B; proposed flat rates and settlement rules are not active.
- add barter corner

## Future leaderboard fee implementation — preserve trade terms

Leaderboard fee perks are currently display-only. When implementing them, lock
in the player's eligible reduced escrow rate when they create a trade while
holding a qualifying leaderboard position. Persist those fee terms with the trade;
do not recalculate them upward from the player's ranking at settlement.

Losing the position must not increase fees on existing active trades. Those trades
retain their original reduced rate through completion, including across restarts
or delayed settlement. Only new trades created after the player loses the position
use the higher rate applicable to their current eligibility. A later ranking change
must never rewrite already locked or finalized fees.

When multiple leaderboard perks apply, select the best eligible rate without
stacking benefits; the top donor's full waiver takes precedence. Preserve the
existing financial safeguards and verify loss of leadership between creation and
settlement, new trades after loss, and concurrent ranking changes in regression
tests before activation. No fee or settlement behavior is implemented by this note.

## Traffic reliability — current priority

Priorities informed by the [November 10 event evidence](docs/NOVEMBER_10_GIVEAWAY_PRESSURE.md:190).
Active paging/I/O stalls are confirmed; a faulty individual query plan and the
cause of every earlier timeout are not established. Bot settlement progressed
without a recorded crash or database-wait episode; preserve current safeguards.

1. **RAM headroom:** verify compute tier and evaluate a memory increase outside
   live auctions. Compare swap-in/out, major faults and memory/I/O pressure under
   comparable load afterward; verify improvement rather than assume a tier fixes all timeouts.
2. **Static detail:** largest aggregate read cost in the event-tail interval
   (34 calls, 291ms mean); inspect installed definitions/wrappers and representative
   plans. Separate intrinsic query work from shared paging delay.
3. **Home/public browse:** ~706/676ms means in that interval despite low call
   counts. Profile candidate visibility, scoring/quote reuse and work before
   pagination; retain abandoned-draft filtering, privacy and financial rules.
4. **Cleanup approvals:** secondary target (~221ms mean; a sampled query reached
   1.31s). Review receipt/delivery/batch checks without weakening deletion evidence.

- Continue private card/bid-history and redundant account/admin-check profiling
  where measured cost warrants it; preserve access checks and existing read reuse.
- Correlate cache misses, queue failures, origin timeouts and invalidation churn
  with resource metrics and bot progress. Preserve overload protection; no captured
  financial-lock waits justify increasing financial concurrency.
- Reuse the [bounded capture guide](docs/AUCTION_LIVE_CAPTURE.md:1), retain bot/error
  logs, and avoid heavy diagnostics at peak. The collector was verified live;
  a missing end snapshot must be replaced with an explicitly timed valid export.
- Split routes/catalog loading to reduce initial browser JavaScript.
- Improve safe error diagnostics and foreground read deadlines/priority.

## UI follow-up requiring owner review

- Confirm desired Meat-stack artwork beside totals and larger Trade totals title.
- Reproduce the reported seller-profile filter/navigation inconsistency. Current
  default is All; URL parameters control selection. Do not assume the old report
  still reproduces.

## Operations and reliability

- Verify actual deployed website/cache/bot versions and applied SQL prerequisites.
- Establish private bot release history and a verified last-working release.
- Configure external host availability alerts and private off-device backups,
  encrypted database backup retention/failure alerts, and an isolated restore drill.
- Define outage, late-bid and agreed Direct-trade extension policies and UI.

## Moderation and discovery

- Assess remaining abusive-listing/dispute adjudication gaps against existing ban,
  appeal, report, withdrawal and admin review tools; do not rebuild completed tools.
- Review dependency security alerts.
- Add seller-name search with existing identity/privacy restrictions.
- Extend seller history with reviewed withdrawal/default outcomes.
- Define a completed-sales gallery. Public trade totals and admin analytics already
  exist; any new public statistics must preserve buyer anonymity/accounting rules.

## Future features

- Item/Meat/mixed offers with acceptance, replacement and refund rules.
- Private offer review and unanswered-offer reminders.
- Auction/bid archival retaining financial and moderation evidence.
