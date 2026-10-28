# kHub KMail previews

This document describes the current message behavior with migrations through **071**
and the current worker. Examples use fictional records and placeholder passwords.

Apply [migration 060](supabase/migrations/202610210060_clear_bot_messages.sql)
after 059 for the revised wording. This migration changes templates only; it does
not send messages, modify assets, or retry deliveries. Deploy the website changes
for the corrected settlement panel. The SQL-only wording update needs no bot restart.
The account-failure notices introduced in 059 also require the updated worker.
Apply [migration 061](supabase/migrations/202610210061_escrow_trade_queries.sql)
after 060 and deploy the matching website to enable Escrow's auction-linked contact
flow. That query extension uses the existing notice queue and needs no worker restart.

Apply [migration 063](supabase/migrations/202610210063_ban_notice_delivery_templates.sql)
after 062 to allow the ban-review and administrator-decision notifications introduced
in 051 to be claimed. Previously these unformatted notices could stop the queue before
auction payouts. The formatter sends their original server-authored event text only
for zero-asset notices linked to the corresponding auction review audit. Unknown or
mismatched messages still stop for review. Existing frozen bodies and ledger states
are unchanged; the SQL fix requires no new worker code.

Each outgoing KMail has a `Reference: D-1042` identifying its exact delivery.
Auction numbers and KoL player IDs remain identifiers without thousands separators;
Meat amounts and item quantities use commas. KoL displays the actual attachments
separately. Item/player names are escaped for KoL display where embedded in templates.

Messages freeze before sending. Previously claimed/sent bodies, saved account
replies, references and uncertain-send evidence are never rewritten by 060.
Unclaimed ordinary deliveries pick up the new template on claim; account and support
notices save their bodies when queued, so only newly queued notices use revised text.

## Donation received — no attachments

```text
Thanks so much for pitching in, we really appreciate your support! It’s players like you who make projects like kHub possible.

Rest assured, 100% of your donation will go toward keeping kHub running. Except for the part we spend on booze. That’s a business expense.

Reference: D-1031

*If this donation was sent in error, please KMail teres minor (#3552305) with the reference ID above.
```

Sent once per gift package or normal `DONATE` mail with Meat/items attached,
including any unacknowledged packages still in the
inbox when this update starts. With 097, packages with an exact auction command in
the outside message become verified auction intake instead. Other packages are
opened, their contents are closeted, and one thank-you is queued. Repeated polls
and restarts do not queue another. Historical donation receipts stay donations. For a normal donation, send exactly
`DONATE` (case-insensitive) with Meat and/or items attached. With migration `015`,
blank or invalid funded normal mail is refunded and never treated as a donation. Its source KMail is
deleted only after the thank-you and any required closet moves are confirmed.
Unrecognized normal mail carrying assets receives the invalid-command refund below.
Its source message stays in the inbox for review; unsupported/unreadable mail is left untouched.

## Donation instructions — DONATE without attachments

```text
How to donate

Send a normal KMail to kHub with DONATE as the message and attach the Meat or items you would like to donate.

Gift packages are also accepted as donations. Thank you for supporting kHub!

Reference: D-1041
```

No attachments. The receipt prevents duplicate instruction replies for the same
message. Donors do not need a linked website account to support kHub.

## Account linked — no attachments

```text
Account linked

Your KoL account is now linked to kHub. You can start listing items and bidding.

Reference: D-1041
```

## Auction activated — to the seller, no attachments

```text
Your auction opened

Auction #1001
Mr. Accessory × 2

Your item deposit was accepted and bidding opened. Check the auction page for its current status.

Reference: D-1042
```

## Bidding instructions — a typed amount or missing Meat

A normal message such as `BID 1048 51000` receives one durable reply explaining
that it did not place a bid. Send only `BID 1048` in the message and attach the
full 51,000 Meat through KMail's Meat field. Check the auction is still active
and its minimum first. A self-raise also needs the full new amount; the previous
bid is returned. Direct auctions use the website instead.

