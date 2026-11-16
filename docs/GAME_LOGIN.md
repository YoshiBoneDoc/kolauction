# Game page and khub sign-in — local integration

Implemented locally in both repositories; no production deployment, secrets,
Firebase user migration, or account linking has been performed.

## How it works

`/khubMMO` (the “I'm Bored” link to the right of the navigation theme toggle) embeds the independently built MMO client. The existing `/game` route remains available as an alias. Everyone initially sees
“Login on khub first” and a single “Login” button. Clicking it asks the containing
khub page for a game login. The page obtains its current Supabase session and
calls `POST /api/game-login`. The Worker validates that bearer token with
Supabase Auth and reads `read_my_account_access` using the same user's token.
Missing profiles, failed access checks and banned accounts fail closed.

The Worker signs a five-minute Firebase custom token containing the canonical
`khub_username` and a stable `khub:<Supabase UUID>` Firebase UID. The browser signs
into the game's existing Firebase project with that token; SpacetimeDB still
verifies Firebase ID tokens and checks issuer, audience and bridge claims.
It creates/loads the corresponding character and registers the authoritative
website username. The website's browser metadata and iframe messages cannot
choose a username or identity. No Supabase token is sent into the game frame,
placed in URLs or stored by the bridge. All credential responses are `no-store`.

The full legacy Firebase login/register/recovery code remains available through
`showFirebaseAuthUI`; the public game gate does not expose that form. Previously
signed-in verified Firebase users can still enter the standalone client. In khub,
Login always requests a fresh website-backed game sign-in instead of reusing a
possibly unrelated cached Firebase account.

When website accounts change, the game iframe is remounted. Signing out from khub
removes its running game frame and websocket. The game's Log Out exits the game;
it does not sign out of the website. Existing Firebase sessions follow their
normal token lifecycle; this does not add server-wide instant ban/revocation of
already-issued Firebase credentials.

All clients must point to the same SpacetimeDB URI and database to share presence.
Every online character in that database appears in the existing world/minimap,
regardless of whether they entered through khub or standalone. Website visitors
who have not entered the game do not spawn characters.

## Configure before deployment

On the existing **kolauction Cloudflare Worker**, configure runtime settings:

- `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`: the website's existing public
  Supabase project settings. The endpoint also accepts the matching `VITE_`
  names as runtime fallbacks. Build variables are not automatically Worker variables.
- `GAME_FIREBASE_CLIENT_EMAIL`: a Firebase service account email belonging to
  `mmo7-5864a`.
- `GAME_FIREBASE_PRIVATE_KEY`: that account's PKCS#8 private key, stored as a
  Cloudflare **secret**, never a `VITE_` variable, source file or public asset.
  Literal newlines or escaped `\\n` are accepted. Configure it directly in the
  secret manager; do not send it in chat or commit a service-account JSON file.

The Supabase service-role key is neither needed nor used. No Supabase SQL
migration is required: this reuses the installed account-access RPC.

Website public build setting:

- `VITE_GAME_URL`: the deployed MMO client URL, e.g. `https://game.YOUR-SITE/`,
  or `/game-client/` if you separately publish the MMO assets at that prefix.
  The website build does not automatically build/copy the other repository.

MMO public build settings:

- `VITE_KHUB_ORIGIN`: the **exact** website origin, including scheme and any port.
  Required for a cross-origin iframe; same-origin defaults to the client's origin.
- `VITE_GAME_BASE`: `/` for a separate host, `/game-client/` for that subdirectory.
- `VITE_SPACETIMEDB_URI`: the publicly reachable secure `wss://` game server.
  The default `ws://127.0.0.1:3000` is only for local development.
- `VITE_SPACETIMEDB_DATABASE`: the shared game database name.

Publish the updated SpacetimeDB module, build/deploy the MMO client with those
settings, then deploy the website Worker and assets. Existing database data must
be preserved. Do not reset it. No generated client binding changes are needed.
The existing development-only item-grant setting in MMO is outside this login
change; review its existing production instructions before a public launch.

For local UI development run the two Vite servers on separate fixed ports, and
set `VITE_GAME_URL` and `VITE_KHUB_ORIGIN` to those exact origins. The website login
API requires the Worker runtime or a deployed endpoint; ordinary Vite does not
serve `/api/game-login` and does not load Worker signing secrets.

## Existing characters and name conflicts

A khub identity deliberately receives a distinct Firebase UID. It does not take
over a legacy Firebase character with the same username. If the normalized
website username already belongs to another game identity, game connection is
rejected with an account-linking message. Resolve ownership explicitly before
linking inventories, stats or characters; no data is silently merged or deleted.
Website names can contain spaces and are validated against the existing 16-character
profile limit. Legacy standalone username registration rules are unchanged.

## Validation

`node --test tests/game-login.test.mjs tests/auth.test.mjs tests/site-worker.test.mjs tests/navigation.test.mjs`
checks live-session/profile boundaries, bans, identity matching, canonical names,
RS256 signature verification, token lifetime, missing configuration, exact frame
and origin checks, session switching, in-flight deduplication and teardown. Backend
`khubAuth.test.ts` covers accepted and rejected Firebase bridge claims. These use
local fixtures/generated test keys, not real account secrets. A live khub→Firebase→
SpacetimeDB smoke test still requires configured secrets and hosting.

The bridge follows [Firebase custom-token authentication](https://firebase.google.com/docs/auth/admin/create-custom-tokens)
and [browser custom sign-in](https://firebase.google.com/docs/auth/web/custom-auth).
