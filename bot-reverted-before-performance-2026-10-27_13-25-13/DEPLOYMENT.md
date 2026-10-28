# Move kHub to an always-on host

This folder is self-contained. The server needs this bot package, Docker Engine
with the Compose plugin, internet access to KoL and Supabase, and your private
credentials. It does not need the website source, a new database, or a domain.
Creating the Oracle server and installing Docker are separate setup steps;
these files do not create cloud resources or incur hosting charges.

## 1. Create the transfer package on your Mac

For the account-failure notification update, first apply migration 059 (after 058)
in Supabase. Then deploy the rebuilt archive and restart/rebuild the one existing
bot as described below. No website deployment is required. The update isolates
account errors from safe payouts and queues one player/admin notification per
failed saved account request; do not run a second worker to test live notices.

From inside `bot/`:

```bash
npm run bundle
```

The result is `exports/khub-bot.tar.gz`. It includes source, the item catalog,
dependency manifests, Docker configuration, documentation, tests, and database
migration copies. It excludes your `.env`, `node_modules`, and runtime state.
You can copy this archive to a server or store it as a code backup.

## 2. Extract and build on the server

After uploading the archive to your server's home folder, with Docker installed:

```bash
mkdir -p ~/khub-bot
tar -xzf ~/khub-bot.tar.gz -C ~/khub-bot
cd ~/khub-bot
docker compose build
cp .env.example .env
chmod 600 .env
nano .env
```

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `KOL_USERNAME=kHub`, and
`KOL_PASSWORD` privately. Start with **`BOT_LIVE=false`**. Do not paste credentials
into chat, commit them, or include them in the transfer archive. Docker supplies
Node 24; a separate Node installation is not needed on the server.

Use the existing Supabase project. Do not rerun migrations merely because the
bot moved. Copies and setup guidance are in [supabase/README.md](supabase/README.md).
With migration 052 and the updated bot, the catalog initializes automatically on
the first live startup and refreshes weekly. `sync-catalog` forces an immediate
validated upstream refresh; it is not required every restart.

