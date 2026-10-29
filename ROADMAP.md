# KoL Auction Hub roadmap

Remaining work only. Updated October 27, 2026. Verify current state before starting.

# BUGS TO ADDRESS ASAP:
- need to further improve handling heavy traffic
- 
# Small Quick fixes:
- filter for auctions with a buyout price
- filter bundles yes/no

- YOUR PROFILE STUFF:
- in your profile -> Buy order fulfillments -> show how many YOU sold
- move the Escrow/Active · Escrow text under the item name (vs under image)
- Bid history ordered most recent -> oldest
- add the meat stack idea next to totals (maybe next to username eventually)
- larger title: Trade totals

- SELLER PROFILE STUFF:
- on first landing on the page, it filters by active, but when you click Seller Profile and go back, it now filters by completed??
- 

## Operations and reliability
- Verify deployed bot/migration versions and collect fresh timeout/lock diagnostics after the recent fixes.
- Establish private bot release history so deployed and last-working versions can be identified reliably.
- Configure external alerts for unavailable or reclaimed bot hosts.
- Define outage, late-bid and agreed Direct-trade extension policies and their UI.
- Establish private off-device bot/code/credential backups and encrypted database backups with retention and failure alerts.
- Test backup restoration in isolation and document reconciliation before production recovery.

## Moderation and discovery
- Complete abusive-listing moderation and dispute-review tools where still missing.
- Review applicable dependency security alerts.
- Add public seller-name search without exposing private account or buyer information.
- Extend seller history with reviewed withdrawal/default outcomes.
- Add a completed-sales gallery and public statistics with buyer anonymity and correct accounting.

## Future features
- Add item/Meat/mixed-offer auctions with defined acceptance, replacement and refund rules.
- Add private seller offer review and unanswered-offer reminders.
- Define long-term auction/bid archival while retaining financial and moderation evidence.

Operational context: [next-chat handoff](HANDOFF.md:1).
