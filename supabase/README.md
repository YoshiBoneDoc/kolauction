# User profile database setup

For the public framed ban gallery, see [Wall of Shame setup](WALL_OF_SHAME.md).

## Authenticated name visibility (`035`)

Apply `migrations/queue/202610200035_authenticated_name_visibility.sql` after `034`
and deploy the website. This supersedes the earlier public-name rules below.
Signed-out viewers and accounts restricted by profile, identity or Supabase Auth
ban receive generic seller/winner/profile labels from the database. Browsing,
prices, outcomes and aggregate statistics remain available. The frontend also
masks names on logout and separates cached data by the actual authenticated user.
Seller profiles keep generic navigation links for visitors.

Signed-in, unrestricted accounts can see seller names and server-finalized winner
names. Private trading contacts remain limited to the actual seller/winner, and
are withheld from restricted accounts. Live/losing bid identities remain anonymous
to ordinary viewers; migration 062 adds server-authorized administrator access.
The gallery similarly hides player names/numbers and identifying reason text from
outsiders. Private administrator access also checks Auth-level bans. No stored
profile name, auction result, report or KMail is changed by this migration.

## Self-resolution and trade queries (`034`)

Apply `migrations/queue/202610200034_trade_resolution.sql` after the already-applied
`033`. New negative-rating KMail encourages resolving the trade with the other
party, explains author withdrawal, and points to Ask an administrator about this
trade as a last resort. Existing queued/uncertain messages remain unchanged.

The author can Withdraw thumbs down on the auction page. This removes its negative
count, notifies the recipient, and marks the original inbox entry Resolved by
reporter. A matching inbox filter keeps these out of Open messages while retaining
the original report and an author/timestamp audit record. Administrators cannot
restore withdrawn feedback. Withdrawal alone is neutral: a separate positive
confirmation is required to give a thumbs up or complete the sale.

If the author later confirms receipt, a separate positive KMail is safely queued.
Notification uniqueness includes the feedback polarity, preserving the original
negative-delivery evidence. Repeated withdrawal/confirmation calls do not duplicate
notices. Rating recipients still require verified KoL numbers.

A participant-only Trade query form is linked from each closed direct auction.
Queries are private administrator messages, associated with the auction, and do
not modify either party's rating. Messages and notification copies use the existing
inbox limits and durable KMail queue. No bot code update or second instance is needed.

## Rating KMail and reputation summary (`033`)

Apply `migrations/queue/202610200033_rating_notifications.sql` after `032`, then
deploy the website. New direct-trade confirmations and thumbs-downs atomically
queue one zero-asset KMail to the rated player. Seller feedback goes to the seller;
buyer feedback goes to the winner. A rating notification is sent even when a
negative response has no explanation. The explanation stays administrator-only;
blank responses still do not queue an administrator copy.

Each notification is durably linked to the auction, author, recipient and delivery.
Retries, duplicate confirmations and uncertain sends cannot queue another copy.
Existing feedback is not mass-notified. In its trade inbox entry, administrators
can use **Send missing rating notices** to queue both parties' missing notices for
that auction. Recipients need verified KoL player numbers; missing verification is
reported rather than guessed. Existing queued delivery bodies are not rewritten.
The current worker handles these notices without a code update or extra instance.

The detailed public profile shows As Seller, As Buyer and Overall positive/negative
counts and scores. Score is positive minus negative; overall combines both roles.
The compact sidebar shows the overall score. Escrow is excluded, and one positive
response is not proof the entire sale completed.

## Direct feedback and public winners (`032`)

Apply `migrations/queue/202610200032_direct_feedback_and_public_winners.sql` after
`031`, then deploy the website. This supersedes the earlier review-first rating and
always-anonymous winner rules below.

- A participant's thumbs down counts immediately against the other party, in their
  seller or buyer rating. Existing `031` reports count by default too. Positive
  counts use the other participant's explicit receipt confirmation. Escrow sales
  contribute to neither rating. A positive response alone is not a completed sale.
- Trade explanations are optional (0–2,000 characters). A blank response creates one
  inbox entry for rating review, without KMail. Explained reports still queue a
  KMail copy, with the existing cooldown, splitting and uncertain-send protection.
  One response per participant per trade and safe retries still apply.
- The administrator inbox shows Remove/Restore thumbs-down count. Each effective
  change requires a private review reason and records administrator, timestamp and
  previous/new eligibility. Original feedback stays intact. Resolving an inbox
  message does not change its rating count; excluding a count does not mark the
  trade completed or erase either party's response.
- Public profiles now show distinct seller/buyer counts, including accounts with
  completed bidding as a winner but no hosted listings. Buyer histories and private
  explanations are not added to the public profile.
