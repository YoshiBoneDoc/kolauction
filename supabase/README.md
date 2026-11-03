# kHub database

Supabase PostgreSQL/Auth is authoritative for access control, auction state and
financial accounting. Start with [architecture](../README.md) and [handoff](../HANDOFF.md).
Standalone bot copies under `bot/supabase/migrations/` are alternative copies, not
another migration set to execute.

## Schema and responsibilities

`public` exposes profiles, auctions, bids and authorized RPCs. The private
`khub_bot` schema holds accounting, receipts, delivery/closet queues, gift proof,
account jobs, moderation evidence, cache metadata and maintenance state. Follow
actual migrations for table/function definitions; never grant broad private access
just to make a website request work.

- Browsing is read-only: it does not finalize auctions or acquire the global
  financial lock. Bot tick handles expiry; transaction RPCs independently validate
  deadlines and permissions under the required locks.
- Deposits, bids, refunds, payouts, fulfillment claims and acknowledgments are
  durable/idempotent. Unknown sends stay reserved and isolated pending evidence.
- Direct completion requires both sides' receipt confirmation; a support-ticket
  resolution, rating withdrawal or ban lift is not settlement.
- Price/discovery/totals caches are advisory snapshots with independent nonblocking
  maintenance. They cannot authorize funds, winners or deliveries.

## Migration procedure

Read [migration instructions](migrations/AGENTS.md) and [queue procedure](migrations/queue/README.md).
New website scripts go in `migrations/queue/`. The owner applies each script manually
and moves it to `migrations/` only after success. Do not move files on the owner's behalf.
The current queue has no SQL. Parent-directory presence is not independent proof of
production schema, and local test databases are not production.

Files extend through 169. Numeric prefixes are not unique: 150, 151, 160 and 167
have multiple filenames. Resolve full names and prerequisite comments; do not rename
existing migrations or guess a fresh-install order from numbers alone. Apply
prerequisites before dependent website/cache/bot versions. Never rerun the entire
migration history on an existing production database. Inspect scripts for explicit
worker-stop, locking, data-mutation and extension requirements.

## Current RPC paths

| Purpose | Representative RPCs |
| --- | --- |
| Public shared listings | `read_public_home_auctions`, `read_public_auction_page` |
| Personalized/direct reads | `read_home_auctions`, `read_filtered_auction_page`, `read_auction_page` |
| Private overlay | `read_auction_card_context`, `read_seller_auction_context`, `read_auction_detail_context` |
| Public live detail | `read_public_auction_detail_state` |
| Account access | `read_my_account_access`, `khub_is_administrator` |
| Operations | `bot_tick`, `bot_worker_status`, `bot_inspect` |

Public origin reads use anonymous/publishable credentials and explicit projection
allowlists. Names, contacts, bids, reservations, balances and admin evidence are
permission-dependent private data. Ignore filtering must precede totals/pagination;
never filter a cached page client-side and present its old total as personalized.
Accepted bids increment a revision and can send a signed after-commit invalidation
via `pg_net`; [deployment setup](../docs/CLOUDFLARE_SITE_DEPLOYMENT.md) preserves exact configuration.

## Accounts, moderation and privacy

New accounts use attachment-free KMail `REGISTER`; `CREDENTIALS`/`FORGOT LOGIN`
recover the linked identity. Auth Admin provisioning is server-only and idempotent;
public email signup is disabled. Legacy email recovery routes still exist and need
working Supabase email delivery/redirect configuration; new KMail accounts need no SMTP.
The website uses implicit Auth links and scopes cached data to authorization changes.

Ordinary names require an unrestricted signed-in viewer; live/losing bidders remain
anonymous to ordinary users. Administrators have separately checked access. Participant
contacts remain private. Never infer winner publication solely from an elapsed browser timer.

Application bans preserve appeal-only sign-in and block ordinary trading/reporting.
Use admin controls/effective access RPCs, not just legacy flags or native Auth fields.
Temporary bans expire automatically; lifting one does not resume held auctions.
Direct listings with bids enter reviewed holds; funded Escrow obligations retain their
settlement/refund protections. Admin decisions require reasons and retain audit evidence.

Appeals accept private text and optional validated PNG/JPEG/WebP evidence (up to
2 MiB); evidence is fetched separately for authorized review. Ban reasons are private.
The public Wall of Shame uses explicitly reviewed `khub_bot.ban_publications`, not
an automatic list of all bans. Publish only verified identity/public reason data;
never copy private evidence into public fields.

Direct feedback is distinct from ticket resolution: negative feedback counts unless
withdrawn/excluded through authorized review; withdrawal does not create positive
feedback. Recipient KMail, review audits and original evidence remain durable.

## Auctions, catalog and giveaways

Sell/Buy/Bundle support is implemented. Bundle component deposits must match the
entire lot; delivery/refund components remain separately tracked. Buy fulfillment
reservations, funding, expiry and per-seller earnings use server projections, not
client arithmetic for authorization.

Tiered Sell escrow commission uses 5%/4%/3%/2%/1% portions at 1M/10M/100M/1B boundaries,
rounding down once; finalized fees/deliveries stay frozen. Consult current transaction
functions for Buy accounting and special policies rather than applying that schedule
indiscriminately. Direct/canceled/unsold listings have no Sell commission.

KoLmafia `items.txt` is imported atomically by the live bot weekly, retaining the old
snapshot on validation/download failure. Tradeable or giftable items qualify; package
wrappers do not. Names/images are frozen on listings; submitted image URLs are not trusted.
Inspect catalog initialization/freshness using `bot_item_catalog_state()` and
`khub_bot.item_catalog_state`; a frontend fallback does not prove successful import.

Giveaways require exact next-minimum bids, reject self-outbids and never extend.
Random Draw/Split/Surprise Me require Escrow; Surprise resolves once on activation.
Distinct linked KoL player IDs participate once; stored draws/whole-item allocations
precede idempotent dispatch. Winner markers reflect actual prize recipients, not
necessarily the highest bidder. Launch/final-30-minute announcement claims are durable.

Public trade totals exclude deposits/refunds/donations/commission from trade value;
paid partial Buy fulfillments remain counted even if the order later closes.
Poll feeds and analytics remain authorized/private where they carry viewer/admin data.
Multi-select polls, skips/reopening, player ignores and activity/user analytics are implemented.

## Testing and diagnostics

Python suites under `tests/` build disposable PostgreSQL clusters and resolve migration
files from the queue or parent directory. Test fixtures are synthetic data,
not production migrations or real funded trades.

Inspect live sessions/locks and accumulated query statistics. Capture twice for interval deltas; do not reset evidence during
an incident. Database counters and query statistics have independent reset dates.
Pair query text/roles with historical resource/cache logs before changing indexes,
timeouts or compute. Never run financial-write EXPLAIN ANALYZE on production.
