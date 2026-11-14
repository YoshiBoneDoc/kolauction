# Escrow fees and promotions — local implementation, activation disabled

November 14, 2026. No production migration, deployment, activation, promotion end,
connected worker, or real transfer was performed. The owner's quickstart is unchanged.

## Authority and normal rates

PostgreSQL selects eligibility, calculates fees, locks trade terms, and records
settlement decisions. Browser quotes are advisory RPC responses; neither the site
nor bot selects the new financial rates independently. Legacy JavaScript arithmetic
remains for legacy fixtures, not the active quote/funding UI.

[269](../supabase/migrations/queue/202611140269_escrow_fee_engine.sql:1) defines the
Leaderboards schedule in integer basis points. Thresholds use completed escrow
Sell value (including Bundle/mixed value under the existing Sell classification),
not Buy purchases, Direct trades, pending bids, deposits or donations. A unique
sale ledger increments permanent earned tiers; a crossing sale benefits subsequent
trades. Earned tiers never decrease. The seed reads completed sales once.

Normal flat bands are [0,10M), [10M,100M), [100M,1B), [1B,infinity).
Each rate applies to the whole Sell value or accepted Buy fulfillment value;
round down once. Base: 5/4/3/2%; Silver (50M): 4/3/2.5/1.5%; Gold (200M):
3/2.5/2/1.25%; Platinum (1B): 2.5/2/1.5/1%; Diamond (3B): 2/1.5/1/.5%.
Top Meat/Trades leader: 1/1/.5/.5%; #2/#3: 1.5/1.25/.75/.5%.
Choose the lowest eligible rate; top donor is zero. Direct remains free.

Financial ranks use the existing published totals and maintenance cadence (five
minutes), positive totals, verification/restriction checks, owner exclusions, and
UUID tie-breaks. Financial selection reads bounded index-ordered top-three/top-one
candidates, not transaction history. Ignores hide names without changing global
positions. Private leaderboard responses preserve rank gaps and include the
viewer's financial eligibility; no hidden identity is returned.

## Creation and settlement

[270](../supabase/migrations/queue/202611140270_escrow_fee_integration.sql:1) locks
normal rates/eligibility at listing creation, including pending deposit/funding.
Losing rank or earning another tier later does not rewrite that trade's terms.
Future promotions attach to trades created during their server-side active interval.
Their published configuration is immutable; expiration or manual cancellation
stops assignment to new trades but does not remove it from existing trades.
Buy orders retain the promotion for all later fills.

An introductory allowance is NOT reserved at creation. Each settlement checks
completed promotional volume immediately before that transaction, serialized with
other Buy/Sell settlements. The whole transaction is free when that prior volume
is below the allowance, even if the transaction crosses it. Future promotions
have separate allowance balances, shared across their Buy/Sell trades; completed
pinned trades can continue to consume their own promotion's allowance after it ends.

Normal fees are seller commissions for Sell, deducted from proceeds. Buy fees are
paid by the order creator in addition to principal; sellers receive full payment.
New Buy funding/reservations use a conservative per-unit ceiling at the largest
locked applicable rate, covering arbitrary partial-fill sizes and rounding. This
can exceed the estimated fee for one full fill. Surplus follows existing refund
barriers. Legacy orders keep their original funding and reservation ceilings, and
new charges cannot exceed their original fee. Mixed payment keeps the Meat cap,
full Mr. A payout, calculated/collected distinction, and permanent waiver ledger.

Each new fee decision freezes its transaction key, auction, payer, value, normal
fee, promotion, and resulting fee. Changed identity fails; replay returns the
original decision. Existing receipt, scan, solvency, reservation, delivery and
unknown-send guards remain in their original callers. Completed/finalized financial
records and frozen messages are not repriced or rewritten.

## November exceptions retained intentionally

November is registered as the existing live promotion, not a new allowance period.
Installation preserves its enabled flag, exact volume ledger and keys, existing
fees/timestamps, grandfathered flags, indefinite duration, and public green/blue
messages. There is no forced refresh, end, reset, or activation on installation.

These November rules differ from future promotions:

1. **Progressive rates:** 2% of the first 1B plus 1% above. Future promotions use
   configurable flat whole-transaction brackets, separately for Buy and Sell.
2. **Settlement-time promotion selection:** November continues to affect eligible
   unfinalized trades while live, including older trades. Ending it stops its
   application at subsequent settlements, as before. Future promotions attach at
   creation and survive expiration/cancellation for those trades.
3. **Fixed grandfathered Buy cohort:** `promotional_remaining_free` continues to
   waive remaining November fills for its existing cohort. No cohort is rebuilt,
   expanded, or copied into another promotion.
