# KoL Auction Hub roadmap

Remaining work only. Updated October 20, 2026.

## 1. Direct-settlement disputes and feedback

- Add audited corrections to positive confirmations and settlement outcomes,
  appeals and reviewed penalties. Keep buyer and seller behavior separate.
- Define completion deadlines, reminders, outage grace periods, and overdue/disputed
  card states. Silence must not count as a negative response.
- Handle early withdrawals separately from nonpayment/non-delivery. Auctions ending
  without bids must not count as defaults.
- Define a completion rate and its denominator. Keep participant confirmations,
  completed sales and thumbs-down counts distinct; escrow must not inflate direct
  reputation. Unsold auctions and missing responses must not count as defaults.

## 2. Find a seller

- Add case-insensitive search by public kHub username with clickable profiles.
  Clearly distinguish similar names; exclude private account information, verified
  player numbers and buyer histories.
- Extend seller history with reviewed withdrawal/default outcomes when available.

## 3. Completed-sales gallery and public statistics

- Add a paginated **Completed auctions** page with compact cards showing thumbnails,
  quantity, final price, completion date, seller profile and settlement mode.
- Include successful sales only. Keep unsold, cancelled, withdrawn, disputed,
  awaiting-settlement and unconfirmed outcomes in seller history instead.
- Show lifetime completed-sale count, gross sale value, item units, and participating
  seller/buyer counts if practical. Keep escrow and participant-confirmed direct
  totals separate, and decide how to include older manually confirmed trades.
- Count each sale once; exclude tips/donations and avoid adding commission twice.
  Reviewed reversals must update eligibility and totals. Preserve public buyer
  anonymity and keep donation/commission income reports private.

## 4. Moderation and security

- Build dispute and abusive-listing tools with administrator-only access, operator
  intervention, appeals and audited moderation actions.
- Review GitHub dependency alerts and address applicable issues.

## 5. Operations and backups

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
