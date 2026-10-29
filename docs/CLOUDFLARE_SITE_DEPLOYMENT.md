# kolauction website runtime and shared cache

## Findings

The supplied Cloudflare screenshot identifies **kolauction** as a **Worker** and
explicitly reports that it contains only static assets. It is not a Pages project.
The repository previously had no root Wrangler configuration or website Worker entry
point. `functions/api/...` and `public/_routes.json` are Pages conventions; uploading
Vite assets to a static-only Worker does not turn those files into API handlers.
This explains why the dashboard would not accept runtime bindings.

The screenshot establishes the displayed deployment type. No authenticated Cloudflare
account access or live website URL was available, so remote build settings and actual
live HTTP responses were not independently inspected. No deployment was performed.
The local `.env` and `.env.local` did not set `VITE_SHARED_AUCTION_CACHE`; a plain Vite
build therefore has no local configuration enabling this feature. Cloudflare's remote
build variables cannot be inferred from those files.

## Prepared architecture

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

## What to do afterward — not executed by Codex

1. Ensure the existing Supabase migrations required by the current code, including
   148 and 149, have been applied. This configuration correction adds no new SQL.
2. Keep `khub-public-auction-cache` deployed in the **same Cloudflare account** as
   `kolauction`. Its Supabase URL/publishable key and invalidation secret stay there.
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

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [SPA routing and Worker-first API paths](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Durable Object bindings](https://developers.cloudflare.com/durable-objects/get-started/)
- [Workers Builds settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
