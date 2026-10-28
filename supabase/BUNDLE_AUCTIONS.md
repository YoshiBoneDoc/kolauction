# Bundle sell auctions — migration 128

Create Auction now includes **Sell Bundle** alongside Buy Items and Sell Items.
Choose 2–10 distinct catalog items, set each quantity, and review the complete
contents before publishing. One bid or buyout purchases the entire lot. Both
Escrow and Direct settlement reuse their existing rules. Buy orders remain
single-item orders.

## Deposits and delivery

Escrow sellers send the existing `LIST <auction number>` command with **every
component and its exact quantity in one KMail or one suitable gift package**.
No Meat or extra items may be included. Choose packaging capable of holding all
the item types when using gifts. Partial deposits are rejected and returned,
not accumulated. The auction opens only after the complete deposit is accepted.
Gift deposits still require the existing verified-opening and balance proofs.

Incoming and active bundle assets are included in escrow liabilities. Each
outgoing component uses the existing separately tracked item deliveries,
including quantity splitting, recipient/profile checks, wrapping safeguards,
Sent Mail recovery and manual review. Winners may receive multiple messages.
A send is never retried merely because another part of the bundle arrived.
The auction cannot complete while any required delivery remains unconfirmed.
Cancellation or expiration without bids returns every deposited component.

Fees apply to the whole sale price once, not separately to each item. Bid
minimums, refunds, buyouts, receipt ordering, anti-sniping, completed-scan grace,
and Direct trade confirmations retain their existing behavior.

## Presentation and storage

- A bundle is one sell lot (`auction_kind='sell'`, `quantity=1`) with an immutable
  `bundle_items` snapshot containing catalog IDs, names, image URLs and quantities.
- Cards use a compact bundle title and representative image; the detail page,
  preview and KMail instructions enumerate all contents. Direct bid/buyout
  confirmation dialogs include every component.
- Names/images and eligibility come from the server catalog, not client input.
- Search matches every component name. Public/private projections include the
  full contents; participant privacy continues through the existing projection.
- Market valuation sums the component quantities. The legacy single-item
  completion-price snapshot is unavailable for bundles rather than reporting a
  quote for only the first item. Item-unit statistics count actual components;
  auction counts count one lot.
- Existing single-item listings and Buy orders keep their current representation.

## Rollout

1. Apply migration 127 first if it has not already been applied.
2. Stop bot workers for the schema change, then run
   `migrations/queue/202610280128_bundle_sell_auctions.sql` in Supabase SQL Editor.
   Only move it out of the queue after successful application, following the
   owner's migration workflow. The identical standalone copy is packaged under
   `bot/supabase/migrations/`.
3. Deploy the matching website, then resume the worker. Do not create bundle
   listings through a stale frontend. The existing worker's one-item delivery
   transport needs no new protocol: the database queues each component normally.
   A fresh bot archive includes the matching SQL and operational documentation.

No live migrations, accounts, transactions or deployments were touched during
implementation. QUICKSTART_README.md and LUNA_CHANGES.md remain unchanged.

## Verification

`python3 tests/bundle_auctions_database_test.py` builds disposable PostgreSQL with
all migrations from both the applied and queued directories. It checks invalid
inputs and permissions, exact/refunded deposits, immutable contents, liabilities,
search/projections/homepage, aggregate market values, outbid refunds, buyout
payout/fee/excess, receipt replay, uncertain component recovery, cancellation,
unsold returns, timed settlement, Direct trades, and verified incoming gifts.

The existing finalization regression (including the 200M sale), resilience suite
and incoming-gift suite also passed locally. The frontend build and focused
auction tests passed. The full frontend suite retains seven failures reproduced
on the unchanged HEAD snapshot (profile rendering/filter expectations and market
wording); these are unrelated to the bundle implementation.
