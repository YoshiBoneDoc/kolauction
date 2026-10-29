# Shared public auction cache

The homepage, general public auction browsing, and eligible public seller listings can reuse snapshots across visitors.
Cloudflare Pages sends public GET requests to one named Durable Object. It serializes
database refreshes globally, so simultaneous visitors do not each run the same expensive
Supabase ranking/filtering query. Public listing GET requests forward no browser JWT
or cookie. The separate invalidation endpoint accepts only a small signed revision.

## What is cached

- Public item names, images, bundle components, quantities and auction numbers.
- Public advertised prices, current bid amounts and bid counts (not individual bid records).
- Public auction statuses, deadlines, fulfillment counts, search results and pagination.
- Homepage section membership and public price-range bounds.

The Worker always uses the Supabase **publishable/anonymous key**, never a service-role key.
It copies an explicit field allowlist into the cache. New database fields are excluded by
default. Even anonymous RPC responses are not stored wholesale.

Account credentials, account identities/names, personal reservations, balances, escrow
accounting, delivery records, individual bids, contacts, feedback/report details and admin
data are excluded. Signed-in browse cards get their authorized context separately through
`read_auction_card_context`, using the browser's existing Supabase session. That response
remains private and in memory. Existing database projection rules control its contents.

The homepage cards need no personal context, so that listing read makes **zero Supabase
requests per visitor on a cache hit**, whether signed in or out. Other homepage features,
such as pending trades, authentication and polls, keep their existing separate reads.

Public announcements also use the shared infrastructure via `/api/public-banner`, in a
separate named object. Only their message and dismissal revision are cached. Profile and
poll-feed reads remain private; see [Batch 1](TRAFFIC_BATCH1.md) for their reduced polling.

Private Account Profile, Seller Profile statistics, auction details, My Auctions, Others, and all
transaction actions remain direct. Eligible public seller auction lists use shared rows
and a separate `read_seller_auction_context` response for statistics and private context.
The public seller-profile UUID appears only as a routing key, matching its public URL. Signed-in **All auctions** remains direct because its
results can include unpublished drafts. Anonymous All auctions can use the public cache. The same draft-preservation rule
applies to signed-in All-status seller listings.
Explicit refreshes after writes bypass shared snapshots so an older public result cannot
overwrite the initiating user's newly completed action.

## Freshness and overload behavior

- Fresh for 30 seconds; the existing browser polling cadence is about one minute.
- A snapshot up to five minutes old may be served while one background refresh runs.
  During normal polling a displayed listing can therefore lag the database by about a
  minute or more. Detail pages and transaction validation still use live database reads.
- A delayed-data notice appears if a snapshot is at least two minutes old or the shared
  cache knows the database is in cooldown. Beyond five minutes, new shared reads fail
  with a retry message rather than claiming old information is current. The existing
  per-viewer browser cache can retain previously loaded data with its refresh error.
- One database fetch at a time, at least one second between starts; at most four distinct
  keys waiting/running. Identical concurrent reads share the same promise.
- An eight-second fetch deadline and a persisted 30-second cooldown after an origin error.
  There is no automatic fallback that sends every visitor directly to Supabase.
- At most 48 listing snapshots / 1 MB persisted in Cloudflare. Migration 148 adds one
  small internal Supabase row for reusable price bounds and popularity IDs, refreshed
  at most once a minute, separately from financial state.
- Public auction clocks advance from the saved timestamp instead of freezing at cache time.
- HTTP responses use `Cache-Control: no-store`; the only shared snapshot is the controlled
  Durable Object store, not a blanket browser/CDN rule on authenticated requests.

## Accepted-bid invalidation

Migration 136 adds an `AFTER INSERT` trigger to the existing `public.bids` table. Website
Direct bids, bot-funded bids and buyouts that create accepted bid records use that same
table. Rejected bids and replays create no new bid row. The trigger never changes bids,
prices, escrow, payouts or refund logic.

Each accepted bid increments a private monotonic freshness revision. If configured, the
trigger queues a signed notification using Supabase `pg_net`. The network request starts
**only after the transaction commits**. Rolled-back bids also roll back their notification.
The body contains only a revision string and HMAC-SHA256 signature. No bid/auction IDs,
amounts, account data, credentials or signing key are sent. The private configuration
table and signing helper are unavailable to anonymous, authenticated and service API roles.

On receiving a valid newer revision, the Durable Object marks **all** existing snapshots
outdated. This includes filtered/sorted pages that might gain or lose the auction after a
bid changes its price, popularity, urgency or ranking. It does not eagerly refetch all pages.
The next request for each outdated page waits for one shared refresh; simultaneous callers
reuse that fetch. It never deliberately serves a known pre-bid snapshot. If the database
is unavailable, it returns a retry error. Normal stale-while-refresh behavior still applies
to snapshots that have not been invalidated.

An in-flight read records its starting revision. If a bid notification arrives before the
read finishes, the result is discarded and retried once under the global rate/concurrency
limits. Continuous changes return a retry response instead of spinning or republishing an
older generation. Duplicate/reordered notifications are harmless, and freshness metadata
survives an object restart.

