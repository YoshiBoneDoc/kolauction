# Item catalog and weekly updates

Apply `supabase/migrations/202610210052_live_tradeable_item_catalog.sql` after 051,
then deploy this updated bot and the matching website. The first live startup
imports `catalog/items.json` and its `items.meta.json` provenance into the database.
Until that first validated import, new listings are unavailable. Existing auctions,
bids, saved images and financial deliveries remain unchanged.

The live worker checks the persisted upstream fetch date and refreshes every seven
days from KoLmafia's public `items.txt`. An overdue catalog refreshes on startup.
Only access flag `t` qualifies an item for an auction; gift-only, quest-only and
other untradeable items remain in the private reference catalog but cannot be listed.

Refresh runs independently of financial/mail processing. A failed download or
invalid snapshot retains the previous catalog and retries after one hour. The
website reads the current tradeable catalog from the database with a five-minute
browser cache, so weekly updates do not require a website or bot redeploy. Read-only
bot mode does not mutate the catalog.

To force a current upstream refresh, use `npm run sync-catalog` or the Docker
command from DEPLOYMENT.md. This validates the full source before importing one
atomic snapshot; the obsolete name-only `bot_sync_catalog` RPC is intentionally
rejected. No new credentials or scheduler are required beyond the running live bot.

The original source is:
https://github.com/kolmafia/kolmafia/blob/main/src/main/resources/data/items.txt

Images stay on KoL's image server; the updater downloads item data rather than
thousands of sprites. Explicit `otherimages/...` paths are retained correctly.
Operators can inspect freshness with `select * from khub_bot.item_catalog_state;`.
The source parser, unique IDs, flags, image paths, counts and monotonic snapshot
timestamps are validated before applying an update.

If first import fails with database code `21000` (UPDATE requires a WHERE clause),
apply migration `202610210054_safe_catalog_import.sql` after 053, then run
`npm run sync-catalog` to retry immediately. The SQL repair works with an existing
updater deployment; updated logging additionally identifies the failed stage/code
without exposing raw request data. Seeing new items in the website dropdown can
come from its bundled fallback and does not prove the database has been imported.
Check `select public.bot_item_catalog_state();`: a null result means uninitialized.

In the website repository, `npm run update:items` regenerates its checked-in
fallback list and these bundled bot files when the local bot directory is present.
Routine live updates do not rewrite the archive or require that command.