4. **Legacy allowance ledger:** November continues using its existing shared
   ledger and pre-settlement sum. Future promotions use indexed aggregate balances
   backed by unique transaction records.

The shared whole-transaction introductory eligibility rule stays the same for
both. The explicitly requested November change is a comparison against cheaper
locked normal benefits (including the donor waiver), once the owner activates the
engine. Existing completed fees remain unchanged. Legacy open trades captured at
activation additionally retain their historical normal fee ceiling.

## Compact administration

[271](../supabase/migrations/queue/202611140271_escrow_promotion_controls.sql:1)
provides one administrator RPC for status, draft save, read-only preview,
publication, ending, and cancellation. There is no separate administrative workflow.
Drafts may conflict; publication cannot. Published intervals are serialized and
checked as [start,end), including indefinite November. A new promotion cannot
replace it. Schedule selection uses database timestamps on every financial path;
it does not need an open admin page or a background activation job.

Rates use integer basis points (percent inputs allow two decimal places), sorted
whole-Meat boundaries beginning at zero, 0-100% rates, selected earned tiers,
optional shared allowance, lower-only or replacement composition, and explicit
preservation/override of the locked donor waiver for replacement policies.
Lower-only always preserves every cheaper normal benefit. Custom messages are
plain text; blank fields use generated descriptions. No promotion means no public
promotional text. November text is preserved verbatim.

Preview calculates synthetic examples through the settlement calculator without
changing balances or live configuration. A revision/configuration/date confirmation
fingerprint ties publication to its preview. Editing invalidates it. Publication
rechecks authorization, dates and conflicts. Mutations have request identities,
optimistic revisions and compact audit records. Uncertain responses trigger status
reconciliation rather than automatic writes. The old toggle cannot resurrect a
promotion or bypass these checks. History is bounded; at most 25 drafts are allowed.

## Owner-controlled rollout — do not execute without approval

1. Verify installed prerequisites through 268 and actual website/bot versions.
   Migration placement alone is not proof of installation. Take the normal backup.
2. Stop the sole connected worker for installation of the financial chain. Apply
   queued **269, 270, 271, 272**, once each in order, to the same database. Matching
   `bot/supabase/migrations/` files are alternatives, not another set to apply.
   Do not rerun historical scripts or move queued files automatically.
3. Install compatible site/bot code before exposing the new admin interface.
   No cache Worker financial calculation is added. Resume the sole worker using
   existing operating procedures. November continues with its original charges
   while the new engine gate is disabled; drafts/preview are available but new
   promotion publication is blocked.
4. Obtain separate explicit owner approval before calling the service-role-only
   `public.activate_escrow_fee_engine()`. This captures existing unfinalized open
   trade terms once, enables new normal rules and cheaper November comparisons,
   and leaves November active. It does not reset promotional volume. Missing fee
   configuration/terms fail closed. Do not activate through a browser credential.
5. Verify quotes, private rank displays, a safe operator-reviewed transaction and
   conservation reports. End November only through an independently confirmed
   owner action. Ending November before engine activation would retain the legacy
   fallback; activate the approved normal schedule first for the planned transition.

Do not downgrade SQL/code after activation with live pinned promotion obligations.
Ending a future promotion is not a rollback of already locked terms or charges.

## Local verification

- New disposable PostgreSQL engine suite: migration gate, preservation of existing
  November ledger, all normal band boundaries, rank/ignore behavior, rank loss,
  donor waiver, November allowance/cohort, replacement reserve, concurrent shared
  allowance, preview/conflicts, scheduled selection, retained future rates after
  cancellation, legacy funding, real partial Buy fills/replay/refund, real Sell
  settlement through scan barriers, and mixed Mr. A caps/waivers all passed.
- Existing Buy orders, reservations, receipt-time, resilience, Buy privacy and
  leaderboard disposable database suites passed.
- Node 24 website suite: 644 passed / 20 failed. Clean HEAD comparison: 639 passed /
  21 failed; no new failing names. One obsolete Buy explanation assertion was
  corrected. Full suite is not green.
- Mocked bot suite: 486 passed / 1 failed. Remaining failure is in unchanged
  `transport.mjs` handling a null parsed command (`escrow.test.mjs`, malformed mail).
  Financial report tests pass with generic Fee labels. Follow-up: null raw mailbox
  entries are now skipped before processing; all 95 escrow tests pass, including
  that original failure. Other malformed entries retain their safeguards. The full
  bot suite has not been rerun after this targeted fix. No live worker was run.
- Build, changed-source lint and secret scan passed. Browser visual QA and hosted
  database verification remain outstanding; local fixtures do not prove live balances
  or production capacity. PostgreSQL's production DELETE safeguard extension is not
  installed locally; no safeguard was disabled.