A correctly formatted bid without Meat receives the same help. Attachments on an
incorrectly formatted attempt are returned, and the reply says so only when
attachments existed. No typed amount is accepted as money. Repeated scans and
restarts do not queue additional replies for the same KMail.

## Bid accepted — no attachments

```text
Bid accepted

Auction #1001
Mr. Accessory × 2

Your bid of 719 Meat was accepted and funded in escrow. Check the auction page for the current leading bid and status.

Reference: D-1043
```

The amount is the bid accepted for that message, even if someone bids higher
before the notice is sent. Instant purchases go directly to settlement rather
than also sending a regular bid-accepted notice.

## Previous bid returned — full previous bid attached

```text
You’ve been outbid!

Auction #1001
Mr. Accessory × 2

Your previous bid is attached and has been returned in full.

Reference: D-1044
```

When someone else outbids you, this message returns your previous bid. If you
raise your own bid, the heading is **Previous bid returned** instead of saying
someone outbid you. Either way, the new bid must contain its full amount.

For split refunds, each message says, for example:

```text
Your previous bid is being returned across multiple messages. This message contains 1,000,000,000 Meat.
```

This does not claim that other portions have already arrived.

## Extra Meat returned — excess above the instant price attached

```text
Extra Meat returned

Auction #1001
Mr. Accessory × 2

Your purchase was accepted at the buyout price. The extra Meat is being returned with this message or in separate messages.

Reference: D-1045
```

## Winning items — auctioned items attached

```text
You won!

Auction #1001
Mr. Accessory × 2

Your auction winnings are attached.
Thank you for using kHub.

Reference: D-1046
```

Used for a winning bid at expiry and for an accepted buyout. If the item quantity
requires multiple messages, the attachment paragraph instead identifies the actual
portion (the auction heading still shows the full listing quantity):

```text
Attached in this message: 1,000,000,000 × asbestos ore. Your winnings are split across multiple messages.
Thank you for using kHub.
```

## Seller payment — winning payment minus any fee attached

```text
Your auction has sold!

Auction #1001
Mr. Accessory × 2

Sale Price: 10,000 Meat
Commission (tiered): 500 Meat
Your Proceeds: 9,500 Meat

Your proceeds are attached. Enjoy!
Thanks for using kHub. We hope to see you again soon!

Reference: D-1047
```

Tiered listings show `Commission (tiered)` and the exact stored amount, not a flat
5% label. A 10m sale shows a 410,000 Meat fee and 9,590,000 Meat proceeds. Historical
flat-rate listings retain their original label/rate; old 0% listings show
`Commission (0%): 0 Meat`. For split payments, the summary
shows the total sale/proceeds plus the amount attached in this particular message;
the closing says that this portion is attached.

## Cancelled auction — deposited items returned

```text
Auction cancelled

Auction #1001
Mr. Accessory × 2

Your deposited items are attached.

Reference: D-1048
```

Cancellation before depositing creates no item-return message. For split item
returns, each message identifies its attached quantity, followed by:
`Your item return is split across multiple messages.` No sale or payment is implied.

## No bids — deposited items returned

```text
Auction ended without bids

Auction #1001
Mr. Accessory × 2

Your deposited items are attached.

Reference: D-1049
```

## Rejected request — original attachments returned, if any

For a recognized bid command sent after bidding closes:

```text
Request not accepted

This auction is no longer accepting bids.

Your attached Meat or items are being returned with this message or in separate messages.

Reference: D-1050
```

The return paragraph is omitted when no Meat/items were attached. The explanation
changes to match the problem:

