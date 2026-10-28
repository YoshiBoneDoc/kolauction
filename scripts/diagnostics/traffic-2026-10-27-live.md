# Live giveaway crash and recovery — October 27, 2026

Read-only snapshots from 2026-10-28T03:04:19.391327+00:00 through 2026-10-28T03:07:56.452910+00:00.

## Confirmed sequence

- 11:02 PM EDT: `bot_claim_delivery` exceeded the database statement timeout; supervisor restarted the worker.
- 11:03 PM EDT: `bot_inspect` exceeded the database statement timeout; supervisor retried after 10 seconds.
- 11:04 PM EDT: inspection succeeded in 8.623 seconds including CLI/container startup. Queue: 556 sent, 3 pending; no queue block or preparation holds. Container was running with OOMKilled=false.
- 11:04 PM EDT: item delivery D-1606 and seller payout D-1607 for auction #1121 were logged sent.
- 11:05 PM EDT: confirmation D-1603 and refunds D-1604/D-1605 were logged sent during replay recovery.
- 11:06 PM EDT: new auction #1120 bids produced sent confirmation D-1608, outbid refund D-1609 and confirmation D-1610.
- 11:08 PM EDT: another incoming gift was verified; auction #1118 bid confirmation D-1611 was logged sent.
- 11:12:51 PM EDT: separate local health-file check showed worker 492 working, last successful cycle 11:12:00 PM, last progress 11:12:50 PM, and worker restart count still 2. This check did not call the database.

## Preparation for the next giveaway

- Purpose: use this incident to identify bottlenecks, validate changes, and establish safe capacity before another traffic spike.
- Confirmed failure points to reproduce in an isolated test environment: statement timeouts in `bot_claim_delivery` and `bot_inspect`, followed by worker restart and durable delivery recovery.
- Validate future changes under simultaneous website reads and bot intake/delivery work. Measure database query latency, timeout rate, lock waits, worker cycle duration, queue age, and confirmation/refund latency.
- Verify that retries and worker restarts preserve duplicate prevention and financial safeguards under load.
- Correlate this timeline with available Supabase and website traffic metrics. Visitor counts and peak database utilization were not captured here; these samples alone do not establish a safe traffic capacity or the underlying database bottleneck.

## Later incident: gift refunds D-1697 and D-1702

- Additional database timeouts: `bot_ingest_mail` at 11:25:10 PM and 11:26:33 PM; `bot_tick` at 11:33:26 PM. These are separate from the gift preparation failures.
- At 11:31:39 PM and 11:31:47 PM respectively, both 11 Meat outbid refunds to player #3442039 failed at `wrapping_solvency`, before any gift send request. Saved ledger evidence confirms the non-attempt.
- D-1697 snapshot: inventory 145,543,894 Meat; wrapping liabilities 145,562,064 Meat. D-1702: inventory 145,543,854; liabilities 145,562,024. Both show no item shortfalls, reserve 1,000, review Meat 0, wrapping cost 50. Deficit against liabilities is 18,170; deficit including reserve and wrapping is 19,220.
- One bounded inspection at approximately 11:54 PM returned 666 sent, 2 unknown, no pending deliveries, `pendingQueueBlocked=false`, zero preparation holds, 2 pending closet moves. Both isolated rows had `reason=check_failed` and no Sent Mail candidates. Repeated isolation messages are repeated recovery checks, not resend attempts.
- The stopped service prevented `compose exec`; read-only lookups subsequently ran in disposable containers without starting a worker or connecting to KoL. No delivery was reconciled or resent.
- Auction item deliveries and seller payouts for #1116–#1119 were logged sent at 11:31–11:32 PM. By the later database read, #1117 and #1118 remained `settling`; #1116 and #1119 were `completed`.

### Accounting overlap candidate

Local migration 098's `bot_refresh_gift_protection` subtracts base obligations, queued closet Meat, safe operating quota and reserve when protecting surplus. It does not subtract commissions for Sell auctions still settling. Migration 096's `bot_gift_wrapping_liabilities` then adds those settling commissions to obligations including protected surplus. With active gift review and positive surplus, the same commission can therefore be protected twice.

