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
  one thank-you, empty DONATE gets instructions, and other unknown mail still refunds.

### 2. Finish real auction and bot testing

- Test a complete item deposit → funded bid → outbid refund → expiry → winner
  item delivery and seller payment using controlled accounts and small amounts.
- Test Instant Purchase, excess refunds, raising your own bid, seller cancellation,
  unsold item returns, and rejected deposits/bids.
- Verify restricted recipients/items, gift donations, rollover, split deliveries,
  restarts, and interrupted or uncertain sends. Successfully sending a linking
  confirmation does not establish that every auction scenario works in game.
- Keep current defaults documented and consistent: **0% fee**, with the auction
  duration starting when the bot accepts the seller's deposit.

### 3. Maintain the hosted bot and backups

- Monitor the Oracle-hosted bot for crashes, insufficient assets,
  unsupported/system mail, uncertain deliveries, and free-tier host interruptions.
  Reconcile uncertainty using evidence before retrying a delivery. Keep only one
  copy running, including read-only mode, to avoid conflicting KoL logins.
- Back up the separate bot code securely: `/bot/` is intentionally ignored by the
  website repository. Keep credentials private in whichever backup/repository is used.
- Test restoring the database backup into an isolated database; checking the dump's
  archive listing alone was not a restore test. Plan ongoing backups.

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
