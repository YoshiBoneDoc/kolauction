# KoL Auction Hub roadmap

Saved October 19, 2026. The site is in development and is not live.
A working KoL trade bot is required before launch. The owner has replaced the
trade-offer workflow with the KMail escrow loop documented in `bot/README.md`.
Preserve the original Info page wording until its instructions are deliberately
updated. Recheck current code before starting each item.

## Recommended next batch

1. Apply the KMail escrow migration and sync the bot's item catalog.
2. Configure server-only bot credentials and link controlled test accounts.
3. Validate real KMail intake/delivery and restart reconciliation before launch;
   deliberately update the Info page to the new workflow afterward.

## Priorities

### 1. Complete the auction lifecycle

New KMail escrow auctions now use bot-owned settlement (section 2). The
participant-confirmation behavior below remains for legacy records only.

Initial development implementation added October 19, 2026; database setup requires running
`supabase/migrations/202610190001_auction_lifecycle.sql` after the first two
migrations. Local database, permission, concurrency, rendering, and service
checks cover the changes. The seller/buyer confirmation flow is a development
placeholder, not the intended launch settlement system. It does not prove a KoL
trade occurred. Launch completion must come from verified bot transactions.

- States: active, awaiting trade, ended without bids, cancelled, and completed.
- Current development behavior: seller and winning bidder each confirm their
  exchange. Replace this as the authority for settlement before launch.
- Current development cancellation permits cancelling before any bids. Align
  cancellation behavior with the Info page's in-game trade and penalty rules.
- Winner and final price are frozen when an expired auction is finalized.
- Profile totals currently count trades marked completed by both participants.
  Before launch, base settled totals on verified bot transactions.

Original requirements:

- Record outcomes such as sold, ended without bids, cancelled, awaiting trade,
  and completed.
- Distinguish an auction ending with a winning bid from a completed trade.
- Show the winner and final price after an auction ends.
- Give the seller and buyer clear instructions for exchanging items and Meat.
- Preserve listings and bid history after expiration. Automatic deletion and
  retention policies are deferred.

### 2. Build the trade bot before launch