For the friendly-message update, stop all bot instances and apply
`supabase/migrations/202610190006_friendly_bot_messages.sql` once, followed by
`supabase/migrations/202610190007_short_auction_commands.sql`, before starting
the updated worker. Do not rerun a migration that already succeeded. Deploy the
worker before deploying the website's short commands. The new worker and
migrations must be deployed together; see
[message previews and rollout](MESSAGES.md#apply-this-change).
For gift donation thank-yous, also apply
`supabase/migrations/202610190008_donation_acknowledgments.sql` once after `007`
with all bots stopped, then deploy the matching bot update. Existing unacknowledged
gift packages in the inbox will get one thank-you each; they remain untouched.
For normal `DONATE` KMail, also apply
`supabase/migrations/202610190009_normal_kmail_donations.sql` once after `008`
and deploy this bot update. Empty DONATE mail receives instructions; funded DONATE
mail receives a thank-you and its assets are retained as a donation.

Check the database connection without logging into KoL:

```bash
docker compose run --rm --no-deps bot node src/cli.mjs inspect
```

If the catalog needs loading:

```bash
docker compose run --rm --no-deps bot node src/cli.mjs sync-catalog
```

## 3. Switch from the Mac to the server

1. Stop the Mac bot with **Ctrl+C** and wait for it to finish. Check for any
   other running copies. Only one bot may run for this account at a time, even
   in read-only mode; concurrent logins replace each other's KoL sessions.
2. With `BOT_LIVE=false` on the server, start it and read the logs:

   ```bash
   docker compose up -d
   docker compose logs --tail=50 -f
   ```

   It should identify kHub (#3888760) and show read-only processing. **Ctrl+C in
   this log view only closes the log viewer; the container keeps running.**
3. After checking the logs, stop the container:

   ```bash
   docker compose stop
   ```

4. Set `BOT_LIVE=true` in the server's `.env`, then run:

   ```bash
   docker compose up -d --force-recreate
   docker compose logs --tail=50 -f
   ```

   This enables real deposits, bids, refunds, and payouts. Do not also restart
   the Mac bot. The bot needs the usual operating Meat reserve on its KoL account.

The container is configured to restart after crashes and server reboots, provided
Docker starts on boot. Explicitly stopping it keeps it stopped until you start it
again. No ports need to be exposed for the bot; it makes outbound connections.
The updated image also supervises its worker, records local health in the
`bot-state` named volume, and includes a Docker healthcheck. Use
`docker compose exec bot node src/health.mjs` to read health without a KoL login.
`unhealthy` may mean a blocked ledger that needs review; the healthcheck itself
does not restart the container or clear uncertain sends. See the operations guide.

## Operations and updates

For copy/paste Mac-to-Oracle update commands, see the
[README update checklist](README.md#update-the-code-running-on-oracle). An error
about `bot_claim_delivery` **without parameters** indicates a stale worker/image:
the current worker supplies `p_message_version: 2`. Upload the current bundle,
extract it, rebuild, and recreate the container. Restarting an old image or changing
`.env` does not deploy code; do not replace the database function with an obsolete
no-parameter version to accommodate that image.


- View logs: `docker compose logs --tail=100 -f`.
- Stop processing: `docker compose stop`.
- Inspect the database: `docker compose run --rm --no-deps bot node src/cli.mjs inspect`.
- Update code: stop the bot, extract the new bundle over this folder, then run
  `docker compose up -d --build`. The bundle does not contain `.env`, so your
  server credentials remain in place. Recreate the container after `.env` changes.
- Keep the same Supabase project: auction records and pending obligations survive
  the move. An uncertain delivery stays blocked and needs review; moving or
  restarting does not authorize another send. See [README.md](README.md#restart-and-uncertain-sends).
- Keep a private credential backup separately from the code archive. Monitor
  the host and bot; automatic restarts do not resolve persistent errors.

## Standalone layout

```text
bot/
  src/                 Bot code, including a local catalog loader
  catalog/items.json   Item catalog needed by sync-catalog
  supabase/            Database migration copies and setup notes
  tests/               Node tests and an isolated PostgreSQL test suite
  tools/bundle.mjs     Creates the transfer archive
  Dockerfile           Node 24 container
  compose.yaml         One container, restart policy, bounded logs
  .env.example         Public configuration template
  .env                 Private credentials; excluded from archives and Git
  exports/             Generated transfer archives; excluded from Git
```

For the styled donation thank-you and error contact, stop the bot, apply
`supabase/migrations/202610190010_donation_message_style.sql` once after `009`,
then deploy the updated bot. The footer is saved with each newly claimed message;
previously claimed retries retain their original wording. No refund or auction rules change.

For the revised donation wording (without the decorative heading), apply
`supabase/migrations/202610190011_donation_message_wording.sql` once after `010`.
This is a database template change; the worker updated for `010` needs no rebuild.
Newly claimed donation messages use the new text; existing retries keep their saved text.

For mail retention and tracked manual-review notices, stop every bot, apply
`supabase/migrations/202610190012_bot_mail_review.sql` once after `011`,
then restart/deploy the matching worker. See `OPERATIONS.md` for the outage and backup plan.

For the historical flat-fee and donation/commission closet setup (superseded by
069 for new fees), stop all workers, apply
`supabase/migrations/202610190013_closet_income.sql` after `012`, then restart/deploy
the updated worker. This affects future listing fees and newly recorded income;
existing fee terms and old donation receipts are preserved. Closet moves require
separate operating funds and protect auction/refund holds. Inspect C-references
and reconcile uncertain closet moves using the operations guide.

For auction-number-first message headings, the revised outbid notice and the full
seller payment breakdown, apply `supabase/migrations/202610190014_auction_message_layout.sql` once
after `013`. This only changes database templates: an already updated `013` worker
needs no rebuild/restart. Previously claimed messages keep their saved wording.

Worker update: rollover now waits/resumes automatically, with a two-minute buffer
before new transfers. No scheduled reboot or new SQL migration is needed. The extra
Meat buffer defaults to 0; set `BOT_MEAT_RESERVE=0` in an existing server `.env`, then
install the updated archive and rebuild/recreate the container as described above.
All actual escrow obligations stay protected. See `OPERATIONS.md` for details.

Stop all workers, apply `supabase/migrations/202610190015_invalid_mail_refunds.sql`
after `014`, then restart/deploy the updated worker. Blank/invalid funded normal
mail is refunded, not donated. Old implicit donations are held for safe correction
refunds; uncertain C-references must be resolved from evidence first. Item closet
requests now use GET, with safe failure diagnostics. See the bot operations guide.

## KMail accounts (019)

Stop all workers, apply `supabase/migrations/202610190019_kmail_accounts.sql`
after `018`, then deploy the matching bot and website. In the website repository,
new scripts start under `supabase/migrations/queue/`; move the script yourself after
applying it. The standalone bot copy goes directly in its migrations folder.

REGISTER uses the verified KMail sender’s KoL name; custom names are rejected. CREDENTIALS generates a fresh
password for the verified sender's linked account. New accounts require no email
or SMTP. Existing accounts/history are retained. See the bot README for operational
details and the website Supabase README for Auth settings and ban administration.

## Tiered escrow fees (069)

After 068, stop all workers and apply `supabase/migrations/202610210069_tiered_escrow_fees.sql`.
Restart the worker and deploy the website. The deduction is calculated in PostgreSQL;
the existing worker pays the recorded net amount, so this change alone does not
require uploading new JavaScript to Oracle. The updated archive includes the SQL,
financial tests, and operator/message documentation for future deployments.

New/open standard-rate escrow listings use marginal 5/4/3/2/1% bands, rounded down
once. Historical finalized payments and existing free/sub-5% flat terms stay intact.
Never change old payout amounts manually to migrate a fee schedule.