Live auction records show fees of 24,003 (#1116), 12 (#1117), 5 (#1118), and 500 (#1119), totaling 24,520 Meat. All four were finalized before the two failures. Under the local formulas, the observed 18,170 deficit corresponds exactly to a safe quota of 5,350 plus a 1,000 reserve: `24,520 - 5,350 - 1,000 = 18,170`. The later safe quota was 5,300 and a subsequent 50 Meat gift send was logged, which is consistent with this inference.

`node scripts/diagnostics/gift-commission-overlap-repro.mjs` reproduces the recorded rejection using this conditional arithmetic and the actual worker solvency function. It is not a full SQL replay: historical base obligations/protected surplus and deployed function definitions were not captured at the instant of failure. This is a strong investigation candidate, not proof of missing funds or a production fix. Do not release gift protection or bypass solvency checks to test it.

## Worker samples

Follow-up at 11:21 PM EDT: worker 492 healthy, last successful cycle 11:21:06 PM, restarts still 2. A fresh remote log capture covering approximately the preceding 15 minutes contained 45 `[MAIL]` processing events, 7 verified-gift events, and 73 distinct delivery references in logged SENT/REFUNDED outcomes, through D-1683. No timeout, worker-exit, retrying, or unconfirmed-send lines were present in this capture. These are log-event counts, not measured end-to-end latencies or a full ledger reconciliation.

The original local log follower had stopped updating after 11:08 PM even though remote processing continued. Recent logs were recovered directly into `/tmp/khub-traffic-followup-20261027.log`, and a new follower was started with SSH keepalives. Continuous local recording is best-effort; silence in that file alone is not evidence of an idle bot.

| Captured UTC | Status | Last successful cycle | Worker restarts |
|---|---|---|---|
| 2026-10-28T03:04:19.391327+00:00 | ↻ Working | Tue, Oct 27, 2026, 11:00:57 PM EDT | 2 |
| 2026-10-28T03:04:56.363596+00:00 | ↻ Working | Tue, Oct 27, 2026, 11:00:57 PM EDT | 2 |
| 2026-10-28T03:05:12.567051+00:00 | ✓ Healthy | Tue, Oct 27, 2026, 11:05:03 PM EDT | 2 |
| 2026-10-28T03:05:28.862549+00:00 | ↻ Working | Tue, Oct 27, 2026, 11:05:03 PM EDT | 2 |
| 2026-10-28T03:05:45.484421+00:00 | ✓ Healthy | Tue, Oct 27, 2026, 11:05:35 PM EDT | 2 |
| 2026-10-28T03:06:01.768366+00:00 | ✓ Healthy | Tue, Oct 27, 2026, 11:05:54 PM EDT | 2 |
| 2026-10-28T03:06:17.969139+00:00 | ↻ Working | Tue, Oct 27, 2026, 11:05:54 PM EDT | 2 |
| 2026-10-28T03:06:34.169685+00:00 | ✓ Healthy | Tue, Oct 27, 2026, 11:06:20 PM EDT | 2 |
| 2026-10-28T03:06:51.359440+00:00 | ✓ Healthy | Tue, Oct 27, 2026, 11:06:46 PM EDT | 2 |
| 2026-10-28T03:07:07.657936+00:00 | ✓ Healthy | Tue, Oct 27, 2026, 11:07:05 PM EDT | 2 |
| 2026-10-28T03:07:23.875864+00:00 | ↻ Working | Tue, Oct 27, 2026, 11:07:05 PM EDT | 2 |
| 2026-10-28T03:07:40.159953+00:00 | ✓ Healthy | Tue, Oct 27, 2026, 11:07:27 PM EDT | 2 |
| 2026-10-28T03:07:56.452910+00:00 | ✓ Healthy | Tue, Oct 27, 2026, 11:07:46 PM EDT | 2 |

## Container resource samples

```text
2026-10-28T03:04:19.391327+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O          BLOCK I/O         PIDS
ad0062dea71a   khub-bot   36.64%    134.4MiB / 954MiB   14.09%    6.8MB / 2.96MB   29.9MB / 6.33MB   28
2026-10-28T03:04:56.363596+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O           BLOCK I/O         PIDS
ad0062dea71a   khub-bot   58.60%    146.6MiB / 954MiB   15.37%    7.08MB / 3.09MB   38.6MB / 6.37MB   19
2026-10-28T03:05:12.567051+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O           BLOCK I/O         PIDS
ad0062dea71a   khub-bot   55.10%    146.8MiB / 954MiB   15.38%    7.13MB / 3.11MB   38.6MB / 6.38MB   19
2026-10-28T03:05:28.862549+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O           BLOCK I/O         PIDS
ad0062dea71a   khub-bot   70.25%    146.7MiB / 954MiB   15.38%    7.19MB / 3.12MB   38.6MB / 6.39MB   19
2026-10-28T03:05:45.484421+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O          BLOCK I/O         PIDS
ad0062dea71a   khub-bot   88.26%    157.7MiB / 954MiB   16.53%    7.28MB / 3.2MB   38.6MB / 6.41MB   26
2026-10-28T03:06:01.768366+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O          BLOCK I/O         PIDS
ad0062dea71a   khub-bot   87.66%    158.2MiB / 954MiB   16.58%    7.42MB / 3.3MB   38.6MB / 6.43MB   26
2026-10-28T03:06:17.969139+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O          BLOCK I/O         PIDS
ad0062dea71a   khub-bot   85.15%    148.2MiB / 954MiB   15.54%    7.58MB / 3.4MB   38.6MB / 6.44MB   19
2026-10-28T03:06:34.169685+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O          BLOCK I/O         PIDS
ad0062dea71a   khub-bot   52.53%    148MiB / 954MiB     15.51%    7.59MB / 3.4MB   38.6MB / 6.46MB   19
2026-10-28T03:06:51.359440+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O           BLOCK I/O         PIDS
ad0062dea71a   khub-bot   61.42%    153.3MiB / 954MiB   16.07%    7.88MB / 3.54MB   38.6MB / 6.48MB   25
2026-10-28T03:07:07.657936+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O           BLOCK I/O        PIDS
ad0062dea71a   khub-bot   46.30%    149.5MiB / 954MiB   15.67%    8.03MB / 3.64MB   38.6MB / 6.5MB   19
2026-10-28T03:07:23.875864+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O           BLOCK I/O         PIDS
ad0062dea71a   khub-bot   81.60%    149.6MiB / 954MiB   15.68%    8.08MB / 3.65MB   38.6MB / 6.51MB   19
2026-10-28T03:07:40.159953+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O           BLOCK I/O         PIDS
ad0062dea71a   khub-bot   95.84%    149.6MiB / 954MiB   15.68%    8.17MB / 3.73MB   38.6MB / 6.52MB   19
2026-10-28T03:07:56.452910+00:00
CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O           BLOCK I/O         PIDS
ad0062dea71a   khub-bot   80.71%    160MiB / 954MiB     16.78%    8.31MB / 3.83MB   38.6MB / 6.55MB   26
```

## Separate host sample

```text
uptime
03:06:03 up 8 days,  9:35,  4 users,  load average: 0.03, 0.06, 0.01
memory
total        used        free      shared  buff/cache   available
Mem:             954         622          73           5         414         331
Swap:              0           0           0
cpu_wait
procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st gu
 0  0      0  74968   1876 422512    0    0    39    21  140    0  1  0 99  0  1  0
 0  0      0  74968   1876 422548    0    0     0     0   78  111  0  0 100  0  0  0
```

## Evidence boundaries

- No restart, production edit, financial mutation, or KoL login was performed by the diagnostic capture.
- Repeated snapshots use logs/health/resource commands; they do not repeatedly call bot_inspect.
- The host sample is after recovery. It does not exclude transient host pressure during the original failure.
- Database statement timeouts are confirmed. Database CPU, lock waits and SQL execution plans remain unavailable, so the underlying source of database delay is not established.
- Docker resource figures describe the bot server, not the Supabase database.
- A read-only Docker log follower continues writing to /tmp/khub-traffic-live-follow-20261027.log while its SSH process remains connected. Health/resource sampling is a bounded capture.