| Problem | Explanation |
|---|---|
| Invalid/expired verification code | Your verification code has expired or is incorrect. Open your account page using your username in the navigation bar to request a new code. |
| Assets attached to verification | Please send your verification code without Meat or items. |
| KoL account already linked elsewhere / bot account | This KoL account cannot be linked to this website account. Please contact support if you need help. |
| Website account already linked | Your website account is already linked to a KoL account. |
| Missing/legacy auction | We could not find that auction. Please copy the command from its listing page. |
| Unlinked sender | Register a kHub account from this KoL character before sending item deposits or bids. See the registration page for instructions. |
| Wrong deposit sender | Please send the item deposit from the seller's linked KoL account. |
| Deposit not expected | This auction is not accepting an item deposit. |
| Fixed listing deadline passed | The deadline for this auction has passed. |
| Wrong deposit contents | Please attach exactly the listed items and quantity, without Meat or extra items. |
| Bidding closed | This auction is no longer accepting bids. |
| Seller bidding on own listing | You cannot bid on your own auction. |
| Items attached to bid | Please send bids with Meat only, without items. |
| No buyout price | This auction has no buyout price. You can place a regular bid instead. |
| Bid outside accepted limits | Send your full bid of at least [current required amount] Meat. Bid increases depend on the current highest bid. |
| Insufficient buyout payment | Please attach the full buyout price shown on the auction page. |
| Restricted seller | This seller is restricted. The auction is not accepting new bids or item deposits. |
| Maximum safe bid reached | The maximum supported bid has been reached. |
| Unexpected internal rejection reason | We could not process your request. Please check the listing or contact support. |

## Short references and traceability

- Auction numbers (`Auction #1001`) identify listings; delivery references
  (`D-1042`) identify individual outgoing messages. Neither replaces the UUID
  stored in the ledger. Website commands now use the auction number: `BID 1001`,
  `BUY 1001`, or `LIST 1001`. Existing UUID commands still work. A `D-` reference
  is not an auction number and cannot be used in a bid or deposit command.
- Both numbers come from unique database sequences, rather than truncated UUIDs.
- Lookup requires the bot's private credentials, not public website access:

  ```bash
  # From bot/ on your Mac; does not log into KoL or send mail:
  npm run lookup -- D-1042
  # Or on Oracle, from ~/khub-bot:
  sudo docker compose run --rm --no-deps bot node src/cli.mjs lookup D-1042
  ```

- Lookup shows the full delivery UUID, recipient, assets, state, original ledger
  message, frozen display message, and expected sent-copy marker.
- Operator logs keep both the short reference and full delivery UUID, including
  send attempts, acknowledgments, blocked deliveries, and failures. The send log
  also records the auction UUID and recipient/assets. Players see only the clean body.
- `resolve` accepts either a `D-` reference or a full delivery UUID. Stop all bot
  processes and verify the actual sent-copy marker/attachments before resolving.
  A short reference does not change the evidence required or retry rules.
- Old messages keep their original `[kHub delivery <UUID>]` markers. Old sent or
  uncertain records are not reformatted or automatically resent.
- Each split transfer has its own delivery reference. Large amounts can still
  arrive across several messages. A confirmed not-sent retry preserves the same
  frozen body and reference once the new format was claimed.

## Gift fallback for restricted recipients

Before sending assets, the worker reads the recipient profile without caching.
A matching player header marked Hardcore or In Ronin selects a gift immediately.
Otherwise regular KMail is used, with a gift fallback only on an explicit KoL
rejection that the recipient cannot receive Meat or items through regular KMail.
The outer and inner notes contain the same frozen delivery text, footer, and
D-reference as the regular message, with line breaks replaced by ` | ` separators
for gift-shop compatibility. This avoids the stray `nn` seen in multiline gift
notes. Regular KMail keeps its paragraph breaks; stored messages are unchanged. The package contains the full original Meat
and items; the 50-Meat wrapper is paid from kHub's spare operating funds after a
fresh check of all player obligations, pending closet plans, reserve, and unread-mail holds. No extra
player notice or fee is added, and ordinary text-only notices remain regular KMail.

