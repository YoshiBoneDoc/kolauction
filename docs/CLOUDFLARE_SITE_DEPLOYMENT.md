# kolauction website runtime and shared cache

The website is a Cloudflare Worker with static assets, not a Pages deployment.
The site adapter reuses the handlers in `functions/api/`; those files alone do not
make a static-only Worker serve API routes. Use the existing Worker names and
account; no new Pages project is needed.

## Runtime architecture

```
Browser → kolauction (Worker + Vite static assets)
          ├─ static files / React navigation → ASSETS
          └─ /api/* → existing API handlers
                       → PUBLIC_AUCTION_CACHE (external Durable Object namespace)
                       → khub-public-auction-cache / PublicAuctionCache
```

- Root `wrangler.jsonc` keeps the existing **kolauction** Worker name, adds
  `workers/site/index.js`, serves `build/` through `ASSETS`, and retains SPA navigation.
- Only `/api` and `/api/*` run the Worker first. Static content keeps asset-first serving.
- The adapter reuses the three existing handlers: `/api/public-auctions`,
  `/api/public-banner`, and `/api/public-auctions/invalidate`. Their privacy, methods,
  signed-invalidation checks and no-store headers are unchanged. Unknown API routes
  return JSON 404, never the SPA's HTML. No financial/account proxy routes are added.
- `PUBLIC_AUCTION_CACHE` is a **Durable Object namespace binding**, not a service binding.
  It names class `PublicAuctionCache` in script `khub-public-auction-cache`.
  The handlers need `idFromName()` and `get()`, which a service binding does not provide.
- The cache Worker retains ownership of its namespace and SQLite migrations. The website
  has no Durable Object migration and does not create a second cache class or storage.
- Direct Supabase financial/account requests and Oracle bot processing are unchanged.

## Build-time flag

Use `npm run build:cloudflare`. It defaults `VITE_SHARED_AUCTION_CACHE` to `true` in
Vite's build process. An explicit build environment value of `false` still allows a
rollback. Local `npm run dev` and the original `npm run build` keep their existing behavior.

This is a **build variable**, not a runtime secret or Worker binding. Adding it only
under runtime Variables & Secrets does not change an already-built JavaScript bundle.
The build log prints the chosen boolean. It also emits `build/khub-build.json`, containing
only `runtime` and `sharedAuctionCache`, so the deployed setting can be verified without
examining minified JavaScript or exposing any credentials.

## Production deployment procedure

1. Ensure the existing Supabase migrations required by the current code, including
   148 and 149, have been applied. This configuration correction adds no new SQL.
2. Keep `khub-public-auction-cache` deployed in the **same Cloudflare account** as
   `kolauction`. Its Supabase URL/publishable key and invalidation secret stay there.
   Runtime names are `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. The Worker also
   accepts `VITE_SUPABASE_PUBLISHABLE_KEY` as a compatibility alias when the website's
   public variable name was copied into its settings. Both names have the same public-key
   validation; the canonical name takes precedence when both are present.
3. In **Cloudflare → kolauction → Settings → Builds**, check the Git production
   branch (`main`) and use these settings:

   | Setting | Value |
   | --- | --- |
   | Root directory | Repository root |
   | Build command | `npm run build:cloudflare` |
   | Deploy command | `npx wrangler@4 deploy --config wrangler.jsonc --keep-vars` |
   | Build variable | `VITE_SHARED_AUCTION_CACHE=true` |

   Preserve the existing `VITE_SUPABASE_URL` and public Supabase key **build variables**.
   Confirm the website and cache Worker target the same intended Supabase project.
   Use a supported Node version, such as Node 24, in the build environment.
   Cloudflare Workers Builds currently does not honor Wrangler's custom-build command;
   set the dashboard Build command explicitly. Wrangler's root build command also makes
   local CLI builds/dry runs use the correct script.
4. When ready, commit/push the prepared changes. The existing Cloudflare Git integration
   will deploy `kolauction` with its runtime and declared binding. Do not create a new
   Pages project or rename either Worker. No manual Service binding is needed.
5. The existing GitHub workflow still deploys **only the cache Worker**. It now first
   checks website API routing and performs a compile-only website dry run. It does not
   deploy website assets or provide their production Supabase variables; Cloudflare's
   existing website Git integration remains responsible for that deployment. The two
   explicit Wrangler configuration paths keep the deployments separate.

No new `routes` or custom domains are declared by this change. Keep the existing
website's domain settings and check them after its deployment. Preview builds should
use cache/data bindings appropriate for their Supabase project.

## Verification after deployment

Visit `https://YOUR-SITE/khub-build.json` and expect:

