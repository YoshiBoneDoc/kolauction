# KoL Auction Hub roadmap

Outstanding tasks as of October 19, 2026.

## Still required

### 1. Deploy readable bot messages and short references

- Stop all bots, back up the database, and apply
  `supabase/migrations/202610190006_friendly_bot_messages.sql` once. Deploy the
  matching bot update before restarting; old workers cannot claim deliveries
  after this migration. See the local `bot/MESSAGES.md` previews and rollout guide.
- Verify the short references and friendly wording with controlled live mail.
  Operator logs retain both short references and UUIDs. Confirm legacy uncertain
  deliveries still use their original sent-copy evidence when reconciled.
- Apply `supabase/migrations/202610190007_short_auction_commands.sql` after `006`,
  deploy the matching bot, then deploy the website's short LIST/BID/BUY commands.
  Verify the same auction number appears on the website and in outgoing mail;
  old UUID commands must continue to work.
- Apply `supabase/migrations/202610190008_donation_acknowledgments.sql` after `007`
  and deploy the matching bot for one thank-you per gift donation. Verify the
  package remains untouched and subsequent polls/restarts do not send another.
- Apply `supabase/migrations/202610190009_normal_kmail_donations.sql` after `008`
  and deploy the matching bot for normal DONATE mail. Check funded donations get
  one thank-you, empty DONATE gets instructions. With migration `012` and its worker, unrelated
  mail remains untouched instead of being automatically refunded.

- Apply `supabase/migrations/202610190014_auction_message_layout.sql` after `013`.
  Verify auction-number-first underlined headings, the outbid notice, and the seller
  sale/commission/proceeds breakdown. Check split receipts and unchanged old retries.

### 2. Finish real auction and bot testing

- Test a complete item deposit → funded bid → outbid refund → expiry → winner
  item delivery and seller payment using controlled accounts and small amounts.
- Test Instant Purchase, excess refunds, raising your own bid, seller cancellation,
  unsold item returns, and rejected deposits/bids.
- Verify restricted recipients/items, gift donations, rollover, split deliveries,
  restarts, and interrupted or uncertain sends. Successfully sending a linking
  confirmation does not establish that every auction scenario works in game.
- Keep current defaults documented and consistent: **7.5% seller fee on new listings (rounded down to whole Meat)**, with the auction
  duration starting when the bot accepts the seller's deposit.

### 3. Maintain the hosted bot and backups

- Apply `supabase/migrations/202610190012_bot_mail_review.sql` after `011` and
  deploy the matching bot. Validate mixed valid/unsupported mail, retained rejected
  requests, deferred source deletion, and one tracked manual-review notice per
  uncertain delivery with small controlled sends. If that notice is uncertain,
  it must remain blocked without recursive replies or automatic retries.
- Add an external health alert and durable healthy/blocked/error heartbeat.
  Docker already restarts crashed containers, but this cannot recover a stopped,
  unavailable, or reclaimed VM. Keep only one bot running, including read-only mode.
- Decide the public outage policy and add an outage banner/disable instructions
  when appropriate. Current behavior: clocks continue; bids processed after the
  deadline are rejected/refunded, even if sent earlier; existing accepted bids and
  queued settlements survive in Supabase. No automatic auction extensions exist.
- Verify all gift packages count as donations regardless of notes. With `013`,
  normal DONATE qualifies. With `015`, blank/invalid funded normal mail is refunded,
  and unfunded unrelated messages remain untouched.
- Keep asset checks enabled; investigate deficits/reserve failures rather than
  bypassing them. Test the recovery procedure and uncertain-send evidence checks.
- Choose a private off-device code/credential backup. The laptop copy and ignored
  `/bot/` folder alone do not cover laptop loss. A separate private code repository
  or one replaced encrypted bundle avoids accumulating archives on the laptop.
- Configure encrypted off-device database backups with a bounded rotation (proposed:
  7 daily copies), upload verification and failure alerts. No destination or schedule
  has been configured. A daily backup still leaves up to a day's recovery gap.
- Perform a real restore of the saved backup into an isolated compatible database,
  verify it, then delete the disposable database. Archive listing and synthetic
  migration tests are not a real backup restore test. Keep all bots stopped after
  any real rollback until sends since the snapshot have been reconciled.

Operational details and the remaining setup are in local `bot/OPERATIONS.md`.

- Apply `supabase/migrations/202610190013_closet_income.sql` after `012` and restart
  the matching bot. Test 7.5% seller fees, protected escrow/refunds/review assets,
  unopened gift-package closeting, exact donation moves, and C-reference reconciliation
  with controlled small amounts. Existing listing fees stay fixed; fees enter the
  closet queue only once the sale's outgoing deliveries are confirmed.
- Deploy/restart the rollover-aware worker and change any existing server
  `BOT_MEAT_RESERVE` to 0 unless an extra owner-funded buffer is specifically wanted.
  Test the two-minute transfer pause and automatic recovery through real rollover,
  including startup during maintenance. Unexpected interrupted writes must still
  remain blocked for evidence. Check new gift-wrapper types when game data changes;
  old donation receipts/fees are not automatically backfilled.

- Apply `supabase/migrations/202610190015_invalid_mail_refunds.sql` after `014`
  and restart the updated bot. Test blank/invalid normal mail refunds, explicit
  DONATE and both empty/non-empty gift notes. Resolve C-1001 from inventory/closet
  evidence; if its item moved, return it to inventory before the correction refund.
- Verify the corrected GET item-closet request with a small explicit DONATE test.
  Check recorded before/after balance diagnostics if it still fails. Unknown moves
  remain blocked; a code update alone must not retry them.

### 4. Finish production email and account recovery checks

- Configure production SMTP with a supported verified sending address/provider;
  see [email setup](supabase/EMAIL_SETUP.md). The requested `kHub_Bot@proton.me`
  mailbox alone does not provide the required production SMTP setup.
- Confirm Supabase's site URL and allowed confirmation/recovery redirects match
  the current deployed website and localhost development URLs.
- Test actual signup confirmation, resend, password recovery, and expired links
  on both local and deployed URLs. Provide a recovery process for lost KoL access.

### 5. Add moderation and administrator tools

- Add a workflow for disputes, abusive listings, and operator intervention.
- Enforce administrator permissions in the database and keep an audit trail of
  moderation actions. Seller cancellation and delivery reconciliation already exist.
- Review GitHub's reported dependency alerts and address applicable issues.

### 6. Clarify statistics and legacy auction handling

- Keep bot-confirmed escrow sales distinct from legacy participant-confirmed trades;
  decide how legacy records should appear when the site opens publicly.
- Define any additional statistics before adding them, especially total amounts
  bid versus current winning bids versus completed purchases/sales.

### 7. Decide long-term history retention

- Auctions and bid history are preserved after closing. Decide later whether to
  archive or delete old records, retaining the financial/audit records needed for support.

### 8. Future features

- Add an alternative auction type accepting items, Meat, or a mixture as offers.
- Let sellers accept or reject offers; an accepted replacement offer supersedes
  the previous one. Define escrow/refund rules before implementing this workflow.
- Show pending/unanswered offers privately to sellers, with a reminder when new
  offers need attention.
- Consider Supabase Realtime if faster screen updates become useful; retain
  reconnect/refresh handling. The current bot remains the authority for funded bids.