An acknowledged gift records its transport, wrapping cost, and response hashes as
evidence. A timeout/unknown regular response never triggers fallback. A failed or
unconfirmed gift is isolated with gift-specific evidence; no automatic resend.
Regular Sent Mail may not contain gift copies, so recipient gift-package evidence
may be required to resolve one. Existing isolated deliveries stay isolated until
an operator establishes their outcome. This worker update does not rewrite any
saved message or automatically release D-1096 (or any other old delivery).

## Cases with no outgoing message

Unrelated normal mail without assets and unsupported/system/self/malformed messages
stay in the inbox without a reply and do not stop other valid mail. Read-only mode never sends mail.

## Delivery awaiting manual resolution

Legacy behavior before 066, requiring migration `012` and its matching worker. No attachments. The support notice
is a separate delivery, with its own reference; the reference in the body identifies
the original uncertain delivery. A sent copy is kept in KoL. If this notice itself is
uncertain, it is not automatically retried and does not generate recursive notices.

```text
Your delivery needs a manual check

We could not confirm the outcome of delivery D-1031. It may already have arrived. We have paused automatic transfers while we check it.

Please do not resend your payment or items. We are waiting for manual resolution. If you need help, KMail teres minor (#3552305) with the delivery reference above.

Reference: D-1032
```

A KoL/network/database outage can prevent this notice from reaching the player.
The operator must still use `inspect` and sent-copy evidence to resolve the original
transfer. Unknown source mail never gets an automatic support reply.

## Applying the message update

Run the website's queued `202610210060_clear_bot_messages.sql` after 059, then move
it into the applied migration directory following the normal workflow. Its matching
standalone-bot copy is linked above. Apply it once; do not rerun earlier migrations.
No worker changes are required specifically for 060. If the current 059 worker has
not been deployed to Oracle, deploy it to enable account-failure isolation/notices.

Templates live in PostgreSQL; the transport appends the delivery marker and any
saved footer. Normal retries/reconciliation keep their saved bodies and references.
An uncertain transfer still requires actual sent-copy/attachment evidence before
resolution; a wording change never permits automatic resending.

## Closet moves and sale fees

Migration `069` replaces the standard flat fee with marginal tiers: 5% of the
first 1m, 4% of the next 9m, 3% of the next 90m, 2% of the next 900m, then 1% above
1b. The total is rounded down once. A 10,000 Meat sale has a 500 Meat fee and a
9,500 Meat seller payment. The database records `fee_meat` and queues exactly the
final price minus that amount; the worker does not calculate another commission.
Open standard-rate listings adopt the lower fees; existing sub-5% flat discounts,
finalized fees, frozen messages and already-queued payments are preserved.
Canceled/unsold listings and Direct trades have no fee. Excess buyout attachments
are refunded rather than included in the sale price or commission.

Donations and earned fees are moved to the closet as internal C-referenced operations.
This does not create extra player KMail. Since 097, donated package contents are moved after verified opening. The
existing thank-you and D-reference remain the donor's message; C-references and
inventory/closet evidence appear only in operator logs/inspect/lookup-closet.

## Invalid or blank normal command — original attachments returned (015)

```text
Request not accepted

Invalid command. Please copy the correct KMail command from the website and try again. For donations, send DONATE or a gift package.

Your attached Meat or items are being returned with this message or in separate messages.

Reference: D-1051
```

Sent only when normal mail has assets to return. Empty chatter gets no reply.
Since 097, packages with exact outside auction commands are verified as auction deposits; other packages remain donations. A refund for an old
misclassified donation explains that the earlier message was incorrectly treated as
a donation. These corrections do not change claimed old messages or resolve unknown
sends/closet moves automatically.

## Registration and credential recovery (019)

Send normal KMail with no attachments: `REGISTER` or
`CREDENTIALS` (`FORGOT LOGIN` also works). The reply goes only to the actual KoL
sender. Creation also verifies/links that sender. No email confirmation is needed.

Example registration reply (placeholder password, not a real credential):

