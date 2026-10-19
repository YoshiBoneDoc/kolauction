# User profile database setup

In your Supabase project, open **SQL Editor → New query**, paste the contents of
`migrations/202610180001_create_profiles.sql`, and select **Run**. Run it once.
The transaction rolls back the whole migration if an object already exists or
another statement fails; do not delete an existing table to make it run.

This creates `public.profiles` with a user ID, unique KHub username (1–16
characters, case insensitive), and creation timestamp. Supabase Auth manages
emails and password hashes in its existing `auth.users` table. Never add a
plaintext password column to `profiles`.

RLS allows signed-in users to read their own profile and change their own
username. Anonymous users cannot access profiles. Public seller names and
auction access will need separate policies when auctions are implemented.

## Connect the React application

Registration, email/password login, logout, and session restoration now use
Supabase. KHub usernames remain display names. Add the following public client
settings to `.env.local` in the project root (see `.env.example`):

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

Find these values in your Supabase project's Connect dialog or API settings.
A legacy anon key can also be used as the value of
`VITE_SUPABASE_PUBLISHABLE_KEY`. Never use a secret or service-role key here;
Vite embeds these settings in the browser application.

Restart `npm run dev` after changing these values. In Supabase Authentication
URL Configuration, set Site URL to your application's address, such as
`http://localhost:5173` during local development. Change this to your deployed
address when publishing. With email confirmation enabled, registration shows
instructions to check email before logging in. With it disabled, signup signs
the user in immediately. Configure production SMTP before a public launch;
the built-in email sender has recipient and rate restrictions.

The registration call sends `options.data.khub_username`, matching the trigger.

The database trigger creates the profile in the same transaction as the Auth
user. A missing, blank, overlong, or duplicate username will reject signup.
This also applies to users created in the dashboard and any future OAuth
signup flows. Those flows need a username onboarding strategy before enabling
them. Existing Auth users are not backfilled by this migration; accounts in
browser storage are not migrated either. The app removes the old `users` and
`currentUser` browser-storage entries containing plaintext passwords; existing
prototype users must register again.

For an initial implementation, use email/password login. The profile policies
intentionally do not provide a public username-to-email lookup.

## Verify after applying

1. Confirm `profiles` appears in Table Editor with RLS enabled.
2. Register through Supabase Auth with the metadata above and check that a
   matching profile appears. Complete email confirmation if enabled.
3. Test with a second account: it must not be able to read or update the first
   account's profile. Use authenticated API calls for this check; SQL Editor
   normally runs as an administrator and bypasses RLS.
4. Confirm a case variant of an existing username is rejected at signup.

Reference: https://supabase.com/docs/guides/auth/managing-user-data

## Auction and bid storage

After the profiles migration, run
`migrations/202610180002_create_auctions_and_bids.sql` once in the Supabase SQL
Editor. Do not rerun the profiles migration. This adds `auctions`, `bids`, RLS
policies, and the `create_auction` and `place_bid` functions used by React.

Listings, quantities, minimum prices, seller IDs, end times, current bids,
and complete bid history are stored in PostgreSQL. The profile page derives
current/past listings and bid totals from those saved records. The item catalog
in `src/data/items.json` is static reference data, not user-created listings.
Form drafts, search/display choices, and unsubmitted bid amounts remain temporary.

Public visitors can read listings and bid history, including seller/bidder
display names. Profiles and emails remain private. Clients cannot directly
insert, update, or delete auctions or bids. The database functions derive the
seller/bidder identity from authentication, enforce auction limits, set end
times using the server clock, reject expired/own/too-low bids, and lock the
listing while accepting a bid so competing requests cannot overwrite each
other. Historical username snapshots remain unchanged if a profile is renamed;
profile history uses stable account IDs.

Expired listings remain stored for history, and bidding closes at the server
deadline. Apply the lifecycle migration below to enable recorded outcomes,
cancellation, and completion confirmations. This does not perform payment or
item delivery. No direct client table-write permissions are granted. References to profiles
prevent deleting an account that has auction history without an explicit
retention/anonymization process.

