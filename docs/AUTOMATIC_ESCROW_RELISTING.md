# Automatic Escrow relisting

New ordinary Escrow Sell and Bundle listings can opt into 1–3 additional attempts.
Buy orders and giveaways are excluded. Existing listings are unchanged.

Each unsuccessful attempt reuses the same auction ID/number and held item deposit.
No return delivery is created between attempts. Item quantities, bundle contents,
cover, seller, fee policy and buyout stay unchanged. Only the minimum bid is reduced
when requested: each reduction compounds from the preceding attempt, rounds down
using exact integer arithmetic, and stops at 1 Meat. A zero reduction keeps the price.

Each attempt lasts the original duration starting when the bot actually relists it.
For a custom ending time, the original creation-to-deadline interval is reused and
the custom deadline advances. An outage does not consume several attempts at once.
Creation time remains unchanged; private relist events retain every attempt's times
and prices. The creation preview displays the selected retry policy.

Relisting runs inside the existing completed-inbox-scan settlement boundary and
financial advisory lock. Migration 194 reduces the settlement grace to 30 seconds;
a complete scan must still start after that boundary. It requires funded items, no bids, no buyout, no timing
review, no seller restriction and no existing asset-dispatch obligations. Cancellation
uses normal settlement immediately; accepting any bid prevents further attempts.
After all attempts are exhausted, the existing unsold item-return flow takes over.
Attempt boundaries use KoL’s whole-second timestamp precision. Earlier-attempt
KMail follows normal refund accounting without placing the current attempt on a
timing hold; ordering protection within the current attempt remains intact.
Each relist sends one auction-scoped shared-cache notification. The reduced minimum
and custom deadline travel in the existing bounded live projection, so cached
selection rows need no extra visitor reads. Unrelated live auction entries remain
reusable. Existing queue bounds, deadlines, cooldowns and polling are unchanged.
Non-enrolled unsold auctions exit after an indexed plan lookup, before additional
relist escrow checks; winning sales and cancellations skip the helper entirely.

## Rollout

1. Deploy the compatible cache Worker and website live-overlay code before enabling
   relisting; these accept updated minimum bids and custom deadlines in live state.
2. Stop the existing Oracle worker while applying the migration, as required by its header.
3. Apply `supabase/migrations/queue/202611030193_automatic_escrow_relisting.sql`
   after the full existing prerequisites through 192. The standalone copy under
   `bot/supabase/migrations/` is the same script, not a second migration to apply.
4. Apply `202611030194_thirty_second_settlement_grace.sql` after 193 to enable
   the 30-second grace period. It requires no bot rebuild.
5. After success, the owner moves the website script to the migrations parent directory.
6. Resume one worker and deploy the website. No bot image rebuild is required:
   its existing inbox completion/settlement RPCs execute the updated database logic.

Do not deploy the opted-in creation form before SQL is applied; opted-in creation
fails if its RPC is missing. It never silently creates an auction without its policy.
No production SQL, deployment or worker restart is performed by local tests.

## Local verification

- `python3 tests/automatic_relisting_database_test.py` uses disposable PostgreSQL,
  synthetic accounts, staged inbox mail and durable queue checks.
- `node --test tests/automatic-relisting.test.mjs tests/bundles.test.mjs` checks
  atomic creation transport, failure propagation and unchanged ordinary bundles.
