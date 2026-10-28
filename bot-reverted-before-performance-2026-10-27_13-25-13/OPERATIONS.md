# Downtime, unexpected mail, and recovery

## What is implemented

Apply `supabase/migrations/202610190012_bot_mail_review.sql` after `011`, with all
bots stopped, then restart the updated local worker (or deploy it to Oracle).
This changes the worker; a website Git push does not deploy it.

- Normal VERIFY, LIST, BID, BUY, and DONATE commands are processed. Existing
  bare auction numbers/UUIDs still mean BID. Unrecognized normal text and blank normal mail with assets produce a recorded
  invalid-command refund. Blank/unknown normal mail without assets, system/self mail,
  Valentine mail, unsupported types, and individually malformed messages stay in
  the inbox without a reply or deletion. Unreadable attachments need manual review.
- An invalid individual message does not prevent valid messages from being processed.
  Its ID is logged once per running process (with a bounded cache); its body is not logged.
  A broken whole-inbox API response, database failure, or changed receipt payload still
  stops processing: those failures cannot safely be treated as unrelated mail.
- Accepted normal source mail is deleted only after its receipt is committed and
  every delivery directly associated with that receipt is acknowledged as sent.
  This covers immediate replies/refunds, not the later settlement of an active auction.
  Rejected requests remain in the inbox even after their refund is acknowledged.
  Retained mail with a committed receipt cannot execute the request twice.
- With 097, packages use the exact auction command in the outside note. The bot identifies opened contents by the updated original KMail. Other packages are donations whose contents are closeted. Uncertain opening attempts are isolated for review; unrelated intake continues and unidentified assets are reserved.
  With migration `015`, normal mail requires the explicit DONATE command to count
  as a donation. Blank funded normal mail is refunded; blank unfunded mail is ignored.
- With migration 066 and the matching worker, an uncertain delivery triggers an
  automatic read of **Sent**. One exact frozen-message/recipient/reference match
  confirms it without sending again. Otherwise it is isolated, preserving its
  unknown state and unsettled auction while other funded deliveries continue.
- With migration 068 and the updated worker, a fresh matching recipient profile
  showing Hardcore/Ronin selects a gift immediately, before any regular asset send.
  Otherwise, an explicit game rejection that
  the recipient cannot receive regular KMail attachments triggers one gift-shop send
  with the exact same assets and reference. kHub pays the 50-Meat wrapper only from
  surplus inventory above full player liabilities, pending closet plans, unread-mail
  holds, and the operating reserve. Timeouts/generic errors never trigger fallback.
  Unconfirmed gifts stay isolated; gift-specific evidence distinguishes a gift
  attempt from a package never attempted due to failed funds/rollover checks.
  Recipient package evidence may be needed because gifts may lack regular sent copies.
- One **Other** inbox ticket and administrator KMail list the original D-reference,
  delivery UUID, original received KMail ID when available, and candidate sent IDs.
  No match never means permission to resend. Repeated checks do not duplicate alerts.
  A failed administrator alert cannot recursively produce more alert mail.
- All owed funds remain in full ledger totals. Dispatch solvency excludes isolated
  possibly-sent obligations only; closet income is paused while uncertainty remains.
  Use existing evidence-based `resolve` commands for cases the mailbox cannot prove.
  Before 066, uncertain deliveries still stop normal processing for manual review.
- Incoming problem mail stays in **Inbox**; outgoing replies are in **Sent**.
  `npm run inspect` remains the authoritative list of uncertain deliveries. A delivery
  from an older worker may no longer have its original source mail in the inbox.
- A blocked worker stays running and polls without repeatedly logging into KoL.
  `npm start` and the updated Docker image run a health monitor that restarts a
  crashed or stalled worker on both the Mac and Oracle. Docker's existing
  `unless-stopped` policy also restarts the monitor if the container exits.
  These are not a guarantee against a VM, Docker, network, or provider outage.

