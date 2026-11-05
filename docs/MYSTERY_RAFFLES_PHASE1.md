# Mystery Raffles — Phase 1

Website and database preparation only. No bot changes or financial processing.

Apply `supabase/migrations/queue/202611040197_mystery_raffle_preparation.sql`
manually before using creation. Requires the existing catalog, profile and admin
helpers (including `khub_bot.auction_item_eligible`). Leave the migration queued
until successfully applied; no standalone bot copy is needed for this website-only feature.

In Create Auction, administrators can select Raffle beside Giveaway. Review the
name, prize outcomes, quantities, ticket price and local closing time, then save.
The result opens `/raffle/:id`; `/raffles` shows the latest 20 previews. These are
separate routes and tables, deliberately excluded from ordinary auction feeds,
shared cache, bids, buyout, deposits and settlement. No navbar changes are required.

All raffles remain `preview`, including after their advertised closing time.
There is no activation API. No tickets, payments or draws exist. Each prize row
represents one future outcome; quantity does not add chances. Apply queued migration
`202611040198_raffle_prize_probabilities.sql` after 197 before using the updated
website. Probabilities are stored in integer basis points (10000 = 100%), with
two decimal percentage precision. Equal mode distributes rounding remainder to
the first outcomes; custom mode proportionally balances unlocked prizes while preserving locked
odds and the edited value. Pool changes preserve remaining locks; resetting
equal odds unlocks every prize. Two-decimal rounding always totals exactly 100%. Existing saved pools are backfilled with equal odds.
Published pools have no edit API and remain protected by read-only client grants.
Names/images are snapshotted from the authoritative eligible item catalog. No
inventory check or deposit is required, and the display explicitly says deposits
are unconfirmed. The future purchase/draw phase must establish its own rules.

Creation checks administrator status on the server and accepts an idempotent
request UUID. Public reads exclude creator identity. RLS and grants prevent client
writes to either table. Reads happen only when opening a raffle route; countdowns
use a local timer without polling the database or invalidating shared caches.

Checks:

- `node --test tests/raffles.test.mjs tests/raffles-render.test.mjs`
- `node --test tests/auction-publication.test.mjs`
- `python3 tests/raffles_database_test.py` (isolated local PostgreSQL)
- `npm run build`

No migration or deployment is automatic.
