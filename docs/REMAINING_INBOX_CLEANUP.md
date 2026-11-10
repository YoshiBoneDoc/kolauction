# Remaining inbox cleanup (253)

Local implementation only. Apply queued 253 once after verified 252; matching
ignored bot SQL is an alternative copy for the same database. Leave installed
252 unchanged. Then rebuild/release the separate bot with one connected worker.
No website release. Personal quickstart is unchanged. No production SQL, KoL
session, deletion or send was performed during development.

## Added cases

- Terminal rejected REGISTER/CREDENTIALS requests no longer require an account_jobs
  row. Immediate rejections never create one. Pending jobs still block deletion,
  and replies/refunds must be confirmed sent. Successful account replies retain
  their existing cleanup path.
- Raffle refunds and completed advances can qualify after their outgoing obligations
  finish. Ticket and prize-supply source messages wait for a settled raffle, zero
  held Meat/inventory, and all raffle-linked deliveries confirmed finished.
- Legacy donation-policy mail requires refund_queued plus recorded policy-refund
  deliveries repaying EXACT original Meat/items. Unknown moves/sends block it.
  Only asset-free cancelled donation-thank-you notices and cancelled donation
  closet plans are exceptions to the normal sent/moved requirement. Arbitrary
  cancelled transfers are never treated as confirmed sends.
- Verified opened gift mail, including fully confirmed operator returns, uses a
  separate private approval RPC with freshly observed envelopes. The observed
  raw envelope must exactly equal the verified payload's gift_original, and the
  financial receipt must exactly equal that verified payload. Missing proof,
  unposted intake, legacy/unverified donations, active opening, related/unidentified
  isolation, unresolved reviews and unfinished obligations prevent deletion.

All new cases require positive outgoing evidence, terminal receipt state, no
pending account/staged/isolated raffle intake, no unresolved preparation reviews,
and complete linked transfers/closet work. Existing recursive Buy-batch proof is
reused. Financial receipts, gift evidence, raffle commitments/tickets, account jobs,
policy history and Sent Mail are NEVER deleted by these functions.

## Gift worker behavior and compatibility

The transport records actual gift envelopes from each complete inbox read before
adding synthetic recovered mail. Thus an absent source is not mistaken for observed
KoL mail. Even banked/skipped mail can be offered for approval without reopening it.
The worker rotates batches of at most 24 actual envelopes; all approved deletions
share the existing normal/priority cleanup budget, pacing, fairness and retry rules.
Approval failures preserve gifts and do not prevent ordinary approved cleanup.
Empty approvals wait 15 seconds before another eligibility read; failures wait 30.
No extra gift-cleanup RPC is issued without observed gifts.

The completedGiftCleanupVersion capability enables this path only after SQL support.
Older databases keep current retention; older bots cannot delete gifts through the
ordinary approval RPC after 253. This deliberately requires the compatible worker's
fresh-envelope check. Restart the sole worker after its rebuild so capabilities
refresh immediately. Ordinary account/raffle/policy coverage is SQL-driven.

## Validation and limits

Targeted disposable PostgreSQL checks cover synchronous account rejection without
jobs, pending/unknown/sent raffle refund and batch transitions, unsettled/settled
raffles and leftover inventory, exact/partial legacy repayment, unknown closet
moves, matching/changed gift envelopes, missing verification, unresolved reviews,
opening/isolated attempts, legacy gift exclusion, role grants, audit query and durable
receipt preservation. Financial intake/claim/ack/liability/preparation/finalization
function definitions remain unchanged. Targeted Node 24 checks cover real versus
synthetic gift observations, bounded rotation/deletion, failed/wrong approval,
old-database compatibility and existing burst/cleanup recovery. Full suites were
not rerun. Local simulations do not establish live throughput or installed state.

Unreadable/unverified gifts, unfinished trades and ordinary correspondence remain
retained intentionally. Do not bulk-delete them by age. Use the existing read-only
inbox cleanup audit for ordinary receipts; private gift approval additionally needs
the live observed envelope, so ordinary eligibility is intentionally false for gifts.
