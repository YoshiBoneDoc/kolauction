# Mr. A Sell payments

Implemented locally November 7, 2026 for ordinary Sell and Bundle auctions in
Direct and Escrow modes. **Mixed Escrow creation defaults to disabled.** No
production SQL, deployment, connected worker or real transfer was performed.

## Payment rules

- Optional acceptance defaults off. Mr. Accessory is item **194**. The existing
  daily lowest-unrestricted-Mall snapshot supplies the reference. Creation reads
  its indexed database row once and rejects unavailable, missing, future or
  26-hour-old observations/checks. The UI reuses batched/coalesced cached reads;
  no new polling or KoL price requests were added.
- Hosts choose an integer rate within inclusive ±5% bounds, defaulting to the
  exact quote, with 100k adjustment buttons. Rate, reference and observation are
  frozen at creation. Manual relisting gets a fresh quote; automatic retries of
  the same auction retain the original rate even after the quote becomes stale.
- Bid `amount`/auction `current_bid`/`final_price` are Meat-equivalent values.
  `payment_meat` and `payment_mr_a` are physical assets. Legacy null Meat fields
  mean the original Meat-only amount. Numeric/BigInt intermediates preserve the
  existing exact transport boundary; Mr. A quantity has no extra business cap.
- Buyouts keep all attached Mr. A's, accept precisely the remaining Meat needed,
  and refund excess Meat. If Mr. A value alone exceeds buyout, reject and return
  the entire original payment. Never choose a subset of the items.
- Calculate tiered/promotional fees on full winning value. Collect only
  `min(calculated fee, physical Meat)`. Record calculated, collected and permanently
  waived amounts separately. Sellers receive remaining Meat and every Mr. A.
  Promotional volume uses full value; its fee field records actual collection.
  No waived amount becomes debt or a future balance.
- Buy auctions, giveaways and raffles retain their original rules.

## Financial implementation

[237](../supabase/migrations/queue/202611070237_mr_a_direct_payments.sql:1)
adds shared terms/composition and Direct creation/bidding. Direct calls retain
existing authorization, ignores, restrictions, increments and anti-sniping.
Composition is recorded before buyout finalization freezes Direct reminders.

[238](../supabase/migrations/queue/202611070238_mr_a_escrow_payments.sql:1)
extends the existing escrow intake and settlement implementations using checked
source anchors. Unexpected installed definitions abort the migration. It retains
all outer receipt, gift-proof, complete-scan, chronology and recovery wrappers.

- Original normalized receipts and payload comparisons remain unchanged. A mixed
  bid accepts only Meat and item 194. Noncanonical duplicate normalized item IDs
  stop for review; the bot already groups them exactly. Neither asset is rewritten
  into a fictional Meat deposit. Unproven gift contents remain blocked.
- Bid/receipt linkage stores the accepted physical composition. Outbids refund
  that composition to its original owner; rejected payments return all assets.
  Excess buyout Meat has its own deterministic receipt-linked refund plan.
- Existing reserve scans now emit physical Meat and item 194 from the same auction
  scan. Held/timing-review mixed auctions retain both their lot and bid assets.
  Posted gift contents transfer from unposted reserves into auction reserves
  atomically, without double counting. Queued/sending/unknown rows retain their
  existing physical liabilities and ownership.
- Settlement freezes a private fee record with exact identity and replay checks.
  The active reserve becomes the existing deterministic delivery rows atomically.
  Seller Meat and Mr. A's, and winner lot components, remain distinct obligations.
  Finalized payment composition cannot be rewritten. Actual collected commission
  continues through the existing commission/closet protections.
- No transfer, acknowledgment, reconciliation or automatic-resend path was added.
  Existing chunks, exact claims/acks, gift proof, preparation holds, unknown-send
  barriers and full inbox scans still govern delivery. Partial confirmation cannot
  complete an auction before its remaining asset obligations are confirmed.
- Private administrator refund references now include the Mr. A rows. Non-admin
  history still omits these references. Public projections carry only payment
  quantities/value and locked terms, with existing bidder privacy.

The creation switch only gates new Escrow listings. Disabling it cannot interrupt
bids, refunds or settlement on previously created listings. Direct support remains
available independently. The bot's ignored code/SQL copies are part of its separate
release process; never force-add them to the website repository.

## UI, reports and performance

Creation, fixed-rate details, bid/history/results and participant instructions show
physical payment alongside equivalent value. Compact cards keep their existing
value display and link mixed bidding to details. Escrow KMail instructions explain
full funding, exact refunds and safe buyout composition. Fee previews explain the
Meat-only collection cap; seller outcomes show actual proceeds and waived fees.

