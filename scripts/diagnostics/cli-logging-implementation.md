# CLI/operator logging update — 2026-10-28

Local implementation only; no production deployment or database changes performed.
The bot directory is intentionally gitignored; do not force-add it.

- Added `bot/src/operator-display.mjs`: compact colored Docker-compatible logs, display-only persisted reminder suppression, bounded redacted diagnostic history, output/storage failure isolation.
- Added `bot/src/issues.mjs` and `operator-cli.mjs`: compact overview; current reviews/waits/nonblocking retained mail; reference-specific evidence and existing guarded recovery instructions; historical diagnostics.
- Updated CLI entry points, timestamp logger wiring, color handling, success metadata in operator logs/worker, and database-recovery display metadata in runtime. No transaction decisions or recovery RPC semantics changed.
- Added Compose color default and package shortcuts. New files included in the deployment allowlist/archive.
- Documentation: `bot/CLI_LOGGING.md`, linked from README. Owner's QUICKSTART_README.md and LUNA_CHANGES.md untouched.
- Verification: 330/330 local Node bot tests pass, including seven operator interface tests. Full suite used experimental SQLite and localhost socket permission. New module/CLI syntax checks and credential-free help passed. Security-checked archive generated at `bot/exports/khub-bot.tar.gz`.
- This CLI update requires a bot rebuild/deploy, no additional migration. The current worker still requires the separate stage-two migration 127.

Important: suppressed output does not close database issues; `issues` uses current DB/snapshot data. `details` is historical evidence only. No blanket dismiss/retry command was added. Sent Mail absence is never treated as positive proof of non-delivery.

## Gift evidence display follow-up

- Added read-only `bot/src/gift-evidence.mjs`; gift `issue M-/G-` commands enrich the view using the existing `bot_gift_intake_state` RPC. No new SQL or KoL access.
- `inspect-gifts` now formats active saved evidence; `--json` preserves the original complete response. Notes and contents remain separate, wrapping is excluded, and observed attachments never become verified funds. Missing/unopened/ambiguous evidence is explicitly unknown.
- Added seven gift-evidence regression tests, including read-only RPC checks, fake acquisition text, redaction, ambiguous boundaries and unconfirmed requested-package identities. Quickstart guide unchanged by this follow-up.

## Guarded operator gift returns — migration 129

- Queued migration 129 adds service-only preview/queue RPCs and an audit. Only verified, unprocessed contents are eligible; financial lock and immutable receipt/queue commit prevent duplicate returns and races with intake. Separate opening reviews remain unchanged.
- Added `bot/src/gift-return.mjs`, CLI `return-gift M-…` preview and explicit `--confirm` reason, Next Step links, and M-reference lookup of queued/returned status.
- New SQL regression covers role guards, refused/empty/unknown/legacy/processed states, rollback, concurrent confirmations, exact large splits, liabilities, staged terminal handling, worker race and unknown-send replay. Six Node tests cover UI and invocation safety.
- Documentation: bot/GIFT_RETURNS.md and matching migration/test copies are packaged. No production SQL or gift returns executed. Owner's quickstart unchanged.
