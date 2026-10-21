# Item catalog and weekly updates

The maintained source is [KoLmafia's items.txt](https://github.com/kolmafia/kolmafia/blob/main/src/main/resources/data/items.txt). Its access column uses `t` for tradeable items; `g` alone means giftable, not tradeable. Only items with `t` may be listed on kHub, for either Direct or Escrow auctions. Names are preserved exactly as supplied; IDs identify items independently of their names.

## One-time rollout

1. Apply migrations through **051**, then `migrations/queue/202610210052_live_tradeable_item_catalog.sql` in Supabase SQL Editor. Move the queued file only after successful application.
2. Deploy the updated standalone bot to Oracle using the existing packaging/deployment procedure. The bot is gitignored; pushing website changes does not update it. Run only one KoL worker.
3. Deploy the updated website. The live bot's first startup imports its validated bundled catalog automatically. New listings are unavailable until this first import completes. Existing auctions, bids, frozen item names/images and financial deliveries remain unchanged.

The matching bot migration is under `bot/supabase/migrations/`. There is no need to schedule GitHub Actions, configure another server, or supply additional credentials for item updates.

## Automatic operation

The live bot checks the catalog's persisted fetch date and refreshes it every seven days. A restart honors that stored date rather than restarting the interval. If overdue when the bot starts, it refreshes then. Read-only bot mode does not mutate the catalog.

The bot downloads only the item data file, not thousands of image files. It validates the format, item counts, unique IDs, flags and safe image paths before replacing the database snapshot in one transaction. A failed download, invalid snapshot or substantial unexpected count reduction retains the previous catalog and retries after one hour. This background work does not block mail, refunds or settlement.

The Create Auction page loads the database's current tradeable list and shares a five-minute browser cache across page visits. New items and images therefore appear without rebuilding the website. If the read fails, it uses the checked-in tradeable snapshot; the database still rejects an item that is no longer eligible.

Image filenames resolve against `https://images.kingdomofloathing.com/itemimages/`. Explicit paths such as `otherimages/folders/folder01.gif` resolve from the image server root. The database chooses the image from the validated catalog rather than trusting a URL submitted by a browser.

## Reference files and manual refresh

- `src/data/items.json`: tradeable items only, used as the website fallback.
- `src/data/items.meta.json`: upstream URL, fetch time, SHA-256 and counts.
- `bot/catalog/items.json`: all known items with explicit tradeability flags.
- `bot/catalog/items.meta.json`: matching bundled provenance.
- `khub_bot.catalog` and `khub_bot.item_catalog_state`: private authoritative database data and refresh metadata. The public read RPC exposes only tradeable reference data.

To regenerate checked-in fallback files, run `npm run update:items` from the website project. When the local bot directory exists, this also updates its bundled files and copies the shared parser into the standalone bot. It does not write to Supabase or publish the website.

For an immediate database refresh, run `npm run sync-catalog` from the deployed bot, or the documented Docker equivalent. This now downloads and validates the latest source instead of uploading stale name-only batches. The old `bot_sync_catalog` RPC rejects legacy imports; use the updated bot command.

Review the public catalog with `select public.read_item_catalog();`. Operators can inspect freshness with `select * from khub_bot.item_catalog_state;`. These are reference-data updates; they never alter existing auction or delivery records.

## Publishing blocked after the initial rollout

If publishing says **“The item catalog is being updated”**, the first database import has not completed. Seeing newly released items in the selector is not proof of a database import: `npm run update:items` updates the website's bundled fallback and bot files, not Supabase.

On Supabase projects with safe-update protection, the original migration 052 importer fails with SQLSTATE `21000`, **“UPDATE requires a WHERE clause.”** The entire import rolls back, leaving no ready catalog. Apply **`migrations/queue/202610210054_safe_catalog_import.sql` after 053**; do not rerun or edit the already-applied 052. The repair adds an explicit filter to the eligibility reset and retains all validation, permissions and atomic replacement.

Then run `npm run sync-catalog` from `bot/` to retry immediately instead of waiting for the worker's one-hour retry. This command only updates item reference data; it does not start a KoL worker or send mail. Alternatively, restart the existing worker to retry its bundled import. The SQL repair works with the already-deployed catalog updater; a bot redeploy is needed only for the improved diagnostic logging included with this repair.

Verify the import without dumping the full item list:

```sql
select public.bot_item_catalog_state();
```

The result should contain fetch/sync timestamps and nonzero `known_items` / `tradeable_items`, rather than `NULL`. Reload Create Auction after the successful import. Existing auctions, bids, deliveries and balances are not modified by the repair or catalog refresh.