Bot financial history/totals distinguish physical proceeds, Mr. A quantities and
waived fees from trade value. Public trade totals keep full equivalent value and
count actual lot plus payment item units, without counting refunds as trades.
Direct reminder and support-query messages preserve exact payment composition.

No new public polling, joins to external tables on listing pages, global lock IDs,
transfer concurrency or cache TTLs were introduced. Legacy Meat-only bid validation
skips the new composition lookup. A server-generated marker selects mixed payment
message formatting; legacy messages immediately use their existing formatter,
without an extra auction lookup. All financial writes retain the existing lock;
market network I/O never occurs inside it. Settlements add only their durable
per-auction fee record and actual asset queue rows.

## Verification

Node 24 website: **550 passed, 21 failed**. The failing names match clean HEAD
with the same dependencies/ignored bot (529 passed, the same 21 failures). All
**21 Mr. A policy/transport/form/UI tests passed**. Full mocked bot: **458 passed**.
Build, changed-source lint and secret scan passed; existing large-chunk build
warning remains. No browser visual QA or production balance verification was run.

Disposable PostgreSQL passed:

- `mr_a_escrow_database_test.py`: normal and proven-gift mixed intake; exact
  outbid/rejection/excess refunds; physical/held reserves; duplicate and changed
  receipts; competing ordered connections; complete-scan/grace barriers; unfunded
  bid rejection; all-Mr. A payments; capped, zero and promotional fees; frozen fee
  replays; same-item bundles; large quantities and deterministic chunks; creation
  disable without abandoning existing obligations; automatic retries; private
  admin references; partial deliveries; preparation holds; unknown-send reserves;
  verified sent/not-sent recovery; duplicate acknowledgments; exact operator
  reports and public totals.
- Existing Direct Mr. A, automatic-relisting, receipt-time, anti-sniping,
  bot-resilience, incoming-gift, gift-isolation and Buy-order suites passed.
- The existing bundle suite stops at its outdated `bundle_items` card-context
  assertion; the identical failure was reproduced on clean HEAD. New mixed
  Bundle deposit/settlement/ownership tests pass. Do not claim every suite is green.

All database fixtures are synthetic disposable clusters, not production transfers.

## Owner-controlled rollout

1. Verify installed prerequisites through 236 and exact financial definitions.
   Stop the sole connected worker. Apply 237, 238, then audit fix 239 once per database, skipping
   only scripts independently confirmed installed. Website queue and standalone
   bot copies are identical alternatives; never apply both copies.
2. Deploy the compatible cache Worker first, then the website. Rebuild/release the
   ignored bot code for Mr. A parsing/reporting, then resume only one worker.
   SQL 238 leaves mixed Escrow creation disabled throughout this step.
3. Check deployed versions and database-only configuration/queue evidence. Only
   after owner approval, activate new creation with privileged SQL:

   ```sql
   select public.set_mr_a_escrow_enabled(true);
   ```

To pause new creation, use the same RPC with `false`. Keep compatible SQL and bot
code operating until every existing mixed obligation is resolved; disabling new
creation does not authorize downgrading reserve/accounting code. Do not rewrite
receipts, frozen terms, sent bodies or unknown deliveries during rollback.

Migration 238's checked anchors intentionally fail closed on unexpected installed
source. Investigate such a mismatch rather than bypassing the checks. Operator
approval is still required for any production migration, deployment or transfer.

## Independent audit

The [audit findings and verification](MR_A_AUDIT.md:1) require additive migration
239 before rollout. It fixes the large Mr. A gift-proof boundary and makes missing
activation configuration fail closed. Updated bot review reserves and valuation
input handling have targeted regression tests. The gate remains disabled; no
production action was performed.

## Mixed seller payout KMail (245)

Additive queued **202611080245_mr_a_payout_mail.sql**, after 244, changes future
mixed seller payout wording to Winning bid / Total bid value / Commission / Your
proceeds / Attached. Remaining-proceeds text appears only for an incomplete envelope.
It enables these payouts in the existing guarded multi-attachment KMail claim,
using the same queue-plan, recipient, message/footer, item/Meat limits and held-row
checks. Physical queue rows/dedupe keys remain separate and unchanged. The batch
freezes the exact aggregate attachments; one acknowledgment handles the envelope.
Gift-required recipients retain the existing known-unsent split/individual package
fallback. Size limits and verified recovery can also result in separate envelopes.
No sent, uncertain, or already frozen messages are rewritten.

Apply once with the sole connected worker stopped, then resume that same worker.
No website or bot binary changes required; matching ignored standalone bot SQL
copy provided. Not applied to production. Disposable mixed escrow regressions cover
combined payment text/actual assets, unknown-send holds and reconciliation, duplicate
acknowledgments, verified-not-sent recovery and idempotent gift splitting, alongside
fees/promotions/refunds/Meat-only compatibility.