The worker reads KMail only; it does not start the library’s chat bot or interpret
chat messages as auction commands. Unfamiliar KMail formatting stays for review.

## Automatic recovery and health

Registration/recovery failures no longer abort an otherwise safe auction cycle.
The worker logs the numeric KMail reference, retains the request for retry and
does not delete its source message on a failed attempt. Pending-queue read failures
are deferred too. Account-service calls time out after 20 seconds; no raw Auth
error, password or request body is included in the deferred-request log.
Inspect persistent `accountAttention` entries for account conflicts or Auth
outages. Do not delete jobs or fabricate credential replies to clear them.
Unknown account-mail asset intake, shortages for known-unsent obligations and uncertain closet transfers still
stop processing; this change does not bypass financial reconciliation.

With migration 059, the first failure of a saved pending account request queues one
player notice and one administrator alert (Other inbox plus KMail to #3552305).
The player is told to wait for automatic retry rather than send another request.
The inbox sender is kHub bot; no fake player account is created for a registration
that has not yet provisioned. Repeated failures do not reopen a resolved alert or
send duplicate notices. Check the referenced original KMail/account job to see its
current state. A notification-queue failure remains retryable and does not stop
other deliveries. If the database is unavailable or a request has not been saved
yet, there may be no immediate notification; the source KMail remains for retry.

The default entry point is now `src/supervisor.mjs`, used by `npm start` and the
Docker image. It launches one worker, watches IPC heartbeats and actual request/
cycle progress, and waits for the worker's exit before starting another. There
is no daily cron job and no hardcoded assumption about when maintenance ends.

- Heartbeats arrive every 15 seconds. No heartbeat for 90 seconds, or no actual
  progress for five minutes, requests a restart. A healthy idle cycle counts as
  progress. A long batch remains healthy while its individual operations progress.
- Maintenance polling counts as progress, so long real maintenance is allowed.
  If completed cycles still report an elapsed rollover without detected maintenance
  for over ten minutes, a restart is requested. This recovery is limited to once
  per ten minutes if KoL keeps returning the stale time.
- The worker stops between operations. An in-flight send/move finishes its
  acknowledgment before shutdown proceeds. If it cannot exit within 60 seconds,
  it is terminated; durable claims preserve uncertain outcomes for reconciliation.
  The next worker checks that ledger before attempting another ordinary transfer.
- Crashes retry after 5 seconds, backing off to 60 seconds for repeated failures.
  Invalid startup configuration or a rejected duplicate stops retries. Ctrl+C
  stops the monitor too. A worker whose monitor dies requests its own shutdown.
- New workers reserve loopback port 38887 before connecting to KoL. This prevents
  a second updated worker on the same host/network namespace. It does not detect
  the old code, another computer, or a separate container: stop Oracle before
  Mac testing and keep one deployed container.

`npm run health` reads `data/health.json` locally. The file contains timestamps,
PIDs, state and restart count, never mail bodies, passwords or service credentials.
It is replaced atomically with private permissions. The Compose named volume
preserves it through container recreation. It is monitoring data, not the ledger.

States include `healthy`, `read-only`, `working`, `rollover`, `maintenance`,
`blocked`, `error`, `restarting`, `stopping` and `stopped`. Status older than 90
seconds, or a missing monitor process, is `stale`; a missing file is `unavailable`.
An explicitly recorded `stopped` state remains stopped after the monitor exits.
`blocked` is attention-worthy and does not cause repeated restarts. The Docker
healthcheck reports blocked/error/stale status as unhealthy; the supervisor,
not the Docker healthcheck, performs worker recovery.

No SQL migration or credential change is needed. Stop the existing local bot,
wait for its prompt, then run `npm start` once to activate this update. On Oracle,
upload the new bundle and rebuild the container. No update has been deployed by
editing these files. External outage alerts and website outage controls still
need a separately configured monitor; a sleeping Mac or unavailable host cannot
run this health monitor or send its logs.

## If the bot has been offline

1. Make sure there is only one running copy, including read-only copies. Keep bots
   stopped while logging into the game manually to inspect mail or resolve a send.
2. Run `npm run inspect` locally, or the Docker inspect command in README, to check
   for uncertain deliveries. With 066, start one worker to attempt automatic Sent Mail
   checks; manually reconcile only the remaining isolated records using actual evidence.
3. If an asset check failed, compare the ledger obligations to the actual inventory
   and Meat before moving anything or restarting. Never mark a transfer sent merely
   to clear an error. Do not spend escrow funds manually.
4. Restart one bot. Accepted receipts and pending obligations survive in Supabase.
   A replaced VM can connect to the same database; the VM's local cache is not the ledger.
5. Check controlled sends and the backlog after recovery.

**Current deadline policy:** Auction clocks keep running while the bot is offline.
Bids are validated against database time when processed, not their KMail timestamp.
A bid arriving before the deadline but processed afterwards is rejected/refunded;
existing accepted bids remain in escrow and expired auctions settle on recovery.
Receipt replay prevents already accepted messages from executing again. Auctions
are not automatically extended. This policy needs clear user-facing disclosure,
or a separate planned outage/pause feature, before public launch.

**Still required:** Configure an external health alert that can detect an unavailable
host and consume the local health state. Local health timestamps and recovery are
implemented above; no off-host alert destination is configured. Decide whether stale heartbeat should disable
new listings/bidding instructions and show an outage banner, and define any manual
auction extension/cancellation policy before implementing it. Never promise a fixed
recovery time from a free host.

Oracle may reclaim idle Always Free instances:
[Oracle resource policy](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
Keeping the bot running is not a guarantee against reclamation.

## Why asset checks remain necessary

Normal operation should always have enough to cover accepted escrow obligations.
The check catches accidental manual withdrawals, a second process spending funds,
restricted/unavailable inventory, inconsistent API responses, and accounting bugs.
The extra Meat buffer is optional and defaults to **0**. With zero extra buffer,
the worker still requires every Meat/item owed to users to be present. There is no
extra 1,000 Meat funding requirement. A nonzero `BOT_MEAT_RESERVE` can optionally
keep additional owner funds available, but that is separate from auction accounting. Retained unrelated
mail and donations are not permission to spend users' escrow. A deficit pauses
transfers and retains incoming requests for investigation; it is not fixed by
turning the check off or changing a delivery's state.

## Backups without a pile of laptop files

A local bot folder protects against losing the Oracle VM, but not losing the laptop.
Use a separate private Git repository for code, or one encrypted off-device copy of
`exports/khub-bot.tar.gz` that is replaced after code updates. The existing bundle
command overwrites one archive and excludes credentials and SSH keys. Keep a private
credential/key backup separately, for example in a password manager with file storage.
Do not put database dumps, `.env`, or keys in the website repository.

For the database, the proposed policy is one daily backup with a rolling maximum
of **7 daily copies**, plus a backup before migrations. Encrypt backups before
uploading to private storage separate from the bot VM. Use a temporary server-side
working file, upload and verify it, then remove the working copy only after success.
Only rotate older remote copies after a new upload is confirmed. Record backup
failures and alert on them. This bounds storage and requires no recurring laptop files.
A daily backup still permits up to a day of data loss; keep that limitation explicit.
The destination, encryption key, scheduler and alerts are **not configured yet**.
Supabase recommends regular off-site exports for Free plan projects:
[database backups](https://supabase.com/docs/guides/platform/backups).

A restore test means actually loading a backup into a disposable, isolated,
Supabase-compatible database and checking tables, functions, permissions, row counts,
and representative ledger/receipt relationships. Use matching PostgreSQL tooling,
required extensions/roles, and stop on restore errors. The test database must have no
bot worker, production credentials, or real KoL session attached. Delete the temporary
database and its temporary files after recording the outcome; no permanent duplicate
is needed. `pg_restore --list` alone only checks the archive listing.
[Supabase logical restore guidance](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

A real backup restore test is **still pending**. The automated migration tests use
synthetic data; they do not prove that the user's saved dump can be restored.
After restoring an old backup for real, keep the bot stopped and reconcile mail sent
since that snapshot before allowing any sends. An old snapshot can forget payments
already made, so immediately starting a worker risks duplicate transfers.

## Donation and commission closet

Apply `supabase/migrations/202610190013_closet_income.sql` after `012` with every
worker stopped, then restart the updated local bot or deploy it to Oracle.
The donation trigger and fee trigger run in the same database transaction as the
receipt or completed sale. The migration does not move anything in KoL by itself.

- Migration `069` changes standard escrow fees to marginal tiers: 5% of the
  first 1m, 4% of the next 9m, 3% of the next 90m, 2% of the next 900m, then 1%
  above 1b. The total fee is rounded down once. A 10m sale pays 9.59m to the seller
  and earns 410k commission. PostgreSQL records the exact fee and queues the net
  seller payment; the worker does not independently recalculate it.
- Apply `069` with every worker stopped, then restart and deploy the website.
  Open standard-rate auctions adopt the lower schedule; existing free/sub-5% flat
  discounts, finalized fees, queued payouts and frozen message bodies stay intact.
  Canceled/unsold auctions and Direct trades incur no commission. Excess attached
  buyout Meat is refunded in full and excluded from the commission basis.
- The fee enters the closet queue only after the winner's items and seller's payment
  have been acknowledged and the sale is completed. Instant Purchase is also a sale.
- With migration `015`, only normal DONATE mail creates donation closet obligations.
  Blank or unrecognized normal mail carrying assets receives a full refund and an
  invalid-command explanation. Empty unknown mail without assets remains untouched.
- Since 097, auction packages are opened and verified by original KMail identity.
  Packages without an outside auction command are donations; the CONTENTS enter
  the closet queue. Unopened wrapper sweeps are disabled to protect mixed stacks. Known wrapper types are listed in
  [KoLmafia's package data](https://github.com/kolmafia/kolmafia/blob/main/src/main/resources/data/packages.txt).
- A wrapper can itself be an auction item or a normal DONATE attachment. The planner
  subtracts auction/refund holds, retained review-mail assets, and existing pending
  closet obligations before planning package moves. This avoids taking escrow or
  recording the same package donation twice. Package planning is capped by the
  inventory seen before fetching that inbox batch, minus acknowledged outgoing
  items, so later arrivals are not swept before their messages are processed.
  New wrapper types need an adapter update.
- Closet moves run after intake and queued deliveries. Every move has a C-reference
  and UUID, an exact amount, source receipt/auction, durable claim, recorded starting
  balances, and confirmed inventory/closet balance evidence. The worker uses one raw
  request with automatic write retries and redirects disabled, following the request
  fields in [KoLmafia's ClosetRequest](https://github.com/kolmafia/kolmafia/blob/main/src/main/java/net/sourceforge/kolmafia/request/ClosetRequest.java).
- Auction/refund obligations, assets attached to unrelated mail awaiting review, and
  any optional configured extra buffer remain in inventory. Unreadable attachment shapes
  defer closet moves until reviewed; they do not stop otherwise valid auctions.
  The default extra buffer is 0, so all newly tracked donations and earned fees can
  be closeted while exactly the required escrow/review assets remain in inventory.
  Only a deliberately configured nonzero buffer needs additional owner funding.
- Accepted donor source mail is deleted only after its replies and closet moves are
  confirmed. A timeout, unexpected balance change, crash during a move, or missing DB
  acknowledgment leaves the closet operation moving/unknown and blocks asset transfers
  until reviewed. A successful-looking HTML page alone is not sufficient evidence.
- Newly recorded donations and newly completed sales are tracked from migration `013`
  onward. Old donation receipts and historical fees are **not backfilled**: those funds
  may have already been spent or manually moved. Existing unencumbered known gift
  packages can be detected and closeted. Do not sweep arbitrary inventory surplus.
- Closet transfers never withdraw anything automatically. If you manually open a
  closeted package later, stop the bot and manage its contents explicitly; there is
  no automatic gift-opening workflow that records those newly released contents.

Read-only mode never plans or executes closet transfers. No live KoL action is
performed by the test suite.

### Resolving an uncertain closet transfer

With migration 106 and its worker, this no longer stops other auction work.
Further closet moves of the same asset pause, preserving its closet evidence;
other funded deliveries and unrelated closet assets continue. Inbox reports and
admin notices are once per transfer, and closing a report does not reconcile it.
Inventory can change through continuing payouts, so consider those changes rather
than requiring the original inventory amount to remain identical.

Stop every bot first. `npm run inspect` shows `closetCounts` and `closetAttention`.
The starting balances are recorded in the operation. Compare actual inventory and
closet balances, and any intervening manual actions, before deciding what happened.
A closet transfer is not a KMail delivery, so its evidence is the balance change,
not a Sent message. Never resolve not-moved just to unblock the queue.

From the local bot folder (replace the example C-reference with the actual one):

```bash
node --env-file=.env src/cli.mjs lookup-closet C-1001
# Only after confirming the move happened:
node --env-file=.env src/cli.mjs resolve-closet C-1001 moved "Verified exact closet increase against recorded starting balances"
# Alternatively, only with evidence the move never happened:
node --env-file=.env src/cli.mjs resolve-closet C-1001 not-moved "Verified request rejected and inventory/closet balances unchanged"
```

On Oracle, replace `node --env-file=.env` with
`sudo docker compose run --rm --no-deps bot node`. Resolutions are append-only audit
records. Not-moved requeues the same obligation; moved prevents another transfer.
Insufficient unencumbered assets leave an obligation pending without moving anything;
fix the missing assets/reserve rather than altering ledger rows.

## Rollover: wait and resume, without a scheduled reboot

The worker reads KoL's next-rollover Unix timestamp from status instead of scheduling
against a fixed Georgia clock time. This automatically follows the game's timestamp
through local daylight-saving changes. For the two minutes before that timestamp,
it stops claiming new KMail transfers, support notices, and closet moves; routine
mail cleanup waits as well. Reachable incoming auction commands can still be recorded.
Auction clocks continue and the existing deadline rules still apply.

Normal read requests use the client's rollover recovery: when KoL maintenance is
recognized, it waits and checks for the end of maintenance approximately once per
minute, reconnects if necessary, and resumes. Startup now waits through detected
rollover too. There is no assumed five-minute maximum or fixed restart time.
If API reads still work but keep reporting an elapsed rollover time, the worker
refreshes `main.php` through the read-only recovery path and reads status again.
These refreshes are limited to once per minute; transfers stay paused until a
fresh status reports a future rollover outside the two-minute buffer. Pause logs
include the reported rollover and current UTC times, or detected maintenance.
When the delivery pause clears, a single resume message is logged even if there
are no deliveries waiting. A quiet terminal after that is not a stopped worker.
[KoL's maintenance documentation](https://www.kingdomofloathing.com/doc.php?topic=maintenance)
explains that the game blocks logins during rollover and that duration varies.

The Oracle VM can remain on throughout. Docker's restart policy remains a fallback
for process exits; Oracle does not understand KoL rollover itself. A scheduled VM
reboot is unnecessary and can interrupt an in-flight transfer. If a write is caught
by unexpected maintenance/network failure despite the buffer, its normal durable
uncertain state still requires evidence and manual resolution. Recovery never
blindly repeats an asset transfer because rollover has ended.

These are worker/configuration changes, with **no additional SQL migration**. Restart
the local worker after updating. An existing Oracle installation needs the updated
archive/image and `BOT_MEAT_RESERVE=0` in its server `.env` to adopt these defaults;
a local edit or website Git push does not change the running Oracle container.

## Invalid normal mail and the closet request correction (015)

Stop all workers, apply `supabase/migrations/202610190015_invalid_mail_refunds.sql`
after `014`, then restart the updated local worker or deploy it to Oracle.

| Incoming mail | Handling |
|---|---|
| Valid LIST/BID/BUY/VERIFY command | Validate and process; rejected requests refund their assets |
| Normal DONATE | Donation; empty DONATE returns instructions |
| Gift package with exact outside auction command | Open once, identify original KMail, validate/refund through existing escrow |
| Gift package without an outside auction command | Open once, identify original KMail, closet donated contents |
| Normal blank/invalid text with Meat/items | Invalid-command explanation plus full refund; no donation/closet obligation |
| Blank/unrecognized normal text without assets | Leave in inbox without a reply |
| Unsupported or unreadable mail | Leave in inbox for manual review |

Refund source mail remains in Inbox for review, and each refund's sent copy is
saved in Sent. Receipts prevent repeating refunds on subsequent polls/restarts.

The item closet adapter uses **GET fillcloset.php?action=closetpush**, the direct
deposit endpoint documented in KoLmafia, with whichitem/qty/ajax query parameters.
The inventory.php route returned an empty response without moving the item in a
local live test; the direct endpoint still needs a controlled live confirmation.
The underlying page-access failure was missing login initialization: loading
main.php after API authentication changed all three page reads from HTTP 302 to
HTTP 200 in a live read-only diagnostic. The worker now performs this initialization
after login and detected relogin, before using the authenticated identity for work.
Meat uses POST to closet.php with addtakeclosetmeat/add/quantity.
Both are single raw writes without retries or following redirects. A failure records
safe diagnostics: request stage, endpoint/method/status when available, response
hash, an allowlisted redirect pathname without query parameters, and expected/actual
inventory/closet balances. Raw URLs, session tokens and response bodies are not logged.

### Reviewing existing attempts, including C-1001

If an existing attempt came from blank/invalid normal mail, it needs a correction
refund; explicit DONATE and gift packages still qualify for closeting. The migration
identifies old normal donations that did not contain DONATE. It
preserves their original receipts and freezes those assets for a refund. Pending
incorrect thank-yous and unattempted closet plans are cancelled with an audit reason.
Moving/unknown operations are **never** cancelled or silently resolved.

1. Keep all bots stopped and use `lookup-closet C-1001` to see its recorded before_state.
2. Compare actual inventory and closet balances. Only resolve moved/not-moved when
   the evidence establishes the outcome; a guess or this code fix is not evidence.
3. If the item moved, resolve the operation as moved and manually return that item
   from the closet to inventory with the bot stopped. If it did not move, resolve
   not-moved. A misclassified implicit donation plan will be cancelled instead of
   tried again; a valid explicit DONATE plan remains eligible for its original move.
4. Restart one updated bot. Once all uncertain operations are resolved and inventory
   covers all escrow plus these refunds, it queues and sends each correction refund
   once. It will not withdraw assets automatically or borrow another user's escrow.

`inspect` shows `mailPolicyAttention` while an old misclassified donation needs its
assets restored. The old input payload is not rewritten; only its policy-review
record and refund obligation are added. A retry of the same inbox message cannot
produce a second donation or refund. Earlier thank-you messages already sent cannot
be retracted. Read-only mode never queues or sends correction refunds.

### A gift package was opened before its wrapper was closeted

Opening a gift package consumes its wrapper. A previously queued wrapper move can
then fail the availability check while remaining pending (no attempt was made).
After migration `016`, stop all bots and use `cancel-opened-package C-1002` with
the owner's actual explanation, as shown in the README. This adds an audit entry,
cancels only a never-attempted generic wrapper plan, and moves no assets. Donation
receipts, sale commissions and uncertain transfers cannot be cancelled this way.
Opened contents remain in inventory until the owner moves those assets manually.

### Buy items are accumulating for a free HC/Ronin gift (096)

Small immediate purchases wait until the order's **total pending quantity** reaches
its price-based trigger: 1,000 below 50 Meat/item; 100 at 50–999; 10 at
1,000–49,999; otherwise immediate. The whole accumulated quantity is sent together,
subject only to the existing per-message transport ceiling. Cancellation, expiry
or full fill flushes any remainder. Finished-mode delivery timing is unchanged.
Ordinary KMail recipients do not wait for gift thresholds.

Packaging uses kHub's spare funds. Do not request a buyer top-up for wrapping or
reduce their order. If kHub lacks spare operating Meat, the delivery safely waits;
player balances and accepted seller commitments remain protected. Unknown sends
still require positive evidence or verified not-sent reconciliation. Never mark
one sent to release a batch or its source KMail. New batches cannot include a
sending/unknown delivery or bypass an active preparation hold.

Private `buy_item_batches.source_deliveries` snapshots and `buy_item_batch_members`
link the original references to replacement gifts. Canceled routing notices have
no assets; their obligations belong to those replacement messages. Source KMail
cleanup waits for the entire replacement chain to be sent and fee moves to finish.
`buy_order_events` records batching, known no-sends, bot-paid packaging and restored
open-order deductions. Finalized historical refunds and messages stay unchanged.

### Incoming package opening recovery (097)

See the incoming-gift section at the bottom of README.md. `inspect-gifts` reads the
private original envelopes, verified payloads and outstanding attempt. Never
manually open another same-wrapper package while an attempt is unresolved. Never
release a failed attempt based solely on a timeout or missing KMail. Preserve the
original KMail until receipt, refunds/deliveries and donation closet moves finish.
Old donation receipts remain donations; 097 never retrospectively turns them into
bids. Old closeted wrappers stay in the closet.

### A single uncertain package must not stop unrelated intake (098)

098 supersedes 097’s global intake/dispatch stop. The worker sets the failed
package/attempt aside, continues other gifts and ordinary mail, and reserves
unidentified surplus from payouts, wrapping and closet moves. A later original
KMail update can identify contents without guessing stack order. Repeated polls
do not allocate held contents twice. See README.md’s 098 section for private
inspection and evidence-based review resolution commands.

### A Sell auction's deadline moved (099)

An accepted ordinary bid in the final minute resets the countdown to 60 seconds.
Use `khub_bot.auction_bid_extensions` for the bid, original receive time and exact
old/new deadlines. Escrow links directly to its original receipt, including gift
intake. No extension is generated for rejected/duplicate bids, a buyout, or a Buy
order fill. Do not restore a previous deadline merely because it differs from the
original listing time: winner selection and settlement use the extended deadline.

### Direct Trade reminders (100)

`bot_inspect` includes `directTradeRemindersVersion: 1` after migration 100.
These are zero-asset `notice` deliveries, with dedupe keys
`direct-trade-reminder:<auction UUID>:<conclusion|24_hours>:<seller|buyer>`.
The private `khub_bot.direct_trade_reminders` schedule records original close,
48-hour deadline, recipient/counterpart profiles, delivery ID and suppression reason.
Use the ordinary delivery lookup and Sent Mail recovery for a notice’s D-reference;
never reset an unknown send to pending without the usual proof.

Only newly concluded Direct Sell trades enroll. No future reminder is sent after
a completed trade or its 48-hour deadline. Confirming only one side leaves the
trade incomplete, so both parties still get the scheduled 24-hour reminder.
The existing deployed worker needs no rebuild for this SQL-only feature.