This is asynchronous invalidation, not a push update to every open browser. There is a short
delivery window between database commit and notification receipt; during that window a
request can still receive the preceding snapshot. Already open pages update on their normal
poll or manual refresh. If notification delivery fails, the existing 30-second cache TTL
and subsequent refresh remain the fallback. Network failures never undo accepted bids or
restart the bot. This also does not invalidate changes that create no bid record, such as
new listings or Buy Order fulfillments; they retain the existing refresh behavior.

This reduces public browsing pressure. Private requests, actual transactions, bot queries,
polls, database capacity, abusive direct Supabase requests and unrelated inefficient queries
still need their existing limits and monitoring. It does not establish the cause of the
previous next-day database memory incident or guarantee that all overload is prevented.

## Activate in order

Nothing is enabled until the build flag below is set. No production deployment or SQL
application is performed by creating these files.

1. Apply `supabase/migrations/queue/202610280135_private_auction_card_context.sql` in Supabase
   SQL Editor. It adds a read-only authenticated RPC bounded to 24 public auctions.
   It does not change existing reads, transactions or bot processing.
2. Deploy the cache Worker from the project root, using the Cloudflare account hosting Pages:

   ```bash
   npx wrangler deploy --config workers/public-auction-cache/wrangler.jsonc --keep-vars
   ```

   The Worker is named `khub-public-auction-cache`; its Durable Object class is
   `PublicAuctionCache`. The configuration creates SQLite-backed storage and exposes no
   public Worker URL. If Wrangler is not installed, `npx` offers to download its CLI;
   it is not a new application dependency.
3. In that Worker's **Settings → Variables and Secrets**, add:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | The same project URL as the website's `VITE_SUPABASE_URL` |
   | `SUPABASE_PUBLISHABLE_KEY` | The same **publishable/anon** key as the website |

   Do not supply a secret or service-role key. Privileged JWT keys are rejected by code.
4. In the existing Cloudflare **Pages project → Settings → Bindings**, add a **Durable Object**
   binding named `PUBLIC_AUCTION_CACHE`, selecting Worker `khub-public-auction-cache` and
   class `PublicAuctionCache`. Set up production first; only enable preview builds if
   their binding points to the same intended database. Binding configuration changes
   require a new Pages deployment.
5. In Pages build environment variables, set `VITE_SHARED_AUCTION_CACHE=true` and rebuild
   the website. Keep the existing build command `npm run build` and output directory `build`.
   The root `functions/api/public-auctions.js` is a Pages Function. The generated site's
   `_routes.json` invokes Functions only at `/api/public-auctions` and its invalidation
   endpoint plus `/api/public-banner`, leaving static routes
   under the existing SPA/static hosting behavior. Deploy via the existing Git integration
   or Wrangler Pages, not dashboard drag-and-drop static asset upload.
6. Check the deployed endpoint twice:

   ```bash
   curl -sS -D - -o /dev/null 'https://YOUR-SITE/api/public-auctions?view=home'
   curl -sS -D - -o /dev/null 'https://YOUR-SITE/api/public-auctions?view=home'
   ```

   Expect HTTP 200, `Cache-Control: no-store`, and `X-Khub-Cache: MISS` then `HIT`
   (or `STALE` after 30 seconds). The endpoint must return JSON, not the SPA's HTML.
   Browse signed out and with two different accounts. Names/reservations must follow
   each viewer's permissions; they must not appear in the public endpoint JSON.
   Confirm detail pages, My Auctions and post-action refreshes still call Supabase directly.

`npm run dev` alone does not run Pages Functions or Durable Objects. Keep the flag false
for ordinary Vite development; test this integration through Cloudflare's preview tooling
or a configured Pages preview. Keep preview/live databases consistent.

## Enable accepted-bid notifications

After setting up the shared cache above:

1. Apply `supabase/migrations/queue/202610280136_accepted_bid_cache_invalidation.sql` in
   Supabase SQL Editor. It installs `pgcrypto` if needed and creates the trigger, private
   configuration and freshness metadata. With no configured destination, it sends nothing.
2. Redeploy the updated cache Worker and Pages Function. No bot update/restart is required:
   the existing database bid insert is the event source for both bidding paths.
3. Generate a signing key privately, for example in your own terminal:

   ```bash
   openssl rand -hex 32
   ```

   Add that value to the **cache Worker** as an encrypted secret named
   `PUBLIC_CACHE_INVALIDATION_SECRET`, then save/deploy. Do not put it in Pages frontend
   `VITE_` variables, Git, the bot environment, a browser request or a public RPC.
