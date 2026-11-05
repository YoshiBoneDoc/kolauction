# Raffle backend

Apply migration 200 (`202611040200_raffle_manual_fulfillment.sql`) after 197–199
and their existing financial prerequisites. Website SQL is queued; the identical
standalone copy is in `bot/supabase/migrations/`. Apply only one copy per database.
Migration 199 is preserved; 200 supersedes its Mall-related code and removes the
unused expense column. Historical migration text is not current functionality.

Activation remains blocked by the database gate. No deployment, live worker,
production SQL, real purchase or asset transfer was performed.

## Lifecycle

- Admin creates a preview. `RAFFLE <uuid>` with an exact positive multiple of
  ticket price accepts repeat purchases once per receipt. Payments processed at
  or after closing are refunded, including messages sent earlier.
- `SUPPLY <uuid>` accepts partial/repeated listed-item deposits from the current
  administrator/raffle owner. Deposits are optional and item-only: attached Meat
  rejects the entire request and returns all attachments through ordinary refunds.
- Closing freezes private ticket ranges and prize probabilities. The worker uses
  the cryptographic draw module, persists a first-writer-wins audit, and exposes
  only winner/selected prize publicly. Complete inbox intake precedes closing.
- Every winner receives a draw notice naming the selected prize and quantity.
  Deposited prizes deliver automatically. Otherwise an admin KMail identifies the
  selected item, full quantity, missing quantity, available advance and ADVANCE command. Acquire items manually and
  SUPPLY them. Put RAFFLE/SUPPLY commands in the outside note when using gifts. No automated purchasing or PURCHASE command exists.
- After drawing and before settlement, request advances in the management UI or
  KMail `ADVANCE <raffle UUID> <amount>` without attachments. Whole Meat and integer
  shorthand such as `200m` are accepted. Over-limit requests reply with the current
  available balance; previous pending/unknown advances and other commitments are excluded.
  Each UUID request durably commits a fixed amount into the existing delivery
  queue and deducts it from reserved proceeds atomically. Previous
  advances and queued transfers cannot fund another advance. Unknown advances
  remain committed. Pending browser requests retain their UUID in sessionStorage
  through reloads; retry the same request if acknowledgment was lost.
- Only verified winner delivery releases unused/excess/unselected item deposits
  after delivery. After these returns (and advances) are verified,
  remaining proceeds are queued. Cancellation refunds every accepted purchase;
  canceled and zero-ticket raffles return all deposits. Completion reason remains
  visible after settlement. Unknown sends never authorize an automatic resend.
- Existing liabilities, dispatch checks, multi-item delivery claims, acknowledgment,
  mailbox recovery and manual reconciliation are reused. No new polling loop.

## UI and privacy

Detail pages show private ticket ranges/history and cancellation refund status.
Home/browse cards fetch only the signed-in player's counts in one bounded RPC.
Auth changes discard visibility of previous private counts. Management is protected
server-side and includes deposits, selected prize, required supply, advance history,
reserved funds and individual delivery states. Refresh is explicit.

## Verification and rollout

`tests/raffle_lifecycle_database_test.py` loads every applied/queued local migration
into a disposable PostgreSQL cluster. It exercises the real draw module and
multi-item delivery claim/ack/reconciliation functions with simulated evidence,
partial/repeated deposits, duplicate/conflicting receipts, lost commit responses,
database restarts, transaction rollback, concurrent advances, uncertain transfers,
privacy, cancellation and empty raffles. Existing giveaway and automatic escrow
relisting regressions also pass with migration 200. Focused Node tests, frontend
lint and Vite build cover runtime helpers and presentation.

These are offline checks, not proof of production configuration, KoL transport
behavior or a 30-minute operational guarantee. Delays receive a durable winner
notice; unknown transfers require the existing operator verification workflow.
Review the management UI before enabling participation. Activation requires a
separate explicit reviewed migration; 200 cannot enable the gate.

The focused isolation audit additionally uses exact physical balances with an
active escrow auction, a funded/partly fulfilled Buy order, and two raffles sharing
item #2. It proves reserve-to-queue conservation, unrelated holdings after prize,
return/refund/advance/payout sends, and concurrent auction bidding plus advances.
The actual worker refuses claims when aggregate Meat or item balances are short.
A lost send acknowledgment blocks resend after restart. Browser financial RPC
permissions and the database activation CHECK are verified.

Audit fixes in the still-queued migration 200 restore the existing verified-gift
proof fence for raffle intake and advertise schema capability version 2. The new
worker pauses raffle processing on 199-only databases while ordinary auction work
continues. Standalone bot SQL now includes matching copies of all raffle
prerequisites (197–200), and its upload bundle includes the raffle Node tests.
If a previous revision of 200 has already been applied outside this workspace,
do not reapply it: obtain an incremental migration for the proof/capability changes.

Deploy SQL before dependent website/bot runtimes, then separately rebuild the
ignored bot and deploy the website. Keep the personal quickstart unchanged.

Focused gift/advance regressions cover verified gift opening through raffle intake,
repeat purchases, duplicate proof/receipt replay after restart, a 200m advance
rejected against 140m proceeds, prior pending/unknown advances, item-only supply
validation, balance replies, winner notices, and net settlement after advances.

Migration 200 removes the obsolete contribution and deposit-Meat columns. It
refuses legacy contribution records rather than silently deleting obligations;
any such records require reconciliation before the upgrade. Historical migration
199 is preserved. No dedicated contribution acceptance or refund path remains.
