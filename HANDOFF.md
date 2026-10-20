# kHub project handoff

Updated October 19, 2026. Read this before making changes in a new chat.
This is a development project, not a finished public launch. Separate what is
implemented locally from what the user has actually deployed/applied.

## Background and the three pieces

**kHub / KoL Auction Hub** is an auction website for Kingdom of Loathing (KoL),
inspired by the original kBay. Players trade items for the game's currency, Meat.
The middleman is the user's KoL bot account **kHub (#3888760)**. The owner's/main
support account is **teres minor (#3552305)**.

| Piece | Location | Runtime / hosting |
| --- | --- | --- |
| Website | `src/`, `public/`, root `package.json` | React 18, React Router, Vite; Cloudflare |
| Persistent accounts, auctions and bot ledger | `supabase/` | Supabase Auth + PostgreSQL |
| Middleman worker | **`bot/`** | Node **24+**; local Mac during testing, Docker on Oracle Ubuntu for hosting |

Project directory: `/Users/adityayadav/Desktop/IntelliJ Projects/kolauction`.
The website is not Next.js. Use `VITE_` browser variables, not `NEXT_PUBLIC_`.
The website's Cloudflare deployment **does not run the bot**. SQL functions implement
most auction/ledger transactions; the worker coordinates KoL and Supabase.

**The entire `bot/` folder is deliberately ignored by the website Git repository.**
A fresh website clone does not contain it. Do not force-add it, credentials or SSH
keys to Git. Local bot edits do not update Oracle. Build/upload the separate bundle
and rebuild the Oracle container; website Git pushes only update the website when
Cloudflare Git deployment is configured.

## Read these documents rather than guessing

- [Root README](README.md): project locations, bot reminder, deployment separation.
- [ROADMAP](ROADMAP.md): **remaining work only**. Some rollout items can lag behind
  manual application; confirm status rather than assuming every listed task is undone.
- [Supabase README](supabase/README.md): database setup, RPCs, migration rollout,
  accounts and historical implementation notes. Later corrections supersede earlier text.
- [Migration instructions](supabase/migrations/AGENTS.md) and
  [queue README](supabase/migrations/queue/README.md): mandatory migration workflow.
- [Bot README](bot/README.md): local/Oracle start-stop commands, live/read-only,
  commands, request lookup, reconciliation, statistics and troubleshooting.
- [Bot deployment guide](bot/DEPLOYMENT.md): packaging, Oracle Docker setup,
  transferring updates and restarting the hosted copy.
- [Bot operations guide](bot/OPERATIONS.md): outages, uncertain sends, asset
  checks, rollover, donation/closet behavior, recovery and backups.
- [Bot message previews](bot/MESSAGES.md): outgoing KMail examples and reference IDs.
  Some historical examples predate newer password/template changes; check current code.
- [Standalone bot database README](bot/supabase/README.md): migration copies for deployment.
- [Wall of Shame operations](supabase/WALL_OF_SHAME.md): reviewed publication,
  correction/removal and public-versus-private ban information.
- [Artwork notes](public/art/README.md): generated portrait/frame assets and prompts.
- [Email setup notes](supabase/EMAIL_SETUP.md): **mostly historical**. New signup
  and recovery use KMail, not SMTP. Do not bring back email registration accidentally.

## Current registration and login

New users send normal KMail with **no Meat/items** to kHub:

```text
REGISTER
```

The actual KoL sender ID/name authenticates the request. The bot creates one
Supabase Auth account and automatically links/verifies the player. The website
username is the verified KoL name; **no custom usernames or user-controlled renames**.
Duplicate linked accounts and banned identities are rejected.

The bot sends the username and generated temporary password back through KMail.
`CREDENTIALS` (alias `FORGOT LOGIN`) from the same linked KoL player issues a **new**
password. It cannot retrieve an old password or recover somebody else's account
from a typed name. There is a five-minute account-request cooldown. Users can change
password after login via their account page; user-chosen passwords have a 12-character
minimum. New registration/recovery requires no real email address or SMTP.

Internally, Auth uses `account-<UUID>@login.khub.invalid`. The website resolves a
KoL username through `khub_login_address`, then uses Supabase password login.
Do not expose a legacy user's real email through the public lookup.

Relevant files: `src/pages/Register.jsx`, `Login.jsx`, `AuthEmailPage.jsx`,
`ResetPassword.jsx`, `src/lib/auth.js`, `src/context/UserContext.jsx`,
`bot/src/accounts.mjs`, `bot/src/store.mjs` and migrations `019`, `021`, `022`.

Account operations are durable private jobs. Keep the reserved account UUID,
request stamp and password unchanged across retries. Finish requires confirmation
from Auth before queuing the credentials. Generated secrets are removed from jobs
once queued and from delivery bodies after confirmed sending. Routine inspect/
lookup output hides credential bodies. Saved KoL Inbox/Sent messages still contain
passwords: never print those messages or include them in a handoff.

### Latest bugs and fixes: pick up here if login is still failing

1. **Account creation failed after migration 019.** Supabase Admin API initially
   inserts `auth.users`, then attaches `app_metadata` within its transaction. Our
   original trigger incorrectly required the final metadata at INSERT. Migration
   **021** fixes this: the exact private job's generated UUID/internal address
   authorize the INSERT; finalization still requires the server-controlled stamp.
   The regression test reproduces the old failure and real insertion order.
2. **KMail added spaces inside temporary passwords.** The original long base64url
   token failed, and a longer hyphen-separated format was also visibly split.
   The current generator produces **16 characters**, `Kh9!` plus 12 uniformly
   random letters/digits using `crypto.randomInt` (about 71 random bits). No spaces,
   hyphens or underscores. Migration **022** lowers the private job/function minimum
   from 24 to 16. It does not change existing passwords or pending jobs.
3. The last user-facing instruction was: stop bot, apply `022`, restart `npm start`,
   then send `CREDENTIALS`. **No successful login with the new 16-character format
   has been confirmed yet.** Previously issued bot passwords never contained
   spaces, so remove KMail-inserted spaces while retaining genuine hyphens if
   trying an older password. Do not normalize every website password: users may
   intentionally choose passwords containing spaces.

A read-only hosted check confirmed that the tested username resolved, the Auth
account existed/was confirmed, the internal address matched, the request stamp
existed, no Auth ban was active, and website/bot used the same Supabase project.
It did not log into KoL, sign into the user's website account, or reset a password.
Do not assume this remains current after the user's subsequent manual changes.

All accounts so far were the user's test accounts. The user explicitly said no
legacy-account migration was needed. They requested reset SQL, which was supplied
and validated on a disposable database. **The assistant did not execute the reset
against hosted Supabase.** The user may have done so manually; verify if relevant.

## Auction workflow implemented now

1. Seller creates a website listing with item/quantity, starting bid, optional
   **Instant Purchase Price**, and duration. It waits for the item deposit.
2. Seller KMail: `LIST <auction number>` + exact items, no extra Meat/items.
   Bot acceptance activates the auction and normally starts its duration.
3. Bidder KMail: `BID <auction number>` + **full new bid amount** in Meat, no items.
   The bot holds the leading bid and returns the previous leading bid in full.
4. The same BID command handles instant purchase: reaching the instant price ends
   bidding; excess is refunded. Do not show duplicate bid instructions for this.
5. At expiry, send items to winner and net payment to seller. New listings charge
   **7.5% commission, rounded down to whole Meat**. No-bid auctions return items
   without commission. Existing listing fees stay fixed.
6. Completion means all required deliveries were acknowledged, not merely that a
   timer expired. Historical auction/bid records remain in the database.

Short auction numbers are shared by everyone for a listing, not per-user secrets.
Full UUID commands remain supported for compatibility. Delivery references are
`D-...`; closet references are `C-...`. Operator logs retain both short references
and UUIDs. Users should not see internal item numbers in messages.

## Bot safety and mail policies

- **Only one KoL-connected copy at a time, even read-only.** Two copies replace
  each other's sessions. Stop Oracle before local testing; a manual KoL login can
  also replace a session. Do not casually start a worker as a diagnostic tool.
- Supabase is the authoritative ledger; local SQLite/cache is not accepted auction
  state. Receipt intake, escrow changes and obligations commit transactionally.
  Duplicate mail cannot repeat a committed transaction.
- Claim sends/moves durably before making an external write. A timeout or uncertain
  acknowledgment stays blocked across restarts. Never retry or mark sent/moved
  just to clear an error. Reconcile using actual sent-copy markers/attachments or
  exact inventory/closet evidence. Use documented resolve commands, not row edits.
- Check actual assets against escrow, refunds and outstanding obligations. Do not
  spend held funds or bypass deficits. Optional owner-funded reserve defaults to 0.
- Normal `DONATE` mail and **all gift packages** count as donations, regardless of
  gift text. Gift packages remain unopened; opening one manually can invalidate a
  pending wrapper closet move. Normal blank/invalid mail with attachments is refunded;
  unknown unfunded/system/unsupported messages stay in the inbox for review.
- Donations and confirmed sale commission are queued into the closet without using
  protected escrow funds. After an acknowledged move, the owner can withdraw those
  closet assets without creating a historical deficit obligation.
- Rollover uses the game timestamp/maintenance detection, pauses transfers near
  rollover, then resumes. A scheduled reboot is not the fix.
- Auction clocks currently continue through outages. Funded bids count only if
  processed before the deadline; late-processed ones are refunded. Extensions are
  not implemented. Accepted obligations survive downtime.

## Website state and planned work

Implemented locally: persistent auctions, lifecycle/instant purchase, catalog search,
browsing filters/sorting, active homepage prioritization, account timers/current bids,
clipboard buttons, and reduced/visibility-aware refresh behavior. Read current
contexts/hooks before changing refreshes; server/bot validation remains authoritative.

**Wall of Shame:** `/wall-of-shame`, main navigation link, wall texture, separate
watercolor-painted frame and portrait assets, responsive layout, nameplates,
pagination and empty/error/retry states. Public RPC exposes only explicitly published,
reviewed active bans. Private reasons are not public. Banning alone does not publish.
Expired/overturned entries disappear; publication expiry itself does not lift the
underlying account restriction. No browser admin publication form exists yet.
Current text: “The kHub”; “A permanent tribute to exceptionally poor judgment.”;
“No portraits yet. We’d prefer to keep it that way.”

Optional escrow/direct settlement, anonymous identities, seller profiles/search,
reputation/feedback, and a completed-sales gallery/public lifetime stats are
**roadmap proposals, not implemented behavior**. Older alias/anonymity proposals
must not override the user's newer no-custom-registration-name decision silently.
Private bot financial summaries/history already exist (`npm run stats`).

The user wants short, readable product copy. Avoid expanding registration back
into a wall of text. Preserve their Info page's typography/look and personal writing
unless asked to change it. Current registration has a red ban-evasion warning,
plain-text My Account (no quotes or link), and bold “Never reuse your KoL password.”

## Migrations, deployment status and Git

**New website migrations go in `supabase/migrations/queue/`.** The user manually
runs them in SQL Editor, then moves them into `supabase/migrations/` under the
same name. Never move them for the user. Standalone bot copies go directly in
`bot/supabase/migrations/`, without queue. Do not rerun old scripts indiscriminately.

At handoff, website migrations through **022 are physically in the parent folder**,
with only the queue README left below `queue/`. This is a useful hint under the
user's convention, **not independent verification that every migration succeeded**.
The assistant has not applied hosted migrations. Earlier ROADMAP/README references
may still say “queued.” Resolve a script in either location.

There are many uncommitted/untracked changes from this session. Inspect `git status`
and preserve them. Do not reset, overwrite, auto-commit or auto-push on handoff.
The bot changes will not appear in normal Git status because it is ignored.

Oracle previously ran successfully as container `khub-bot`, folder `~/khub-bot`,
user `ubuntu`. The historical public IP was `157.151.227.17`; verify in Oracle
before relying on it. Recent troubleshooting used the **local Mac bot**, not Oracle;
the hosted copy may be stopped or outdated. Never assume it has the latest bundle.
Read-only mode still logs into KoL, so it is not safe beside a local live copy.

## Useful commands and checks

From project root, website:

```bash
npm run dev
node --test tests/*.test.mjs
npm run build
```

From `bot/` (Node 24+):

```bash
npm start                     # connects to KoL; check other copies first
npm run inspect               # Supabase ledger only, no KoL login
npm run lookup -- D-1042
node --env-file=.env src/cli.mjs lookup-closet C-1001
npm run stats
npm test
npm run bundle                # exports/khub-bot.tar.gz; excludes secrets
```

Read reconciliation examples in the bot README before using `resolve`,
`resolve-closet` or `cancel-opened-package`. Evidence and eligibility matter.

On Oracle from `~/khub-bot` (may need `sudo`):

```bash
sudo docker compose stop
sudo docker compose up -d --force-recreate
sudo docker compose logs --tail=50 -f
```

Set `BOT_LIVE=true`/`false` privately in the bot `.env`, then recreate the container
for an environment change. Ctrl+C in a Docker log viewer only exits the viewer;
it does not stop the container. Local Ctrl+C stops the foreground worker.

Database verification: `python3 tests/database_test.py` requires PostgreSQL tools
(`pg_config`, `initdb`, `pg_ctl`) and uses a disposable local database, not Supabase.
It covers actual SQL, permissions, races, restart persistence and latest account
migrations. Auth is a minimal test stub, not a complete hosted GoTrue instance.
The 021 test now models insertion before app metadata; still verify real KMail/login.

Latest completed checks: **71 bot tests**, **63 website tests** (the website suite
last ran before the final password-only changes), isolated database tests through
022, website production build and mocked desktop/mobile gallery checks. No real
successful 16-character login has been confirmed. No bots are started by tests.

Prior agent environment had default Node 22; Node 24 was temporarily available at
`/tmp/khub-node/node_modules/node/bin/node`. Do not assume that temporary installation
survives. Bot runtime needs Node 24 for its SQLite dependency. The SQLite experimental
warning alone is not the account-creation/login failure.

## Credentials and working preferences

- Browser configuration is root `.env.local`; bot secrets are `bot/.env`; SSH keys
  may be under `bot/keys/`. Never print, commit, bundle or copy secret values into
  documentation/chat. Publishable key and service-role key are not interchangeable.
- No database reset, real Auth creation/password reset, or KoL send should be done
  just to run a test. Use mocks/disposable DBs; live testing needs the user's context.
- A backup archive listing is not a restore test. Off-device backups, restore drills,
  health alerts and hosted rollout verification remain open work in ROADMAP.
- Keep updates/final answers concise and actionable. The user often makes small,
  precise copy/style edits; implement those without unrelated redesigns or policy text.
- Link to relevant code/docs when useful. The user prefers project-relative IDE
  links, but navigation has not been verified; don't claim it works without evidence.