4. In Supabase SQL Editor, enable asynchronous HTTP and privately configure the matching
   key and your production Pages URL. Replace the placeholders before running:

   ```sql
   create extension if not exists pg_net with schema extensions;

   begin;
   insert into khub_bot.public_cache_webhook_config(id, endpoint, signing_secret)
   values (
       true,
       'https://YOUR-SITE/api/public-auctions/invalidate',
       'REPLACE_WITH_THE_SAME_64_CHARACTER_HEX_KEY'
   )
   on conflict(id) do update
   set endpoint = excluded.endpoint, signing_secret = excluded.signing_secret;

   -- Flush any pre-configuration snapshots and test delivery after commit.
   update khub_bot.public_cache_revision set revision = revision + 1 where id;
   select khub_bot.send_public_cache_invalidation();
   commit;
   ```

   Keep the signing key private, including saved/shared SQL snippets. The HTTPS destination
   must end exactly in `/api/public-auctions/invalidate`. Do not create a generic Supabase
   row webhook that forwards the entire bid row or an Authorization header.
5. Inspect the enqueue status without displaying the key:

   ```sql
   select revision, last_queued_revision, last_request_id, enqueue_failures, last_error_code
   from khub_bot.public_cache_revision;

   select r.id, r.status_code, r.timed_out, r.error_msg
   from net._http_response r
   where r.id = (select last_request_id from khub_bot.public_cache_revision);
   ```

   The second result can be empty until the asynchronous request finishes. Expect HTTP
   200. A 403 indicates a mismatched/missing Worker signing key; a 404 generally indicates
   the updated Pages route was not deployed. A recorded enqueue error indicates `pg_net`
   or its configuration needs attention. No API role can invoke the signing helper.
   After correcting configuration, safely resend the latest revision:

   ```sql
   select khub_bot.send_public_cache_invalidation();
   ```

   Request a warmed public endpoint after notification delivery. Expect
   `X-Khub-Cache: REVALIDATED`, then `HIT` on subsequent requests. Verify the next genuine
   accepted bid increments the revision and sends another successful notification.

To disable only notifications, delete the private configuration row in SQL Editor:
`delete from khub_bot.public_cache_webhook_config where id;`. Normal TTL caching and
all auction processing continue. Do not remove bid, escrow or delivery records.

## Roll back

Set `VITE_SHARED_AUCTION_CACHE=false` and rebuild Pages. This returns the frontend to its
existing direct reads. The added read-only RPC may remain installed. Do not remove any
auction, ledger, gift, escrow or bot data. No bot rebuild/restart is needed for this feature.

## Verification

`node --test tests/shared-auction-cache.test.mjs tests/auction-read-cache.test.mjs tests/auction-refresh.test.mjs`
checks burst coalescing, bounded storage/queues, stale/error recovery, restart persistence,
clock behavior, strict public fields, stripped credentials, two-viewer privacy, and direct
post-action reads. `python3 tests/bundle_auctions_database_test.py` applies local migrations
in a disposable PostgreSQL cluster and exercises actual private-context permission rules
alongside escrow and fulfillment regressions. Neither command uses production services.

Cloudflare references: [Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/),
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[SQLite-backed storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
Supabase reference: [asynchronous after-commit HTTP](https://supabase.com/docs/guides/database/extensions/pg_net).


## Read efficiency update (148–149)

Deploy migrations 148–149 before the updated Worker/website. Public origin reads use
`read_public_auction_page` and `read_public_home_auctions`, which reuse global discovery
aggregates. Seller statistics remain direct and retain their existing calculations;
the statistics tab no longer fetches an unused auction page. For indexing, identity
polling, bot queue hints, deployment order, tests and the later query-statistics review,
see [Read efficiency](TRAFFIC_READ_EFFICIENCY.md).

## Automatic Worker deployment on Git pushes

The repository workflow `.github/workflows/deploy-cache-worker.yml` deploys
`khub-public-auction-cache` on every push to `main`, after credential scanning and
public-cache/privacy tests pass. It also supports **Actions → Deploy shared cache
Worker → Run workflow** on `main`.

One-time setup in **GitHub repository → Settings → Secrets and variables → Actions →
New repository secret**:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token authorized to deploy Workers in the
  account hosting `khub-public-auction-cache`. The Cloudflare **Edit Cloudflare Workers**
  token template can be used, scoped to that account. Do not use the Global API Key.
- `CLOUDFLARE_ACCOUNT_ID`: the ID of that same Cloudflare account.

Keep the Worker's existing Supabase publishable key/URL and invalidation secret in
Cloudflare. The deployment uses `--keep-vars` to preserve dashboard-managed variables;
Worker secrets are preserved as well. No Supabase service-role key or bot credentials
are needed in GitHub. Missing deployment secrets produce an explicit failed workflow.

Push this workflow to GitHub after the secrets are configured. The website's existing
Cloudflare Pages Git deployment continues independently; the workflow deploys only the
cache Worker. Apply required SQL migrations before pushing code that depends on them.
The workflow does not apply database migrations, modify Pages bindings, deploy the bot,
or create the initial Supabase/cache settings. Avoid enabling a second automatic Worker
deployment through Workers Builds for this same branch while this workflow is active.
Concurrent deployments are serialized so an older running deployment finishes before
the latest queued push starts. Check the GitHub **Actions** tab for success or failures.

References: [Cloudflare GitHub Actions deployment](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/),
[Wrangler GitHub Action](https://github.com/cloudflare/wrangler-action).