The app reloads listings at startup, after writes and account changes, every
10 seconds, and when the browser window regains focus. No Realtime publication
or GraphQL configuration is needed. A rejected write keeps the form open and
shows the database error. A successful write remains saved even if the
follow-up refresh fails; use Retry to reload it rather than resubmitting.

Listings created in the previous in-memory prototype cannot be recovered once
that page has been refreshed. New listings persist after the migration.

### Verify auctions

1. Create a listing while signed in. Refresh, restart Vite, and sign out/in;
   confirm it remains on Home, All Auctions, and your profile.
2. Open its detail URL directly in another browser and confirm it loads.
3. Sign in with a different account and bid. Confirm the bid and history survive
   refresh and appear in the bidder's profile. Other tabs update within 10 seconds.
4. Confirm bidding on your own listing, below the minimum, or on an expired
   listing is rejected.

Local checks:

```bash
node --test tests/*.test.mjs
python3 tests/database_test.py
```

The Python check requires PostgreSQL binaries on PATH. It creates a disposable
local cluster with a minimal Auth schema, tests both migrations and permissions,
races competing bids, restarts PostgreSQL to verify saved data, and removes the
cluster afterward. It does not modify your Supabase project.


## Auction lifecycle migration

Run `migrations/202610190001_auction_lifecycle.sql` once in SQL Editor after the
two earlier migrations. Existing listings, accounts, and bid histories are kept.
Do not rerun the old migrations. The new app requires this migration; otherwise
its storage banner will ask you to apply pending migrations.

States and transitions:

- `active`: accepts bids until its server deadline; the seller can cancel only
  if it has no bids.
- `awaiting_trade`: bidding ended with a winning bidder. The winner ID, username
  snapshot, final price, and finalization time are recorded.
- `ended_no_bids`: bidding ended without a winning bidder.
- `cancelled`: the seller cancelled before a bid. The listing remains in history.
- `completed`: both seller and winner confirmed their finished in-game exchange.

The app calls `finalize_expired_auctions` before loading listings. This records
expired outcomes when the site is next visited/refreshed, including after an
extended period offline. No scheduled job is required. While nobody is visiting,
a row can retain `active` past its deadline; the server still refuses all late
bids, and the next load finalizes it. The display also handles deadline crossings
between refreshes. Creation of new rows continues using the existing RPC.

Only the seller and winner can call `confirm_auction_trade` for their own side.
The first confirmation leaves the trade pending; the second completes it.
Repeated confirmations/cancellations are safe and preserve saved timestamps.
`cancel_auction` and `place_bid` lock the same row, so cancellation and a first
bid cannot both succeed. Clients cannot directly change statuses, winners,
amounts, confirmations, or deadlines. The internal `finalize_auction` helper is
not callable by public API roles.

Trade instructions on the detail page identify the quantity, item, final price,
counterparty, and auction reference. Users arrange the exchange in KoL and
confirm only after receiving their side. The site does not verify in-game
transfers, verify KoL account ownership, act as a middleman, or move assets.
There is no confirmation deadline or automatic dispute resolution in this version.
Listings and bids are never automatically deleted.

Profile pages separate active records, awaiting trades, and history. Completed
sales and purchase totals count only trades confirmed by both participants.

After applying, check an ended listing with a bid: the outcome should say Awaiting
trade. Confirm with the seller account, then with the winning account. Only the
second confirmation should produce Trade completed and update the completed-sale
and purchase totals. An unrelated account must not see a confirmation control
and cannot submit one through the API. Test seller cancellation on a separate
active listing before bidding; its detail page should remain accessible afterward.

## Optional instant purchase price

Before deploying the instant purchase UI, run
`migrations/202610190003_instant_purchase.sql` once in Supabase SQL Editor after
the existing auction lifecycle migration. Run the entire new file. Do not rerun
the earlier table-creation migrations. Existing listings and bids are preserved;
existing listings have no instant purchase price and keep ordinary bidding.

Sellers can optionally set an **Instant Purchase Price** for the entire listing,
not per item. It must meet the minimum bid and be at most 20 billion Meat.
Leaving the field blank stores `NULL` and disables instant purchasing. The price
remains available while the listing is active, including after lower bids.

