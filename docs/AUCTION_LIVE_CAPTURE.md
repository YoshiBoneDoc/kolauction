# Bounded live auction capture

Run locally on your Mac; no migration, bot restart or new hosted monitor required.
Start five minutes before auction end. Default duration is seven minutes to capture
settlement/recovery too; `--seconds 300` captures exactly five minutes.

```sh
python3 scripts/capture-auction-pressure.py
```

Requires Python 3 and `psql` on PATH (present on the development Mac). Hidden prompts:

1. PostgreSQL connection URI from Supabase **Connect**, using a database owner or
   monitoring role with `pg_read_all_stats` access. Use direct connection if reachable,
   or session pooler if required by your network. This is a database password/URI,
   not the service-role key. URI password characters must be percent encoded.
   Include `sslmode=require` in the URI.
2. Canonical project URL, `https://PROJECT.supabase.co`.
3. Legacy service-role JWT for the Supabase Metrics API (Basic Auth user `service_role`).

Do not paste credentials into chat or command arguments. Environment variables
`CAPTURE_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` are alternative
inputs. The script does not read existing `.env` files or print connection errors.
No live capture was run during implementation; verify access before the ending window.

## What it records

- One persistent read-only SQL connection; no overlapping SQL queries.
- Every five seconds: at most 30 active queries and 30 blocked queries with UTC time,
  query ID, recognized PostgREST RPC name, age, wait, blocker PIDs; financial-lock
  holders/waiters; cumulative database counters. RPC names can remain null, but
  query IDs can help match exported statement statistics and logs.
- Complete existing statement-statistics export at start/end only. No resets,
  EXPLAIN, application readers, financial writes or table scans of financial history.
- Once per minute: Supabase Metrics API, retaining allowlisted CPU, memory, swap,
  page-fault, disk, pressure and database counter series when the exporter exposes
  them. An unavailable endpoint or missing series is recorded explicitly. No fast
  retry; this part runs separately so it cannot block pressure sampling.
- Terminal live counts; append-only local JSONL and boundary JSON snapshots in
  `scripts/incident-captures/TIMESTAMP/`. Partial captures survive Ctrl+C/failure.
  Directory/files are private by default. Do not commit captures without review.

Every sample runs in an explicit read-only transaction with local settings (rather
than relying on pooler startup options). Every SQL statement has a 1.5s server deadline and 100ms lock deadline. Failure
skips the sample; connection loss does not trigger a reconnect storm. This is bounded
monitoring overhead, not zero overhead or a measured production cost guarantee.
A five-second sampler can miss short lock episodes. Host metrics have minute-level
resolution and exporter availability limits. PostgreSQL execution counters exclude
failed executions, so retain the Supabase error logs for the same window afterward.

For a preflight, run `--seconds 30` in advance. Confirm pressure has actual activity
visibility and `host metrics: ok`; inspect the host series for needed memory/swap
counters. Do not wait until the final minute to discover missing access.

Afterward, share the capture folder and error-log export. Also preserve existing
bot logs from the Oracle container across the same UTC window; this collector
cannot see KoL inbox backlog, transfer evidence or the worker's local phase metrics.
Do not enable bot telemetry if that would require a live restart during the event.

Supabase documents [one-minute metrics scraping and Basic authentication](https://supabase.com/docs/guides/observability/metrics/vendor-agnostic).
This captures a synchronized resource/query timeline; it cannot guarantee a unique
root cause or reconstruct events shorter than the sampling resolution.

If URI parsing fails, use separate connection fields (actual password; no manual encoding):

```sh
python3 scripts/capture-auction-pressure.py --seconds 30 --connection-fields
```

Copy host and user from Supabase Connect → Session pooler → Connection parameters;
port defaults to 5432, database is postgres. This avoids password URI escaping errors.