KMail escrow implementation added in `bot/` for **kHub (#3888760)**. Apply
`supabase/migrations/202610190004_kmail_escrow.sql` after the instant-purchase
migration, sync the catalog, and follow `bot/README.md`. This new workflow
supersedes the earlier pending-trade/24-hour/manual-confirmation design for new
listings. Legacy unfunded auctions are preserved and never assumed escrowed.

Implemented and locally tested:

- Single-use KMail challenges link website accounts to numeric KoL player IDs.
- New listings remain private/pending until the exact seller's item deposit arrives.
- Only funded KMail bids change the high bid; previous high bids return in full.
- Instant purchase uses actual attached Meat; excess is refunded.
- Expiry automatically queues item delivery and seller payment, or an unsold return.
- Website bids/purchases cannot bypass funding; new escrow sales cannot be manually
  marked completed by participants. The bot acknowledges real sends to complete them.
- Durable receipts, deterministic/chunked outbox sends, private tables, role checks,
  balance checks, race serialization, and audited uncertain-send reconciliation.
- Standalone Node 24 worker, read-only default, runbook, and optional container file.

Defaults matching the newly requested loop: 0% seller fee; duration starts when the
item deposit is accepted. Settings are snapshotted on each new listing. Fee/deadline
alternatives remain configurable; the earlier 2% fee is not silently retained.

Still required before public launch:

- Hosted SQL application, catalog sync, secure bot credentials, an always-on runtime.
- Controlled real KoL tests for raw mail parsing, send acknowledgment, restricted
  recipients/items, rollover, split amounts, refunds, and partial-failure recovery.
- End-to-end tests of account linking and the deployed website.
- Resolve unsupported/system mail manually; monitor private delivery attention.
- Deliberate Info page edits to replace the old trade-offer instructions. Its
  original text has not been rewritten as part of this implementation.
- Production SMTP and the other account/security launch work below.

### 3. Verify KoL identities

Implemented for new KMail escrow listings/bids using single-use verification
challenges. Profile linking polls for the bot's acknowledgment. Numeric KoL IDs
are unique across website profiles, and clients cannot assign their own verified
IDs. Actual sender IDs come from the authenticated KoL inbox; display names alone
are not identity proof. Controlled live linking tests and operator recovery for
lost access remain launch checks.

### 4. Add account recovery and reliable email delivery

App flows implemented October 19, 2026: Forgot Password, password reset,
confirmation resending, and confirmation-result pages. Automated checks cover
localhost/HTTPS redirects, recovery-session handling, email errors, and page
rendering. See `supabase/EMAIL_SETUP.md` for dashboard settings and manual checks.

Still pending: production SMTP, a supported sending address, real deployed URL,
and end-to-end email delivery/link verification. The requested address is
`kHub_Bot@proton.me`; Proton's direct SMTP submission requires a custom-domain
address, so this mailbox alone cannot supply the hosted SMTP connection.


- Add a Forgot Password flow and password reset page.
- Add a Resend Confirmation Email option.
- Configure production SMTP before inviting public users; Supabase's default
  sender has restrictions intended for testing.
- Verify confirmation and recovery links for both local and deployed URLs.

Reference: https://supabase.com/docs/guides/auth/auth-smtp

### 5. Improve auction browsing

Implemented October 19, 2026:

- Item-name search with case-insensitive partial matching.
- Active (default), ended (all outcomes), completed trades, and all-auction
  filters. Completed trades remain distinct from expired bidding or pending trades.
- Sorting by ending soon, newest, and price in either direction. Price uses the
  current bid, falls back to the minimum bid, and uses final prices after settlement.
- Search/filter/sort selections are stored in the URL for sharing, reloads, and
  returning from a listing. Reset filters restores active auctions ending soon.
- Homepage popular listings include only active auctions, ranked by bid count.
  Listings disappear from active results and highlights at their bidding deadline.
- Responsive navigation, cards, bid history, and listing/bidding forms with larger
  touch targets and readable inputs. Listing includes item search, a separate
  preview step, and a Back to edit action that keeps entered values.
- Shared bidding form validates whole-number amounts, supports k/m/b shorthand,
  confirms the intended amount, and preserves the entered bid after server errors.

Validation: browsing/input regression tests, existing auth/lifecycle/service tests,
production build, and Chrome interaction/layout checks using fixture data at
320, 375, 768, and 1280 pixels. Hosted deployment and real database writes were
not part of these checks. No database migration is required for this batch.

#### Optional Instant Purchase Price

Implemented October 19, 2026. Apply
`supabase/migrations/202610190003_instant_purchase.sql` once in Supabase SQL Editor
after the auction lifecycle migration, before deploying these app changes.

- Optional seller-set price for the entire listing, at least the minimum bid and
  at most 20 billion Meat. Blank means ordinary bidding; old listings stay unchanged.
- Displayed on the homepage, listing cards, listing preview, and auction details.
- Buyers can accept it directly. A bid reaching/exceeding it ends bidding at the
  exact instant price. The current high bidder can also accept the instant offer.
- Acceptance records the winner, final price, purchase timestamp, and bid history;
  the listing moves to awaiting trade, rather than completed payment/delivery.
- Row locking protects competing purchases, bids, cancellation, and expiry.
  Repeated successful purchase requests from the same buyer are idempotent.
- Local SQL tests cover upgrades, limits, authorization, price caps, concurrent
  purchases/bids, lock-wait deadlines, trade completion, and restart persistence.
  Service/render tests and mobile Chrome fixture checks cover the UI and RPC flow.
- Hosted SQL execution, deployment, and end-to-end bot settlement remain separate
  setup/launch tasks. The original Info page wording is preserved.

### 6. Add cancellation and moderation

- Let sellers cancel listings before any bids, subject to defined rules.
- Provide an administrator workflow for disputes and abusive listings.
- Preserve an audit trail of cancellations and moderation actions.
- Enforce permissions and cancellation rules in the database.

### 7. Align profile statistics with verified settlement

- The initial lifecycle change excludes auctions merely awaiting trade, but
  completion currently relies on participant confirmations. Switch the authority
  for completed-sale totals to verified bot settlement before launch.
- Separate winning bid amounts, amounts bid, and completed sales/purchases.
- Define each statistic clearly in the interface.

### 8. Improve updates and performance

- Browsers currently reload all listings and bid history every 10 seconds.
- Load only the requested listing page and fetch bid history when needed.
- Use database filtering and sorting as the site grows.
- Consider Supabase Realtime for faster bid updates while retaining refresh
  and reconnect handling.

Reference: https://supabase.com/docs/guides/realtime/postgres-changes
