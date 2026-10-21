# KoL Auction Hub roadmap

Remaining work only. Updated October 20, 2026.

## 1. Direct-settlement disputes and feedback


- add kmailed reminders for direct trade deadlines on conclusion, outage grace periods
  card states. 

## 2. Find a seller

- Add case-insensitive search by public kHub username with clickable profiles.
  Clearly distinguish similar names; exclude private account information, verified
  player numbers and buyer histories.
- Extend seller history with reviewed withdrawal/default outcomes when available.

## 3. Completed-sales gallery and public statistics

- Count each sale once; exclude tips/donations and avoid adding commission twice.
  Reviewed reversals must update eligibility and totals. Preserve public buyer
  anonymity and keep donation/commission income reports private.

## 4. Moderation and security

- Add abusive-listing moderation tools and remaining dispute controls. Account
  bans, expiry, lifting bans, auction holds/review, preserved funded escrow obligations
  and private appeals with image evidence are implemented (auction handling requires migration 051);
  see [account moderation instructions](supabase/ACCOUNT_BANS.md).
- Review GitHub dependency alerts and address applicable issues.

## 5. Operations and backups

- Apply migration 055 to delay profile incomplete counts and their Meat totals
  until 48 hours after auction close (including early buyouts).
- Apply migration 054 and retry `npm run sync-catalog` from `bot/` to repair
  first imports blocked by Supabase safe-update checks; see
  [catalog publishing recovery](supabase/ITEM_CATALOG.md#publishing-blocked-after-the-initial-rollout).
- Apply migration 053 and deploy the website to activate tiered minimum bid
  increases for Direct and Escrow auctions; the Info page includes the thresholds.
- Roll out migration 052 and the updated Oracle bot/website to enable weekly
  KoLmafia item updates and server-enforced tradeable-only listings; see
  [item catalog rollout](supabase/ITEM_CATALOG.md).
- Configure external alerts for stopped, unavailable or reclaimed bot hosts.
- Decide outage/late-bid policy and add an outage banner or participation controls.
  Decide whether outages should pause or extend auction clocks.
- Choose private off-device code and credential backups for the ignored bot folder.
- Configure encrypted off-device database backups, retention (proposed: seven daily
  copies), verified uploads and failure alerts.
- Restore a real saved backup into an isolated database and verify it. Define the
  reconciliation required before resuming production after a rollback.

Operational instructions: [bot operations and recovery](bot/OPERATIONS.md).

## 6. Account instructions

- Put REGISTER and CREDENTIALS/login-recovery instructions on kHub's in-game profile
  or display case.

## 7. Controlled in-game checks before public launch

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
  resolved inbox states, trade queries and positive/negative/withdrawal KMail.
- Verify real seller histories, reviewed Wall of Shame publication/removal, and the
  private bug inbox plus its KMail copy to teres Minor (#3552305).

## 8. Future features and decisions

- Add an auction type accepting items, Meat or mixed offers. Define escrow/refund
  rules and how an accepted replacement supersedes the previous offer.
- Add private seller offer review, accept/reject actions and unanswered-offer reminders.
- Consider Supabase Realtime if faster updates become useful, retaining reconnect
  handling and a polling fallback.
- Decide long-term auction/bid archival or deletion while retaining financial and
  moderation records needed for support.

## 9. bidding mechanics

-  change it so people cant just bid 1 meat over to beat the current bid.

## 9. buy auctions

-  Add buying auctions ex. some wants to buy x2000 5-balls for 100 meat each.  maybe escrow only?
