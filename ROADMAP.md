# KoL Auction Hub roadmap

Saved October 19, 2026. The site is in development and is not live.
A working KoL trade bot is required before launch. The original Info page is the
intended product specification; preserve its wording unless the owner explicitly
requests edits. Recheck current code before starting each item.

## Recommended next batch

1. Design the bot workflow around the original Info page's verification,
   pending trade offers, refunds, settlement, fee, and timing rules.
2. Align the database and auction lifecycle with bot-verified transactions.
3. Implement and test the bot before launch, then improve browsing and accounts.

## Priorities

### 1. Complete the auction lifecycle

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

The original Info page describes the intended launch behavior. Implement that
behavior rather than rewriting the page around temporary limitations.

- Choose the bot's KoL account and fill in placeholder names only when the owner
  supplies the intended name.
- Verify account ownership through kMail and link the verified KoL identity to
  the website account.
- Read and validate pending trade offers against listing IDs, item IDs,
  quantities, bidder identities, and Meat amounts. Retain the Info page's message
  conventions while defining an unambiguous auction reference for duplicate items.
- Publish auctions and bids only after the required bot verification. Define how
  pending verification interacts with the bidding deadline and competing bids.
- Detect withdrawn offers and enforce the specified cancellation restrictions
  and 24-hour penalties.
- Handle outbid users' pending offers/refunds according to the Info page.
- Settle the winning auction, collect the specified 2% fee, and deliver the
  correct items and Meat to the correct parties.
- Implement the specified response/collection workflow, including its 24-hour
  response window and handling of missing or cancelled offers.
- Record bot actions, trade identifiers, fees, amounts, and delivery outcomes in
  the database. Retrying after a timeout or restart must not double-pay, double
  refund, or deliver items twice.
- Reconcile website state with KoL after interruptions or partial settlement,
  and provide an administrator recovery path for unresolved trades.
- Keep bot credentials and privileged database access in the bot's server-side
  environment, outside the browser application.
- Test successful settlement, no bids, outbids, withdrawals, timeouts, competing
  bids, partial failures, and bot restarts before launch.

### 3. Verify KoL identities

- A registered KHub username currently does not prove ownership of that KoL
  account.
- Implement the intended kMail verification through the bot; define any
  administrator fallback explicitly.
- Store verification status and enforce any restrictions in the database,
  rather than only hiding controls in React.

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

- Add item-name search.
- Add active/completed filters.
- Add sorting by ending soon, newest, and price.
- Prioritize active auctions on the homepage; popular listings currently can
  include expired auctions.
- Make listing and bidding flows comfortable on mobile screens.

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
