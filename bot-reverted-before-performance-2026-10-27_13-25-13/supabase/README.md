## Authenticated name visibility (`035`)

Apply `migrations/202610200035_authenticated_name_visibility.sql` after `034`
and deploy the website. This supersedes the earlier public-name rules below.
Signed-out viewers and accounts restricted by profile, identity or Supabase Auth
ban receive generic seller/winner/profile labels from the database. Browsing,
prices, outcomes and aggregate statistics remain available. The frontend also
masks names on logout and separates cached data by the actual authenticated user.
Seller profiles keep generic navigation links for visitors.

Signed-in, unrestricted accounts can see seller names and server-finalized winner
names. Private trading contacts remain limited to the actual seller/winner, and
are withheld from restricted accounts. Live/losing bid identities remain anonymous.
The gallery similarly hides player names/numbers and identifying reason text from
outsiders. Private administrator access also checks Auth-level bans. No stored
profile name, auction result, report or KMail is changed by this migration.

## Self-resolution and trade queries (`034`)

Apply `migrations/202610200034_trade_resolution.sql` after the already-applied
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

Apply `migrations/202610200033_rating_notifications.sql` after `032`, then
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

Apply `migrations/202610200032_direct_feedback_and_public_winners.sql` after
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

Apply `migrations/202610200031_trade_reports.sql` after `030`, then deploy
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

Apply `migrations/202610200030_unconfirmed_trade_reminders.sql` after `029`
and deploy the website. A pending trade appears on home/browse only for a seller
or winning buyer who has not confirmed yet. The server filters before counting
and pagination. Confirming does not complete the sale until both parties confirm;
the auction details/history still show the waiting status and private instructions.
No stored confirmations, obligations or deliveries are rewritten; no bot restart
or additional worker is needed.

## Ban appeals (`029`)

Apply `migrations/202610200029_ban_appeals.sql` after `028` and deploy the
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

Apply `migrations/202610200028_shared_administrator_inbox.sql` after `027`,
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

Migration `202610200026_bug_reports.sql` matches the website queue. Apply it once
after `025`, then deploy/refresh the website. It stores private bug reports and
queues full text to teres Minor (#3552305) as bounded, escaped, zero-asset notices
with prefilled version-2 bodies. The current worker needs no code change or second
instance. Existing uncertain-send/reconciliation safeguards apply. No existing
auction, receipt, delivery or frozen message is rewritten. Administrator access is
based on verified owner identity or explicit private grants; see the website's
Supabase README for setup and the private inbox.

Migration `202610200025_auction_price_limits.sql` matches the website queue.
Stop the existing worker, apply it once after `024`, then restart the matching bot
and deploy/refresh the website. It removes fixed 10/20-billion auction price limits,
retains exact integer transport and per-mail chunk sizes, and prevents overflow in
commission multiplication. No stored amounts, receipts, delivery states, claimed
message bodies or uncertain-transfer evidence are rewritten. Protocol/review parsing
now accepts the same exact whole-Meat range as SQL and the website.

Migration `202610200024_optional_escrow.sql` matches the website queue. Apply it
once after `023`, through the website's manual rollout. Existing escrow listings,
fees and delivery obligations are preserved; direct listings never enter the bot's
settlement queue. The existing bot rejects/refunds mail targeting direct listings.
No worker restart or second instance is needed for this database/website change.

# Database setup copies

Migration `202610200023_public_seller_profiles.sql` matches the website's queued
seller-profile/privacy migration. It restricts browser reads and adds explicit
public projections; service-role bot reads/writes and existing auction/delivery
records are unchanged. Apply it only once to the shared database, through the
website rollout workflow, and deploy the matching website. Do not rerun migrations
or restart the bot merely to install this read-permission change.

This folder contains copies of the website's database migrations as of October
19, 2026 so that the bot package can be tested and set up independently.
The website's original `supabase/migrations/` files remain in place. Keep these
copies aligned when a future database migration changes the bot's requirements.

Moving the bot to a server does **not** require recreating the database or
rerunning migrations. Connect to the same Supabase project with server-only
credentials. Existing auction and delivery records remain there.

For a completely new database, back it up as applicable and run each file once
in filename order through Supabase SQL Editor. The files set up profiles,
auctions/bids, lifecycle, registration checks, instant purchases, KMail escrow,
page reads, and friendly bot messages. The current bot needs migrations through
`015`; this includes short delivery references, the versioned delivery claim,
LIST/BID/BUY commands accepting short auction numbers alongside UUIDs, and
deduplicated gift donation acknowledgments that leave packages untouched, and
normal DONATE messages with a thank-you or instructions reply.

For an existing database, apply only migrations not already successfully applied.
Do not delete tables or rerun old create-table migrations to move the bot.

The optional isolated PostgreSQL checks use these copies:

```bash
python3 tests/database_test.py
```

Run from the bot folder with PostgreSQL binaries installed. This creates a
temporary local database; it does not connect to your hosted Supabase database.

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
then restart/deploy the matching worker. See `../OPERATIONS.md` for the outage and backup plan.

For the 7.5% fee and donation/commission closet queue, stop all workers, apply
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

After `015`, apply `migrations/202610190016_cancel_opened_package.sql` for the
service-only, audited `cancel-opened-package` command. The migration itself cancels
nothing. Only never-attempted pending gift-wrapper plans qualify; see ../README.md.

For private donation/commission/trade reports, apply
`migrations/202610190017_financial_reports.sql` (normally after `016`). It also works
without `015` on an existing escrow/short-auction-number database and is safe to
rerun. It adds read-only,
service-only reporting functions; no existing receipts, balances, obligations or
auction state are changed. Use `npm run stats` from the updated bot folder.

Apply `migrations/202610190018_plain_auction_headings.sql` after `017` to remove
decorative dash underlines from all new auction messages. It is safe to rerun and
requires no bot restart. Saved bodies for sent/previously claimed messages are unchanged.

## KMail accounts (019)

Stop all workers, apply `supabase/migrations/202610190019_kmail_accounts.sql`
after `018`, then deploy the matching bot and website. In the website repository,
new scripts start under `supabase/migrations/queue/`; move the script yourself after
applying it. The standalone bot copy goes directly in its migrations folder.

REGISTER uses the verified KMail sender’s KoL name; custom names are rejected. CREDENTIALS generates a fresh
password for the verified sender's linked account. New accounts require no email
or SMTP. Existing accounts/history are retained. See the bot README for operational
details and the website Supabase README for Auth settings and ban administration.


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