- Once the server freezes a winning result (`awaiting_trade`, `settling` or
  `completed` with `finalized_at`), its public winner username/profile is visible
  to everyone. An expired browser timer alone does not reveal the winner. Live and
  losing bid identities remain anonymous. Verified player numbers and direct-trade
  contact details remain limited to the actual seller and winner.

No existing queued KMail, password, auction result or delivery is rewritten or
resent. No bot update/restart or additional instance is required.

## Direct-trade problem reports (`031`)

Apply `migrations/queue/202610200031_trade_reports.sql` after `030`, then deploy
the website. Pending trade cards and private auction details offer a red thumbs-down
link to a required explanation form. Only the verified seller/winner of a closed
direct sale awaiting settlement can submit. Reports enter the administrator inbox's
Trade queries tab with auction/participant-role context and a durable KMail copy.
Reasons remain administrator-only. Participants see a reported-issue notice, and
the reporter's own reminder clears. The other participant can still respond.

A positive confirmation and a negative report are mutually exclusive for each
participant. Retries are idempotent, duplicate reports are prevented, and concurrent
positive/negative responses serialize with settlement. A reported sale remains
awaiting settlement even if the other party confirms. Reports are not automatic
negative ratings, defaults or bans. Inbox resolution alone does not adjudicate the
sale or erase a response; audited outcome/correction tools remain roadmap work.
Existing reports, auctions, escrow deliveries and queued KMail are not rewritten.
No bot code update or extra worker is required.

## Personal confirmation reminders (`030`)

Apply `migrations/queue/202610200030_unconfirmed_trade_reminders.sql` after `029`
and deploy the website. A pending trade appears on home/browse only for a seller
or winning buyer who has not confirmed yet. The server filters before counting
and pagination. Confirming does not complete the sale until both parties confirm;
the auction details/history still show the waiting status and private instructions.
No stored confirmations, obligations or deliveries are rewritten; no bot restart
or additional worker is needed.

## Ban appeals (`029`)

Apply `migrations/queue/202610200029_ban_appeals.sql` after `028` and deploy the
matching website. The Wall of Shame's Submit an appeal link opens `/submit-appeal`.
Verified account holders submit private text to the Ban appeals inbox tab and the
existing durable KMail queue. Existing site-banned accounts can authenticate using
an appeal-only resolver; normal username login stays blocked and trading/admin
checks are unchanged. An appeal does not unban anybody. Supabase Auth-level bans,
lost passwords or accounts never registered with kHub still need direct KMail
support. The form links that fallback. Requests are idempotent and share bug-report
rate limits across categories. Existing queued mail is untouched; no bot update
or additional worker is needed.

## Shared administrator inbox (`028`)

Apply `migrations/queue/202610200028_shared_administrator_inbox.sql` after `027`,
then deploy the matching website. The administrator-only top-right `inbox` link
opens `/admin/inbox`; `/admin/bug-reports` remains available for old links.
Server-side tabs cover All, Bug reports, Trade queries, Ban appeals and Other.
Existing reports default to Bug reports. Administrators can move messages between
categories, with an audit trail. Status filters and pagination apply within each
category. The existing bug form continues submitting bugs; separate trade-query
and ban-appeal forms are future work. Reports remain private to administrators.
No queued KMail, report body or notification is rewritten or resent. No bot update
or extra worker is needed. The Report a Bug links are omitted on the inbox page.

## Login usernames (`027`)

Apply `202610200027_prefixed_login_names.sql` after `026`, then deploy the matching
website. New credential KMail shows one `kHub Username: KH_<KoL name>` line.
Existing KMail accounts use the same password with the prefixed login name.
Public profile/seller names stay unchanged; no account names, passwords, pending
jobs or already queued/uncertain messages are rewritten. Old saved credential
messages therefore still show the old name: add `KH_` when signing in.
The prefix is a naming distinction, not an extra authentication factor.
Legacy email accounts retain email login; their recovery mail labels it separately.
The current worker needs no code update or additional instance for this migration.

## Current account setup: KMail registration

Stop all workers and apply
[`migrations/queue/202610190019_kmail_accounts.sql`](migrations/queue/202610190019_kmail_accounts.sql)
after `018`, then deploy/restart the matching bot and website together. Move the
script out of `queue/` yourself after successful application. Do not rerun `019`.