`purchase_auction` reads the saved price and the buyer's authenticated profile,
locks the listing, records a bid at exactly that price, freezes the winning buyer
and final price, and moves the auction to `awaiting_trade`. It records
`instant_purchased_at` without changing the original scheduled deadline. Purchase
is also available to the current highest bidder. A bid reaching or exceeding the
instant price follows the same transaction and records only the instant price,
not the excess amount entered. Buyers confirm the exact amount before submitting.

Sellers, anonymous users, and buyers of expired/cancelled/already-purchased
listings cannot accept the offer. Repeating a successful purchase as the same
buyer is safe and preserves the outcome and bid history. Purchase, bids,
cancellation, expiry, and confirmation lock the same row so competing requests
cannot produce multiple winners or overwrite a recorded purchase. No new direct
table-write access is granted.

The `create_auction` RPC gains an optional `p_instant_purchase_price` argument;
older callers omitting it still create normal auctions. The migration replaces
the old signature to avoid ambiguous PostgREST overloads. The new app requires
this migration for listing creation and purchases; it never silently discards a
requested instant price when the migration is missing.

An accepted purchase ends bidding; it does not complete payment or item delivery.
The existing trade workflow still applies. The launch bot must verify the
purchase and settle/refund in-game offers before this can be used publicly.

Verify with a second account: accept a listing's offer and check its saved winner,
final price, purchase timestamp, and awaiting-trade status after refresh. Other
buyers must then be refused. Test a bid above the instant price and check only
the set price appears in history. Test a listing without an instant price to
confirm ordinary bidding still works. The local database tests additionally race
buyers/bids, verify deadline checks after lock waits, test permissions and retries,
and confirm data survives a database restart.

## Duplicate registration validation

Run `migrations/202610190002_registration_conflicts.sql` once after the profiles
migration. This adds `registration_conflicts`, called before public signup.
Usernames are checked case-insensitively against `profiles`; email addresses are
trimmed and checked case-insensitively against Supabase Auth, including accounts
that have not confirmed their email. Matching usernames, emails, or both produce
clear registration errors instead of a confirmation success message.

The function returns only `username_taken` and `email_taken` flags. It intentionally
allows the signup form to report that an account identifier is already registered;
it grants no direct read access to profiles or `auth.users`, and does not return
email addresses, IDs, or passwords. Missing or failed checks block form signup
until setup/connectivity is corrected. Login is unaffected.

The existing profile unique index and Supabase Auth remain responsible for
uniqueness at write time; an availability check alone does not reserve an identifier.
The client also rejects Supabase's obfuscated duplicate-email response (empty
identities) and explicit duplicate-email errors. A database signup failure triggers
another availability check to identify usernames claimed by competing requests.

Verify with separate attempts using an existing username/new email, a new
username/existing email, and both existing. All should be rejected without the
success message. Repeat with case variants and an unconfirmed email account.
A new username and unused email should still proceed to email confirmation.


## Account recovery and email delivery

See [EMAIL_SETUP.md](EMAIL_SETUP.md) for the recovery/resend pages, email templates,
Supabase SMTP settings, localhost and production callback allowlists, and manual
verification. No additional database migration is needed for these Auth flows.
The requested Proton mailbox is documented there; production sending has not
been configured because Proton SMTP requires a supported custom-domain address.


## KMail escrow bot (new workflow)

The owner has replaced pending trade offers and manual completion with KMail
escrow for new listings. Run `migrations/202610190004_kmail_escrow.sql` once after
the instant-purchase migration, then follow [the bot runbook](../bot/README.md).
The earlier lifecycle sections describe **legacy auctions** after this upgrade.
Do not treat their existing bids as funded or automatically settle them.

This adds private receipt/delivery/verification/catalog tables, KoL identity
linking, pending-deposit listing privacy, service-only processing RPCs, bot-owned
completion, and durable refund/payout obligations. The website requires this
migration and catalog sync before new listings can be created. Existing rows are
kept. Only the server bot gets a service-role key; never set one in browser env.

Defaults: no seller fee and duration begins on exact item-deposit acceptance.
`bot/README.md` documents optional fee/fixed-deadline settings, startup, supported
KMail commands, and the operator reconciliation process. Hosted migration and
real KoL credentials/delivery have not been applied or tested by local changes.
