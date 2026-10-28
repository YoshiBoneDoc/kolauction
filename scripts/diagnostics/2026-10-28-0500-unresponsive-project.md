# Project unresponsive around 05:00 EDT — 2026-10-28

Owner reports onset around 05:00 EDT. Investigation uses bounded read-only
requests; no production SQL, restarts, KoL sessions or financial mutations.

Confirmed from Oracle:
- Current worker image started at 04:54:43; live worker announced at 04:54:57.
- First retained failure at 05:02:04: bot_worker_status unavailable, HTTP 0.
- At 05:09:38 bot_review_gift_mail failed with HTTP 504.
- Later lightweight status failures at 05:10:51, 05:16:50, 05:21:56 and 05:27:01.
- At approximately 05:29, worker container had exited cleanly roughly one minute
  earlier; no lingering one-off bot containers were running. Owner's reason for
  stopping the worker/manual KoL session state has not yet been established.
- Oracle host load was 0.00 / 0.01 / 0.11, uptime eight days. This is not a
  measurement of Supabase database CPU/RAM.

Bounded independent API reads:
- Mac lightweight bot_worker_status read timed out after 8 seconds.
- Mac Auth health and a one-row public.auctions SELECT each timed out after 6s.
- Oracle Auth health and the same tiny SELECT each timed out after 8s. These ran
  in a disposable one-off container which exited; the worker was not started.
- No request returned a usable HTTP response in those deadlines. This establishes
  cross-service, cross-client unresponsiveness, not its root cause. A financial
  advisory lock alone does not explain all these observations.

Access/evidence limits:
- No IDE database connection, SQL connection string or Supabase management token
  is configured. Existing private bot API credentials permit RPC/table reads only.
- Supabase's public status page reported operational when checked. This does not
  rule out project-specific failure.
- Owner was asked to run scripts/diagnostics/current_database_pressure.sql once
  in SQL Editor and share result or exact error. The script was validated in a
  disposable local PostgreSQL cluster with all current migrations, then cleaned up.
- Pending evidence: active backend/lock snapshot, exact 05:00 database errors,
  project restart/compute-change history and deployed feature timestamps.

Possible recovery if SQL Editor is also unresponsive: owner restarts the project
from Supabase Project Settings once, with the worker kept stopped, then recheck
bounded API health before deciding to resume the worker. This briefly interrupts
site/database sessions and does not identify the underlying cause. No restart
has been performed or represented as a proven fix. Do not replay financial
resolution/refund commands to test availability.

## Owner-provided SQL snapshot at 05:37:07 EDT

CSV: Supabase Snippet Untitled query (6).csv. SQL Editor successfully executed
current_database_pressure.sql while project API probes remained unresponsive.

- Postgres started 2026-10-18 16:19:29 UTC; snapshot does not indicate a database
  restart at 05:00 on Oct 28.
- No financial advisory-lock holder/waiter, no blocking PID, no idle-in-transaction
  session. Only active client was supabase_admin with ~1.67s statement age.
- 20 other reported sessions, predominantly idle; configured max_connections 60.
  Eleven authenticator connections idle; one Auth admin connection idle.
- shared_buffers: 28672 * 8 KiB = 224 MiB; work_mem 2184 KiB; maintenance_work_mem
  32768 KiB. These do not establish a newly inflated work_mem setting.
- Zero deadlocks. Temp bytes 29,984,736,904 / 12,145 files are cumulative since
  Oct 2, not evidence of 30 GB of current memory usage or a 05:00 spill.
- Migration 129 preview/return functions exist, and return RPC lock_timeout=5s.
- Owner was asked whether a project restart occurred after this snapshot;
  confirmation has not yet arrived.

Follow-up probes:
- Oracle gateway without API credentials responded HTTP 401 in ~137ms; DNS,
  TCP and TLS were fast. This is an expected unauthorized response, not a
  successful authenticated database/API-health check.
- An authenticated one-row REST read still timed out at 15 seconds from Mac.
- With earlier Auth-health failures, evidence now favors project API/upstream
  service unresponsiveness over a bot financial-lock holder. Root cause of that
  service problem remains unproven; memory pressure is a candidate, not a finding.
- Current recovery recommendation: if not already done, owner performs a single
  Project Settings restart, then bounded read-only Auth/REST checks before bot
  resumption. No live restart or backend cancellation has been performed here.

## Recovery confirmed after owner restart

Owner reported that a Supabase restart restored service. Two bounded independent
reads then returned HTTP 200 from Mac: one-row database API read in 1306 ms and
Auth health in 1410 ms. The bot was not restarted by this investigation.

This supports a recoverable project/service failure; it does not establish traffic,
a memory leak, a particular migration or RAM exhaustion as its original cause.
Prevention candidates from current source review: short shared caching for truly
public browsing (current cache is browser/viewer-local), deadlines on read-only
RPCs (financial mutations require their existing uncertainty handling), independent
health alerts and isolated concurrent load tests. More compute RAM provides
headroom on the current Free/Nano tier, but is not a proven root-cause fix.