New players register using `REGISTER` in normal KMail to
kHub (#3888760), without attachments. The sender's actual KoL player ID is linked
automatically. The bot uses Supabase Admin API with an auto-confirmed internal
address (`account-<UUID>@login.khub.invalid`); this is an Auth routing identifier,
not a user-supplied email address or mailbox. New accounts log in with their verified KoL
username. Custom usernames are rejected and users cannot edit their profile name.
Existing test accounts are left untouched; this migration does not delete accounts. No signup, confirmation or recovery email is sent by this flow.

`CREDENTIALS` from the same linked KoL player creates a fresh generated password.
Old passwords cannot be retrieved. Existing email accounts keep their existing
credentials/history; once linked through the existing VERIFY flow, KMail recovery
can also reset their password without SMTP. Unlinked legacy accounts require
support if their owner cannot log in; a claimed username alone never proves ownership.

The database rejects public email signup without a verified pending bot job,
reserves verified KoL names, and checks player/name/account bans. Disable **Allow new
users to sign up** in Supabase Auth settings as an additional measure; server-side
Admin API creation remains the bot's path. Keep email-based reauthentication off
if no SMTP is configured; logged-in password changes use Supabase `updateUser`.
Enforce a minimum password length of 12 in Supabase's Auth password settings to
match the website, while retaining existing passwords for login.

Account jobs and outgoing credential messages are private, service-only records.
Pending jobs store a generated secret so retries use the same operation. Job secrets
are cleared once replies are queued; credential bodies are cleared after an
acknowledged send. Uncertain sends keep their exact body for reconciliation.
Routine inspect/lookup output omits credential bodies. Saved KoL Inbox/Sent copies
still contain the password: do not publish those messages.

For operator bans, add an active record to `khub_bot.account_bans` by player ID
(preferred) and/or username with a reason. Setting `profiles.is_banned=true` also
records a persistent identity/name ban. To unban, review the case, deactivate all
matching ban records and clear the profile flag; a separate Supabase Auth ban must
also be lifted in Auth. Public users cannot edit ban state. Account and username
bans prevent registration/recovery and block auction writes from existing sessions;
incoming auction assets from banned players are returned. This is not an admin UI.

Earlier email setup notes below describe the legacy system, not new registration.

## Public seller profiles and bidder privacy (`023`)

Apply `migrations/202610200023_public_seller_profiles.sql` after `022` if not already applied,
then deploy the matching website. Move the successfully applied script yourself.
This changes read permissions/projections, not auction records, escrow, fees or
delivery obligations. The bot's service-role permissions remain intact and no
worker restart is required for this migration. The assistant has not applied it.

Seller usernames link to `/seller/<seller-id>`, with paginated current/history
listings, item search, status filters and separate bot-verified and legacy sales
totals. Feedback/rating submission is a later feature; profiles remain unrated.
Optional new direct listings are implemented in queued migration `024`, described
below. Existing direct trades retain their participant-confirmation workflow.

Browser roles can no longer select raw `auctions` or `bids` tables. The existing
`read_auction_page` RPC now explicitly checks visibility and projects public fields.
Bidder names/account IDs/KoL numbers stay private; public history uses per-auction
Bidder 1/2 labels, and a viewer's own bids are labelled You. Migration `032` makes
the winning public username/profile visible once bidding is server-finalized. Only the seller and winning buyer of a server-finalized
direct trade receive its private counterpart identities. Escrow recipients remain
private and the bot still settles escrow. Pending deposits stay seller-only.

The RPC also supports `p_view='seller'`, with `p_id` set to the public seller UUID,
and returns seller summary metadata alongside the requested listing page. It never
returns email addresses, internal Auth routing addresses, bans or donation income.
Gross sale values include commission and count each completed listing once;
large aggregate values use strings to preserve exact integers in JavaScript.

The website requires `privacy_version=1` in the RPC response, so it shows an
unavailable message rather than accepting an older response containing public bidder identities.
Do not restore raw table SELECT grants to fix an old client: deploy the matching
website instead. A full disposable-database regression suite checks these rules.

## Optional escrow and private confirmation cards (`024`)

Run [`202610200024_optional_escrow.sql`](migrations/queue/202610200024_optional_escrow.sql)
once **after `023`**, then deploy the matching website. First verify `023` with
controlled accounts. The assistant has tested disposable PostgreSQL only and has
not applied either script to hosted Supabase. Move a successfully applied queued
script yourself. No bot code update or extra worker is needed for `024`.

- New listings default to escrow; sellers can choose Direct settlement before
  publishing. The database fixes mode, commission and deposit-start terms at
  creation. Existing listings/fees/obligations are not rewritten.
- Escrow keeps the item deposit, funded KMail bids and stored commission. Direct
  listings start immediately, use verified-account website bids/instant purchase,
  and create no bot transfer obligations or compulsory commission. Optional tips
  use the existing Donate page and do not gate any trading feature.
- Direct bids are promises to pay. The site does not verify possession, hold assets,
  enforce funding or guarantee completion. KMail LIST/BID/BUY for a direct listing
  is rejected and any attached assets are refunded under the existing mail rules.
- At server close, winner/price are frozen as `awaiting_trade` (shown as Awaiting
  settlement). Only seller and winner receive verified counterpart details/KMail
  links. Buyers remain anonymous publicly after completion too.
- `read_pending_trades(p_page)` is authenticated and participant-scoped, with 12
  entries per page. Home/browse reads close expired listings before loading these
  cards. Cards persist after one confirmation, showing Waiting for the other
  party; both confirmations are required for completion and card removal.
- Repeated confirmation preserves the first timestamp. Silence never becomes a
  completion or negative rating. There is no settlement deadline/automatic penalty,
  negative report, dispute workflow or reputation scoring yet; see ROADMAP section 11.
- Seller statistics separate bot-verified escrow from participant-confirmed direct
  sales. Existing compatibility keys `legacy_sales`/`legacy_value` include all
  completed direct trades, old and new; they are labelled as direct sales in the UI.

Controlled rollout check: create one listing in each mode; use a second verified
account for direct bids/instant purchase; confirm only one side and check that the
sale remains pending; confirm the other side and check it completes. Use a third
account and a signed-out browser to verify identities stay hidden. Check pending
pagination, reloads and seller history; verify the escrow deposit/bid/delivery path
separately.

## Buyout form, rounding and price limits (`025`)

The listing form now reveals its buyout input only after **Set Buyout Price
(optional)**. Removing it clears the optional price. Quantity, minimum bid and
buyout text remain unchanged while typing; clicking/tabbing out rounds to a whole
unit and formats with commas. Shorthand is expanded before rounding, so `144.5`
becomes `145`, `10.3` becomes `10`, and `99.7m` becomes `99,700,000`.

The old 10-billion minimum-bid and 20-billion price/bid limits also existed in SQL
and bot parsing. To remove those limits consistently, stop the existing local
worker, apply [`025`](migrations/queue/202610200025_auction_price_limits.sql) once
after `024`, move the successfully applied script yourself, and restart the local
worker with the matching code. Deploy/refresh the matching website. No second bot
instance is required. The assistant has not applied this to hosted Supabase.

`025` changes validation and calculation functions, without rewriting existing
amounts, fees, receipts, deliveries, uncertain-operation evidence or frozen messages.
It preserves the minimum-bid/buyout relationship, positive whole-unit amounts,
account checks and identity rules. KoL's per-mail transfer chunk sizes stay intact.
Commission multiplication uses exact PostgreSQL numeric arithmetic before rounding
down, avoiding overflow for large prices. The exact integer transport boundary
(`Number.MAX_SAFE_INTEGER`, 9,007,199,254,740,991) remains enforced throughout SQL,
website and bot so prices cannot silently change through JavaScript rounding.

## Private bug reports and administrator inbox (`026`)

Apply [`026`](migrations/queue/202610200026_bug_reports.sql) once after `025`, then
deploy/refresh the matching website. Move the successfully applied script yourself.
The assistant has not applied this to hosted Supabase. `026` needs no additional
worker or bot code update: existing message-format-v2 workers send its queued
zero-asset notices. If `025` is also pending, follow its stop/update/restart steps.

The homepage footer now reads **Donate • Report a Bug**. `/report-a-bug` accepts
10–2,000 characters from a signed-in, verified, unrestricted account. Reports are
private to administrators; reporters cannot browse reports through SQL/API reads.
A reporter who cannot log in is offered a direct KMail link to the owner instead.

`submit_bug_report` saves the full text and verified reporter identity and queues
its KMail copy to **teres Minor (#3552305)** in one transaction. The destination,
sender identity and zero-asset notice shape are server-controlled. User text is
escaped for KoL display and split into bounded messages without truncation. Each
part uses the existing durable delivery reference/claim/acknowledgment protocol.
Rollover/outages leave the report saved and the notification queued; an uncertain
send requires normal reconciliation and is never automatically resent. The UI
says queued, not sent. Retries retain a request UUID; the same request/body cannot
create another report or notification set. Submission is limited to one per minute
and five per hour per account.

Sign into the website account verified as **KoL player #3552305** to receive owner
administrator access automatically. The username alone is not authority. On the
report page, choose **Open administrator bug inbox**, or bookmark
`/admin/bug-reports`. The inbox has open/resolved/all filters, 20 reports per page,
KMail delivery status, reply links, and resolve/reopen actions. Status changes are
recorded in private `khub_bot.bug_report_activity`. Revoked/banned administrators
cannot make further reads or changes. Ordinary users are denied in the RPCs,
regardless of whether they know the inbox URL.

For another administrator, use SQL Editor with the intended account's UUID:

```sql
insert into khub_bot.administrators (user_id, note)
values ('REPLACE-WITH-ACCOUNT-UUID', 'Approved by owner for bug triage');
```

The account must also have a verified, unrestricted KoL identity. Revoke an extra
grant with `delete from khub_bot.administrators where user_id = 'ACCOUNT-UUID';`.
The owner grant is based on verified player #3552305; do not change linked identity
columns to assign administrators. Normal users cannot change grants or read the
private report/grant/activity tables. No service-role key is added to the website.

Controlled rollout: submit one harmless report, check it appears only in the owner's
inbox, and let the **existing local bot** deliver its KMail copy. Check that both
read access and resolve actions fail from a normal account, and that refresh/retry
does not duplicate the report or its notification. Do not use a second bot instance
for this test. Local regression checks use fixture reports and fake acknowledgments;
no real KMail has been sent by the assistant.

## Queue for future migrations

New website SQL scripts go in [`migrations/queue/`](migrations/queue/README.md).
Run each script manually in Supabase SQL Editor, then move it yourself into the
parent `migrations/` folder after it succeeds, keeping the same filename. Existing
scripts stay where they are. Matching copies inside `bot/supabase/migrations/`
continue to go directly in that folder, without a queue.

## Friendly bot messages and short auction commands (latest bot update)

With all bot processes stopped, back up the database and run
`migrations/202610190006_friendly_bot_messages.sql` once, then deploy the updated
bot before restarting. It adds short auction/delivery references and readable
KMail bodies without changing asset obligations, UUIDs, or delivery states.
Then apply `migrations/202610190007_short_auction_commands.sql` once. Deploy the
matching bot before the website update: website instructions use `BID 1001`,
`BUY 1001`, and `LIST 1001`, while existing UUID commands continue to work.
Older uncertain sends retain their original UUID markers. The migration requires
the updated worker; older workers cannot claim deliveries after this upgrade.
See the local [message previews](../bot/MESSAGES.md) for examples and rollout steps.

For donation thank-yous, apply `migrations/202610190008_donation_acknowledgments.sql`
once after `007`, with all bots stopped, then deploy the matching bot update.
Gift packages remain untouched; one acknowledgment is queued per package, with
receipt deduplication across polling and restarts.
Then apply `migrations/202610190009_normal_kmail_donations.sql` once for explicit
normal KMail donations: `DONATE` with assets receives a thank-you; without assets,
it receives instructions. Deploy the matching bot after applying pending migrations.

> **Bot reminder:** the auction bot is in this project's `bot/` folder and runs
> on Oracle Cloud. It is excluded from the website Git repository. See the
> [project README](../README.md) for its location and deployment links.
>
> **Bot controls:** [start/stop, LIVE/read-only, and switching between Oracle and
> your Mac](../bot/README.md#start-stop-and-switch-liveread-only-modes).
> These detailed instructions are in the local, gitignored `bot/` folder.

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
is shared reference data, not user-created listings. After migration 052 the bot
refreshes the validated KoLmafia catalog weekly and the website reads tradeable
items from the database; `src/data/items.json` is the bundled fallback. See
[catalog setup and automatic updates](ITEM_CATALOG.md).
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

After migration `069`, standard escrow listings use marginal 5/4/3/2/1% fee tiers, rounded down once, replacing the historical flat 7.5% default from `013`. The timer begins on exact item-deposit acceptance. Existing finalized payouts and free/sub-5% flat discounts stay intact.
`bot/README.md` documents tiered fees/deposit timing settings, startup, supported
KMail commands, and the operator reconciliation process. Hosted migration and
real KoL credentials/delivery have not been applied or tested by local changes.
# Auction page reads and refresh timing

After the KMail escrow migration, run the entire
`migrations/202610190005_auction_page_reads.sql` once in Supabase SQL Editor before
deploying the latest frontend. It adds a read-only function that respects existing
row-level security; it does not change auction records or bot processing.

The website now requests 24 filtered/sorted listings per browsing page, four
popular active listings for Home, one listing plus its bids for auction details,
and only the signed-in user's auction activity for their account. Browsing and
account refreshes run every 30 seconds; auction details every 10 seconds. Hidden
tabs pause auction polling and refresh on return. Countdown clocks run locally.

For the styled donation thank-you and error contact, stop the bot, apply
`migrations/202610190010_donation_message_style.sql` once after `009`,
then deploy the updated bot. The footer is saved with each newly claimed message;
previously claimed retries retain their original wording. No refund or auction rules change.

For the revised donation wording (without the decorative heading), apply
`migrations/202610190011_donation_message_wording.sql` once after `010`.
This is a database template change; the worker updated for `010` needs no rebuild.
Newly claimed donation messages use the new text; existing retries keep their saved text.

For mail retention and tracked manual-review notices, stop every bot, apply
`migrations/202610190012_bot_mail_review.sql` once after `011`,
then restart/deploy the matching worker. See `bot/OPERATIONS.md` for the outage and backup plan.

For the historical flat-fee and donation/commission closet setup (superseded by
069 for new fees), stop all workers, apply
`migrations/202610190013_closet_income.sql` after `012`, then restart/deploy
the updated worker. This affects future listing fees and newly recorded income;
existing fee terms and old donation receipts are preserved. Closet moves protect
auction/refund holds; the optional extra operating buffer defaults to 0. Inspect C-references
and reconcile uncertain closet moves using the operations guide.

For auction-number-first message headings, the revised outbid notice and the full
seller payment breakdown, apply `migrations/202610190014_auction_message_layout.sql` once
after `013`. This only changes database templates: an already updated `013` worker
needs no rebuild/restart. Previously claimed messages keep their saved wording.

Stop all workers, apply `migrations/202610190015_invalid_mail_refunds.sql`
after `014`, then restart/deploy the updated worker. Blank/invalid funded normal
mail is refunded, not donated. Old implicit donations are held for safe correction
refunds; uncertain C-references must be resolved from evidence first. Item closet
requests now use GET, with safe failure diagnostics. See the bot operations guide.

For an obsolete wrapper closet plan after the owner opened a gift package, apply
`migrations/202610190016_cancel_opened_package.sql` once after `015`. It adds a
service-only, audited cancellation command for never-attempted pending wrapper
plans; applying the migration cancels nothing by itself. See the bot README for
`cancel-opened-package` instructions.

For private donation/commission/trade reports, apply
`migrations/202610190017_financial_reports.sql` (normally after `016`). It also works
without `015` on an existing escrow/short-auction-number database and is safe to
rerun. It adds read-only,
service-only reporting functions; no existing receipts, balances, obligations or
auction state are changed. Use `npm run stats` from the updated bot folder.

Apply `migrations/202610190018_plain_auction_headings.sql` after `017` to remove
decorative dash underlines from all new auction messages. It is safe to rerun and
requires no bot restart. Saved bodies for sent/previously claimed messages are unchanged.

### Account creation order correction (`021`)

After `019`, apply queued `202610190021_auth_creation_order.sql` with all workers
stopped. `020` is independent. This fixes the original profile trigger expecting
Admin API app metadata before Supabase has attached it. The corrected trigger
requires the exact private reservation ID/internal address at insertion, while
account finalization still checks the server request stamp before sending login
credentials. Restart the updated bot; an existing pending REGISTER resumes without
another KMail or database reset. No website redeploy is needed for this correction.


### Short temporary passwords (`022`)

Apply queued `202610190022_short_temporary_passwords.sql` after `021` with all bots
stopped, then restart the updated worker. New generated passwords are 16 characters
so KMail does not split long tokens. The migration lowers only the generated-secret
minimum from 24 to 16; existing accounts, pending jobs and messages remain intact.
For fresh credentials, send CREDENTIALS after restart (subject to the five-minute
cooldown). No website redeploy is needed.

## Minimum bid increases (071)

Apply `202610220071_hybrid_bid_increments.sql` after 070 and deploy the matching
website. Both Direct bids and funded Escrow KMail use the current highest bid's
bracket, never the proposed bid's bracket:

| Current bid | Increase | Round increase up to |
| --- | --- | --- |
| Below 1k | 10 Meat | — |
| 1k–under 10k | 100 Meat | — |
| 10k–under 100k | 1k | — |
| 100k–under 1M | 10k | — |
| 1M–under 10M | 3% | 10k |
| 10M–under 100M | 2% | 100k |
| 100M–under 10B | 1% | 500k |
| 10B+ | 0.5% | 500k |

Round only the percentage increase, then add it to the current bid. For example,
1.75M needs a 60k increase, making the next minimum 1.81M. Frontend BigInt and
exact database integer division avoid floating-point errors. The first bid meets
the seller minimum; bids exactly at the calculated minimum are accepted.

Exact buyouts remain valid below the next ordinary bid. A larger bid reaching the
buyout closes at the saved buyout price, with excess funded Meat refunded.
Low/stale funded bids receive their full refund and a reply naming the exact next
minimum. Existing bids, prices, deadlines and frozen delivery messages are kept.

The existing bot uses database RPCs, so these rules require no bot rebuild or
restart. Its matching SQL copy is included for future installations. Run
`python3 tests/hybrid_bid_increments_database_test.py` for isolated checks of
brackets, rounding, large bids, exact acceptance, both bid paths and buyouts.


## Incomplete-profile grace period (055)

Apply `migrations/queue/202610210055_incomplete_trade_grace_period.sql` after 054.
Profile incomplete counts and their associated Meat totals exclude reports until
48 hours after the auction actually closed. Early buyouts use their finalization
time; ordinary auctions use their deadline even if background finalization was
late. Counts are computed on read, without a timer, bot restart or scheduled job.

Reports may still be filed and reviewed immediately and remain visible in the
auction's trade status and support inbox. Passing 48 hours does not create a report
or a bad mark automatically. Withdrawn/admin-dismissed reports stay excluded;
restoring an early report cannot bypass the grace period. Separate thumbs feedback
and completed-trade counts are unaffected. Existing historical records are not
rewritten. Deploy the website to show the matching profile-help explanation.


## General support tickets (056)

Apply `migrations/queue/202610210056_general_support_tickets.sql` after 055, then
deploy the website. The Info page's Contact Us link opens `/support`, a general
support version of the existing Report a Bug form. Its dedicated authenticated
RPC assigns `other` server-side, so tickets appear in the Other admin inbox folder.

Tickets require a verified, unrestricted account and use the existing 10–2,000
character limits, shared reporting rate limits, administrator-only inbox access,
and escaped KMail notices to teres Minor (#3552305). Stable retry keys prevent
additional records/notices; a category change by an administrator is preserved on
retry. Private source records distinguish support tickets from bug/trade reports.
No existing messages are recategorized. The existing bot processes these notice
deliveries; no bot code update is required.

## Account-failure notifications (059)

Apply `migrations/queue/202610210059_account_failure_notices.sql` after 058, then
deploy the updated standalone bot. Failed saved registration/recovery requests
stay pending for automatic retry and queue at most one friendly player KMail,
one private Other inbox system report, and one KMail to teres Minor (#3552305).
No website update is required. The player is not told to resubmit while an existing
request is pending. Alert failures are retried without blocking unrelated safe
payouts. Completed/rejected/restricted requests do not get misleading failure mail.

System reports have an explicit source flag and no human reporter UUID, allowing
notification before a registration creates a profile. Existing submission retry
checks become null-safe so players cannot claim a system report ID. The alert RPC
is service-only; recipients and safe message bodies come from the saved job, not
browser input. No passwords, login addresses or raw Auth errors are included.
Requests that cannot yet be saved, including database outages, retain their KMail
for retry; a notice cannot be queued until the database is available. Existing
financial and uncertain-delivery safeguards remain enforced.


### Bot message wording audit (060)

Apply `migrations/queue/202610210060_clear_bot_messages.sql` after 059, then deploy
website changes for the corrected escrow settlement panel. The SQL template update
requires no worker restart. It distinguishes split returns from complete refunds,
self-raised bids from another player outbidding you, and historical acceptance/response
notices from current auction state. It also updates buyout/restriction guidance and
account-page navigation. Existing saved messages, financial records, delivery states
and retry/reconciliation evidence are untouched. Full examples and event behavior:
[Bot messages](../bot/MESSAGES.md). Account-failure notices still require the current
059 worker deployed to Oracle.


### Escrow auction-linked administrator queries (061)

Apply `migrations/queue/202610210061_escrow_trade_queries.sql` after 060 and deploy
the website. Escrow listings now link to the existing Trade query form for their
seller at every stage and for finalized winning buyers. Guests, restricted accounts,
leading bidders and unrelated players cannot submit. Queries use the existing
private Trade inbox, grouped auction context, cooldowns and stable retry IDs. KMail
notices identify the method/item/quantity and final price when available. Submission
does not alter payment, delivery, confirmation or feedback state. No bot restart is
required; the matching standalone migration and message documentation are bundled.


### Administrator auction identities (062)

Apply `migrations/queue/202610210062_administrator_auction_identities.sql` after 061,
then refresh the website. Unrestricted, verified administrators see seller names,
all bidder names/account IDs, and winner identities through the existing auction
endpoints, including held/canceled listings and pending Escrow deposits. Their own
bids show their actual username rather than You. Pending Escrow listings are also
available on administrator detail and seller-history views.

Authorization uses the private server-side administrator checks (including explicit
operator grants), not user-editable metadata or a frontend role flag. Restricting an
administrator revokes this access. Ordinary users, guests and restricted viewers
keep their existing aliases and visibility rules. Trading contacts, private reports,
financial records and participant controls are not broadened. No bot restart or
frontend bundle change is required; refresh to fetch the newly authorized data.

## Tiered escrow commission (069)

Stop all workers, apply `migrations/queue/202610210069_tiered_escrow_fees.sql` after
068, then restart and deploy the updated website. The script moves to the parent
migration directory after manual application. Matching standalone copies live in
`bot/supabase/migrations/`.

The database is authoritative: 5% of the first 1m, 4% of the next 9m, 3% of the next
90m, 2% of the next 900m, and 1% above 1b; floor the aggregate fee once. Final
winning/buyout price minus the recorded fee is the seller payment. Excess buyout
Meat is refunded in full. Unsold, canceled and Direct listings have no fee.
`fee_policy` is fixed at publication; `fee_bps` describes legacy flat terms only.
The setting cannot disable or override new tiered listings. Open standard-rate
escrow listings adopt the lower fee; finalized rows/deliveries/frozen messages and
existing free/sub-5% flat discounts remain untouched. Only completed sales queue
the exact recorded fee for the bot's closet.

Run `python3 tests/tiered_fees_database_test.py` for isolated real settlement,
permission, migration-preservation, buyout/refund, split-payment and fee tests.


## Hot auction cards (072)

Apply `202610220072_hot_auction_cards.sql` after 071, then deploy the website.
The auction reader adds `is_hot` for the highest bid-count listings across the
entire live auction pool, before search, seller/My Auctions filters or pagination.
The number of slots is `ceil(active_count / 10)`. Zero-bid listings never qualify.
Equal bid counts prefer older creation times, then auction UUID, keeping the
selection deterministic. Only auctions still accepting bids qualify: expired,
held, concluded and restricted-seller listings are excluded. Ranking is recomputed
on reads and follows new bids and deadline transitions without a scheduled job.

The existing identity/privacy projection, bid rules, fees, stored history and
bot deliveries are unchanged. No bot rebuild or restart is needed. Test with
`python3 tests/hot_auctions_database_test.py` against an isolated local database.

## Compact auction browsing controls (073)

Apply `queue/202610220073_auction_browse_controls.sql` after 072, before deploying
this website update. The existing auction reader supports total-bid ascending /
descending and latest accepted bid sorting (unbid auctions last), plus an explicit
seven-argument overload for `p_trade` (`all`, `escrow`, `direct`, or `none`). Trade
filters, search, status and seller/My Auctions constraints apply before totals,
sorting and pagination. Both selected trade types use the existing six-argument
API; deselecting both returns no results. Existing callers, identity protections,
hot-auction flags and auction/financial data are preserved.

No bot rebuild or restart is needed. `python3 tests/hot_auctions_database_test.py`
checks the combined controls across multiple pages in an isolated database.

## Unfunded escrow expiry (074)

Apply `queue/202610220074_unfunded_escrow_expiry.sql` after 073. Escrow drafts
without a deposit expire 24 hours after creation. Normal website finalization
and bot ticks delete them; ingestion also checks expiry before accepting any
new deposit. Acceptance uses processing time, not the KMail's sent timestamp.
Late attachments follow the existing validated, deduplicated return path.

Only `pending_escrow` listings without deposited items, current bid or bid records
qualify. Active/funded auctions and their timers are untouched. Foreign-key-linked
support, audit and financial history is retained: those drafts are cancelled
instead of deleted. The migration immediately cleans up existing expired drafts.
No commission or incomplete-trade mark is created. No bot rebuild/restart is needed.
Run `python3 tests/escrow_expiry_database_test.py` for isolated expiry, timely/late
deposits, exact boundary, replay, retained-history, unchanged-assets and permission
checks.

## Homepage polls and administration (075)

Apply `queue/202610220075_homepage_poll.sql` after 074, then deploy the website.
No bot rebuild or restart is needed. The initial question is live on the homepage
for unrestricted signed-in accounts. Each account gets one immutable vote **per
poll**, enforced by a primary key and authenticated database RPCs. Guests cannot
vote; restricted accounts are denied. Voting hides that question on later visits.

Open `/admin/polls` using **Manage polls** in the administrator inbox or the homepage
poll banner. Administrators can save/edit private drafts, publish one when ready,
conclude a live poll, or atomically conclude it and publish the next draft. Drafts
are not scheduled automatically; use Publish whenever the next poll should go live.
A concluded question cannot reopen or change. Closing freezes its Yes/No totals,
so historical results survive later account or vote cleanup. All polls remain in
the admin archive with totals and percentages. Refresh Results reloads live counts.

Results stay private until the administrator selects **Publish results on
homepage** for a concluded poll. Published summaries appear to signed-in users
alongside the next poll and remain visible after voting. **Hide homepage results**
removes that summary without deleting its archived results. Active counts, drafts,
voter identities and unpublished results are never exposed to ordinary users.

Run `python3 tests/polls_database_test.py` for lifecycle, one-vote/concurrent-vote,
closure race, archived snapshot, publication, privacy and permission checks in an
isolated PostgreSQL database. Frontend service/state tests are in
`tests/home-poll.test.mjs`.