```text
Welcome to kHub!

Your account is created and your KoL player is already verified.

kHub Username: KH_Your KoL Name
Temporary password: [generated unique password]

Log in on the kHub website. Change this temporary password after logging in: click your username in the navigation bar, then select Change password. Never use your KoL password on kHub.

Keep this message private. CREDENTIALS always generates a new password; it cannot retrieve an old password.

Reference: D-1052
```

Recovery uses the heading "Your kHub login has been reset." and explains that the
previous password no longer works. The `KH_` prefix is required for username login; public profile names do not
include that prefix. Linked legacy email accounts also receive a separate
`Legacy email login:` line; the old account code remains available. Rejected requests explain taken/restricted names, already
linked players, missing legacy links, requests in progress, the five-minute cooldown
or attached assets. Attachments are returned; registration is not performed.
Funded account rejections append `Your attached Meat or items are being returned
with this message or in separate messages.` Empty rejections do not claim to return
assets. Restrictions detected while a saved job is pending mark it rejected and
queue its account-restriction reply instead of provisioning credentials.

The generated password stays the same when an unfinished request resumes. Unknown
KMail sends retain the original private body until reconciled; successful replies
are never automatically resent. Generated secrets are scrubbed from the database
after successful delivery, while KoL's saved message still contains the password.


## Account request could not finish — once-only notices (059)

An account-service failure or the 20-second account-operation timeout leaves the
saved request pending for automatic retry. It does not instruct the player to
resend REGISTER/CREDENTIALS and does not block unrelated safe auction work.
The default worker queues one player KMail, one administrator KMail and one private
**Other** inbox system report per saved request, even across restarts/repeated failures.
An operator can configure admin-only notices with `notifyPlayerOnAccountFailure: false`.

Player registration example:

```text
Beep-boop! I'm sorry, something went wrong while registering your kHub account.

Your request is saved, and I will keep trying automatically. There is no need to send another request. I have notified the administrator.

Reference: D-1053
```

