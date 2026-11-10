# Completed inbox cleanup (252)

Local change only; no production SQL, connected bot or mail deletion performed.
Apply queued 252 once after verified 251. The ignored standalone bot copy is an
alternative for the SAME database. No bot binary change, rebuild or restart is
required for this approval-RPC change. The owner moves applied SQL, not the agent.
Personal bot quickstart unchanged.

The original command allowlist excluded normal FUND/FILL. A later rule recognized
batch deliveries, but individual immediate FILLs could remain despite confirmed
items, payment and fee handling. Completed account_ready mail already qualifies;
completed account_rejected requests were missing. Rejection results are explanatory
text, not a single 'refunded' status, so cleanup now requires actual refund evidence.

252 extends the existing approval RPC, preserving its previous eligibility rules.
New candidates are normal non-gift FUND/FILL accepted receipts, completed rejected
REGISTER/CREDENTIALS jobs, and ordinary requests with recorded refunds. Unsupported
funded commands qualify only after their durable refund and linked work finish;
ordinary chatter/Valentines without a financial receipt remain manual-retention mail.

The added paths require recorded outgoing evidence and ALL linked obligations
confirmed sent. Original source rows routed into Buy batches use the existing
recursive batch-delivered predicate: cancellation alone never proves delivery.
Pending/sending/unknown transfers, unresolved preparation/policy reviews, pending
account jobs/staged intake, gift-original payloads, and unmoved linked closet work
prevent approval. No active-auction closure requirement is introduced. A completed
partial fill can qualify while its order remains active. Pending accumulated items
or seller payments still retain their source. Incoming envelopes, not database
receipts, financial records, or Sent recovery evidence, are deleted by the worker.

The worker still gets approval on each cleanup turn, uses bounded paced deletes,
and retries failed deletions fairly. Migration does not empty the inbox instantly.
This does not independently change retention policy for gifts or uncertain assets.

Use scripts/inbox-cleanup-audit.sql in SQL Editor before/after installation to
inspect the oldest 200 recorded receipts without knowing KoL IDs. It is read-only,
returns eligibility under the installed RPC plus outstanding-work counts, and omits
raw message/password content. Receipts need not still be in the KoL inbox; this is
a ledger eligibility audit, not a live mailbox inventory. Unrecorded retained
chatter is shown by the bot's existing issues/snapshot instead.

New disposable PostgreSQL tests load the real migration chain and cover immediate
FILL/FUND, active-order batched fulfillment (pending/unknown/sent), refunds, account
replies/jobs, missing proof, policy/preparation/gift holds, fee movement, private RPC
grants, durable receipt preservation and audit-query execution. Financial intake,
claim, acknowledgment, preparation, liabilities and finalization function definitions
are unchanged by 252. No existing full suite rerun or production capacity claim.
