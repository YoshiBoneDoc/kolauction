# KoL Auction Hub roadmap

Remaining work only. Updated October 21, 2026.

# BUGS TO ADDRESS ASAP:
- 

# Small Quick fixes:


## 1. Outstanding audit fixes
- Show an unavailable/retry state on All Auctions after a failed initial load,
  rather than presenting missing data as “0 auctions found.”

- Provide an auction-linked administrator contact/query flow for Escrow trades,
  with the appropriate participant checks and inbox context.
- Update the trade-history help text to explain that completed Direct trades
  require both parties' completion responses, including reviewed resolutions.

## 2. Direct-trade follow-up

- Add KMail reminders for direct-trade completion and the 48-hour deadline.
- Define how agreed extensions and outage grace periods are recorded and shown
  on trade cards and deadline notices.

## 3. Moderation and security

- Add abusive-listing moderation tools and remaining dispute-review controls.
- Review GitHub dependency alerts and address applicable issues.

## 4. Find a seller

- Add case-insensitive search by public kHub username with clickable profiles.
  Clearly distinguish similar names; exclude private account information, verified
  player numbers and buyer histories.
- Extend seller history with reviewed withdrawal/default outcomes when available.

## 5. Completed-sales gallery and public statistics

- Build a completed-sales gallery and site-wide activity statistics. Count eligible
  sales once, keep tips/donations separate, and avoid double-counting commission.
  Preserve buyer anonymity and keep financial administration reports private.

## 6. Operations and backups

- Apply migration 059 and deploy the updated standalone Oracle bot to activate
  account-failure isolation, bounded timeouts and once-only player/admin notices.
- Configure external alerts for stopped, unavailable or reclaimed bot hosts.
- Decide outage/late-bid policy and add an outage banner or participation controls.
  Decide whether outages should pause or extend auction clocks.
- Choose private off-device code and credential backups for the ignored bot folder.
- Configure encrypted off-device database backups, retention (proposed: seven daily
  copies), verified uploads and failure alerts.
- Restore a real saved backup into an isolated database and verify it. Define the
  reconciliation required before resuming production after a rollback.

Operational instructions: [bot operations and recovery](bot/OPERATIONS.md).

## 7. Account instructions

- Put REGISTER and CREDENTIALS/login-recovery instructions on kHub's in-game profile
  or display case.

## 8. Controlled in-game checks before public launch

- Complete escrow tests with small amounts: deposit, funded bids, outbid refunds,
  expiry, winner delivery, seller payment, instant purchase/excess refunds, own-bid
  raises, cancellation, unsold returns, and rejected/restricted recipients/items.
- Verify rollover recovery, startup during maintenance, restarts, split deliveries,
  and interrupted/uncertain sends. Check retained mail, deferred deletion and review
  notices without automatic retries or recursive replies.
- Check DONATE, gift packages with/without notes, invalid funded-mail refunds,
  protected escrow, seller commission, closet moves and C-reference reconciliation.
  Include a package opened before its pending closet move.
- Check direct bids/buyout, closing, both confirmations, multiple pending trades,
  and live/losing-bidder anonymity using separate accounts. Check that only
  unrestricted signed-in viewers see seller/closed-winner names, including API
  responses and logout. Verify optional feedback, admin exclusions, self-withdrawal,
  resolved inbox states, trade queries and related KMail notifications.
- Verify real seller histories, reviewed Wall of Shame publication/removal, and the
  private bug/support inbox plus its KMail notifications to teres Minor (#3552305).

## 9. Future features and decisions

- Add an auction type accepting items, Meat or mixed offers. Define escrow/refund
  rules and how an accepted replacement supersedes the previous offer.
- Add private seller offer review, accept/reject actions and unanswered-offer reminders.
- Add buying auctions, such as a request for 2,000 5-balls at 100 Meat each.
  Decide whether these should be Escrow-only and define funding/delivery rules.
- Consider Supabase Realtime if faster updates become useful, retaining reconnect
  handling and a polling fallback.
- Decide long-term auction/bid archival or deletion while retaining financial and
  moderation records needed for support.