Recovery instead starts: `Beep-boop! I'm sorry, something went wrong while recovering your kHub login.`
Both notices are asset-free. Administrator example (to teres Minor, #3552305):

```text
Account service alert B-1003
registration for Your KoL Name (#1234567)
Original KMail: 123456789
The request remains pending and will retry automatically.

Administrator inbox: /admin/inbox?category=other

Reference: D-1054
```

For recovery, `registration` becomes `login recovery`. The private inbox report also
contains the saved-request timestamp and retry context. It never includes a password,
internal login email or raw Auth error. Completed/rejected/restricted jobs do not get
new failure alerts. An error before any request was saved cannot create this alert;
the source mail remains for retry. Queuing a notice does not guarantee immediate
arrival during an outage. Each notice follows the usual delivery/reconciliation rules.

## Direct trade responses — confirmation is separate from feedback

A seller or winning buyer's first completion confirmation or counted incomplete
report queues an asset-free notice to the other verified participant. Names, auction
number, quantity and agreed total come from the saved trade; user text is escaped.

Example confirmation:

```text
Auction #1001
2 x asbestos ore
Agreed total: 10,000 Meat

Other Player marked the trade Confirmed Complete: they received your side of the exchange.

This records trade completion only and does not change your feedback score.
A direct trade counts as complete only after both parties confirm completion.

This notice records their response when submitted. View the auction page on kHub for the current trade status.

Reference: D-1055
```

For an incomplete report, the response and follow-up paragraphs are:

```text
Other Player marked the trade Reported Incomplete: they reported that you failed to honor the trade.

This records trade completion only and does not change your feedback score.
Please contact the other party to resolve the issue. They can use Mark Trade Complete on the auction page after the exchange is completed.
Use Contact an Administrator on the auction page if you need to clarify something.
```

The same current-status closing appears afterward. These are historical response
notifications, not a promise that the trade is still in that state when the KMail
arrives. They do not award thumbs-up/down feedback. Incomplete profile marks wait
until 48 hours after auction close and exclude withdrawn or administrator-dismissed
reports; that delay does not delay the initial response notice.

Withdrawing an incomplete report and marking the trade complete adds a timestamped
system event to the administrator conversation, including silent reports. It also
queues a separate, asset-free withdrawal notice to the other verified participant:

```text
Auction #1001

Other Player withdrew their incomplete report and confirmed that the issue was resolved and the trade was successfully completed.
Their incomplete report has been withdrawn. Your feedback score is unchanged.

Reference: D-1056
```

The report's saved withdrawal timestamp prevents duplicate withdrawals/notices.
Optional thumbs-up/down feedback is stored separately and has no KMail template.

## Reports and support tickets — administrator KMail

The administrator receives notices at teres Minor (#3552305). Each uses a B-reference,
numbered parts, reporter name/player ID and escaped message text. Long explanations
are split without cutting encoded characters; each part also has its own D-reference.

| Submission | Header | Administrator inbox |
|---|---|---|
| Bug | `Bug report B-1003 (1/1)` | `/admin/bug-reports` |
| General support | `Support ticket B-1003 (1/1)` | `/admin/inbox?category=other` |
| Ban appeal | `Ban appeal B-1003 (1/1)` | `/admin/inbox?category=appeal` |
| Incomplete trade explanation | `Trade report B-1003 (1/1)` | `/admin/inbox?category=trade` |
| Trade query | `Trade query B-1003 (1/1)` | `/admin/inbox?category=trade` |

Trade reports also identify the auction and agreed total. With migration 061,
trade queries identify the auction, trading method, item/quantity and final price
when one exists. Escrow sellers can submit queries about deposits, active auctions,
settlement or returns; buyers must be finalized winners. Queries from either party
remain grouped under the auction in the same private Trade inbox. The existing
Direct Trade eligibility checks remain in place. A silent incomplete selection creates an inbox record **without an
administrator KMail**, while still using the participant-response notice above.
Appeal image evidence stays private in the website inbox and is not attached to the
bot's KMail. Resolving an inbox ticket alone does not mark a trade complete.

## Website settlement messages

The individual auction's escrow panel distinguishes actual outcomes:

- Sold, deliveries pending: items go to the winner and payment to the seller;
  settlement waits for **all required deliveries**, including split transfers.
- Unsold/canceled, returns pending: deposited items return to the seller; no buyer
  or seller payment is implied.
- Finished: the existing completed, no-bid and canceled messages remain distinct.
- Canceled before a deposit: no items need returning and no return KMail is generated.

These panel changes do not alter the KMail queue or backend settlement logic.

## Delivery preparation failure (migration 065)

Before any send attempt, a message-formatting failure sets the delivery aside and
allows other ready deliveries to continue. Items and Meat remain owed and reserved.
One system ticket is created in the administrator's **Other** inbox and one frozen
zero-asset KMail is queued to teres Minor (#3552305), for example:

```text
Delivery D-1080 set aside for review (B-1008).
Unrecognized delivery template; inspect delivery before sending.
No send was attempted. Other ready deliveries continue.
Administrator inbox: /admin/inbox?category=other

Reference: D-1082
```

The first reference identifies the held delivery; the footer identifies this alert.
Message bodies, account credentials and arbitrary error text are not copied into
alerts. Repeated cycles do not create more alerts for the same active hold. An
explicit retry after fixing preparation records the correction and re-enables the
original delivery. Closing a ticket does not count as delivery or release a hold.
Uncertain send outcomes retain their existing reconciliation behavior.

## Unconfirmed send after automatic Sent Mail check (066)

The updated worker checks Sent Mail before asking for manual help. A verified
message records its real KoL message ID and sends no new notification. Unverified
cases remain unknown and get one **Other** system ticket and a frozen, zero-asset
administrator KMail, for example:

```text
Manual delivery check B-1009
Delivery D-1080 needs a manual Sent Mail check.
Delivery UUID: <delivery UUID>
Recipient: #1582168
Original received KMail ID: 7654300
Candidate sent KMail IDs: ["7654321"]
Mailbox check: ambiguous

It may already have been sent. This delivery is set aside and will NOT be resent automatically. Other funded deliveries continue. Its auction remains unsettled until resolved. Closet transfers are paused to preserve disputed assets.
Use the delivery reference or UUID to record sent/not-sent after checking KoL. A missing sent copy alone is not proof it failed.
Administrator inbox: /admin/inbox?category=other

Reference: D-1083
```

If no candidate sent ID exists, the message explicitly says no confirmed matching
sent-message ID is available; unrelated settlement deliveries may also have no
original received KMail. No private message body or credential appears in the alert.
Repeated mailbox checks do not create more KMail. A failed alert creates no recursive
alert mail. Later verified success or manual reconciliation closes the system ticket.

## Hybrid bid minimums (071)

Low funded bids still receive the existing rejection/refund message, now naming
the hybrid minimum: fixed increases below 1M, then 3%/2%/1%/0.5% with upward
rounding of the increase. For a current bid of 1,750,000 Meat, the reply asks for
at least **1,810,000 Meat**. First bids use the seller's starting price and buyouts
remain exempt. Previously frozen delivery messages are not rewritten.

### Unfunded escrow expiry (074)

An unfunded listing expires 24 hours after creation, based on when the bot
processes the deposit. Expired drafts are removed by normal ticks, website
finalization or the next ingestion call. No expiry KMail is generated, because
the bot has accepted no assets. If a late LIST command includes attachments, the
existing rejected-request message and return deliveries send them back exactly
once. A removed auction uses the existing unknown-auction explanation; a draft
retained for linked support/audit history uses the deposit-not-expected explanation.

## Buy HC/Ronin delivery — kHub-paid packaging (096)

A consolidated gift says that **all accumulated purchased items are attached** and
that **gift packaging is covered by kHub**. The item quantity is the full pending
quantity at preparation, not a multiple of the threshold. Its D-reference is the
new batch's durable delivery reference. Normal KMail and finished-mode order
messages keep their existing timing. Final unused-funds refunds no longer say
that delivery expenses were deducted. No new packaging top-up message is queued.

## Incoming auction packages (097)

Copy the exact LIST/BID/BUY/FUND/reserved FILL command into the outside message.
Attach the same exact items or full Meat amount as ordinary KMail. The original
KMail ID, sender and received timestamp remain authoritative after opening.
Accepted packages use existing auction acknowledgments; rejected contents use
existing recorded refunds, with gift delivery if the sender is in HC/Ronin.
Packaging is paid by kHub. Packages without the outside command are donations
and use the same one-time thank-you after their contents enter the closet queue.

## Isolated incoming gift failures (098)

A failed or unverified package is retained privately for review. Other requests
continue; the bot never sends an assumed refund, thank-you or accepted deposit
for unidentified contents. Reserved unknown assets cannot fund payouts, wrapping
or closet moves. Existing successful auction responses remain unchanged.

## Direct Trade reminders (100)

New Direct Sell conclusions send each verified party a role-specific notice.
Both parties get the counterpart’s KoL name/ID and kHub username, auction number,
item quantity, agreed whole-listing price, exact UTC deadline and instructions to
arrange the in-game exchange and confirm receipt on the auction page. The seller
is told to send items for Meat; the buyer is told to send Meat for items. Neither
is instructed to send assets to kHub.

The first heading is `Your Direct Trade auction has ended`; the second is
`Direct Trade: 24-hour reminder`. The second is scheduled 24 hours after close
and is omitted if the trade is already complete. If only one party has confirmed,
both receive the reminder, with the confirmed party told that the other player’s
confirmation is outstanding. Delayed messages state their exact original deadline
instead of granting a fresh 24 or 48 hours. Names/item text are escaped, numeric
amounts are comma-formatted, and the existing delivery reference is added normally.

Old concluded history is not mass-notified. Pending stale notices are canceled;
sending/unknown messages remain immutable for the existing Sent Mail recovery.