```json
{"runtime":"cloudflare-workers","sharedAuctionCache":true}
```

Then check:

```bash
curl -i 'https://YOUR-SITE/api/public-auctions?view=home'
curl -i 'https://YOUR-SITE/api/public-auctions?view=home'
curl -i 'https://YOUR-SITE/api/public-banner'
```

Expect JSON and HTTP 200, with `Cache-Control: no-store`. Auction responses should
include `X-Khub-Cache: MISS`, `HIT`, or `STALE`; a first response may already be HIT.
`/api/does-not-exist` should return JSON 404. A GET to `/api/public-auctions/invalidate`
should return 405; the real invalidation endpoint remains signed POST-only.
Check Home, a refreshed `/profile`, a seller deep link, and static images/CSS/JS.
Verify accepted-bid invalidation using the existing diagnostics after deployment;
do not send a real bid merely to test this configuration.

If an API returns HTML, the site was deployed as assets-only again or the wrong
Wrangler configuration/build root was selected. If it returns JSON 503, the runtime
is active; inspect the cache binding, cache Worker variables and required SQL RPCs.

## References

API failures include a fixed diagnostic `code`, never raw database messages or keys:
`CACHE_CONFIG_URL` / `CACHE_CONFIG_KEY` indicate cache Worker runtime variables;
`CACHE_ORIGIN_AUTH` indicates rejected credentials; `CACHE_RPC_MISSING` indicates
a missing RPC or stale Supabase schema cache; `CACHE_ORIGIN_PERMISSION` indicates
database permissions; `CACHE_ORIGIN_TIMEOUT` indicates an origin timeout.
`CACHE_BINDING_MISSING` / `CACHE_BINDING_ERROR` indicate the website binding.
Worker observability records these categories without query text or credentials.
The existing 30-second failure cooldown remains in place, including after restart.

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [SPA routing and Worker-first API paths](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Durable Object bindings](https://developers.cloudflare.com/durable-objects/get-started/)
- [Workers Builds settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

## Enable accepted-bid notifications

After setting up the shared cache above:

1. Apply `supabase/migrations/202610280136_accepted_bid_cache_invalidation.sql` in
   Supabase SQL Editor. It installs `pgcrypto` if needed and creates the trigger, private
   configuration and freshness metadata. With no configured destination, it sends nothing.
2. Redeploy the updated cache Worker and website Worker. No bot update/restart is required:
   the existing database bid insert is the event source for both bidding paths.
3. Generate a signing key privately, for example in your own terminal:

   ```bash
   openssl rand -hex 32
   ```

   Add that value to the **cache Worker** as an encrypted secret named
   `PUBLIC_CACHE_INVALIDATION_SECRET`, then save/deploy. Do not put it in website frontend
   `VITE_` variables, Git, the bot environment, a browser request or a public RPC.
4. In Supabase SQL Editor, enable asynchronous HTTP and privately configure the matching
   key and your production website URL. Replace the placeholders before running:

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
   the updated website route was not deployed. A recorded enqueue error indicates `pg_net`
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


## Cache deployment credentials and rollback

The GitHub workflow requires account-scoped `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` repository secrets. Keep Supabase public origin credentials
and `PUBLIC_CACHE_INVALIDATION_SECRET` in the cache Worker's runtime settings;
never use a service-role key there. `--keep-vars` preserves runtime variables.

To disable frontend shared reads, set build variable `VITE_SHARED_AUCTION_CACHE=false`
and rebuild/redeploy the website. Installed RPCs/ledger data remain; do not delete
financial state as a cache rollback. Disabling notifications alone is described above.
