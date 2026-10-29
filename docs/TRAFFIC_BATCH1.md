# Traffic resilience: Batch 1

Implemented locally. Website/Cloudflare and Oracle bot deployments are separate.
No new SQL migration is needed for this batch. The owner's personal quickstart guide
is unchanged.

## Website

- Private account-profile checks use one request at a time, about 60–72 seconds apart,
  rather than an unconditional 15-second interval. Hidden tabs start no profile reads.
  Returning to a visible/focused tab refreshes, with a five-second focus dedupe window.
- Failures back off from about one minute to five minutes, plus up to 20% jitter.
  Focus/visibility events do not bypass an error cooldown. Auth session/user changes
  reset that user's lifecycle; unchanged repeated session announcements do not.
- Sign-out, account replacement and effect cleanup suppress late profile responses.
  Account information remains per-viewer memory only. Server-side access checks and
  transaction authorization remain authoritative; fewer UI checks can delay reflecting
  a server-side account-status change until the next successful refresh.
- The entire poll feed remains private: it contains `has_voted`, personalized queues,
  admin flags and permission-dependent results. It now uses the same visible-tab
  one-minute scheduler/backoff. Voting and management remain direct, with the existing
  immediate post-action updates. No voting data was moved into shared storage.
- Public announcement reads use `/api/public-banner` when the existing
  `VITE_SHARED_AUCTION_CACHE=true` flag is enabled. Only `revision` and `message` are
  copied into a separate named Durable Object (`public-banner-v1`) using the same
  deployed class/binding as the auction cache. JWTs/cookies are stripped. No admin
  state is cached. Admin reads/saves remain direct to Supabase.
- Banner snapshots are fresh for 30 seconds and then require a coalesced refresh.
  Unlike ordinary auction snapshots, expired banners are not served as successful
  stale responses. If a read fails, the component keeps its last displayed banner,
  as before. New/withdrawn announcements can take until the next refresh to appear.
  Dismissal stays local to the visitor. Banner polling is now 60–72 seconds with
  failure backoff, and stays paused in hidden tabs.
- The banner has its own object so accepted bids do not invalidate it and slow
  auction searches do not block it. No new Cloudflare resource/binding is required.

## Bot

Outgoing work yields between complete operations:

| Phase | Maximum operations per turn | Time budget |
| --- | --- | --- |
| Deliveries | 20 | 10 seconds |
| Closet moves | 5 | 5 seconds |
| Buy delivery preparation | 10 groups | 5 seconds |
| Source-mail cleanup | 20 messages | 5 seconds |
| Manual-review notices | 5 | 5 seconds |

A phase may always start one operation. A time limit stops starting the next operation;
it never interrupts an asset send, balance verification, database acknowledgment or
other operation already in progress. A slow network operation can exceed the budget.
This is not a hard wall-clock limit on a cycle.

When work yields, a healthy worker sleeps at most five seconds before its next complete
inbox scan, instead of the normal 15-second default. Idle polling stays configured as
before. Database-error backoff takes precedence. One worker/session is retained; no
parallel asset transfers are introduced. Additional inbox checks trade a little outgoing
throughput for faster intake during a backlog; this is not a proven capacity increase.

Buy preparation rotates across the current pending groups, so deferred groups at the
front do not permanently starve later groups. Cursor state is in memory; database
eligibility and claims remain authoritative across restart.

The entire recognized inbox batch is still staged/ingested in receipt order before
marking its scan complete and running settlement. No partial scan is certified complete.
All existing solvency checks, ledger claims, one-shot sends, uncertain-send isolation,
refunds, anti-sniping rules and cleanup eligibility checks remain in place. Unfinished
deliveries stay pending for later turns. No source KMail becomes eligible for deletion
merely because a batch ended.

## Activate

1. Build/deploy the website and updated Cloudflare Worker/Pages Functions. If shared
   caching is not yet configured, follow `docs/SHARED_AUCTION_CACHE.md` first. Keep
   `VITE_SHARED_AUCTION_CACHE=false` until the binding/endpoints are ready.
2. Confirm `/api/public-banner` returns JSON with `Cache-Control: no-store` and a
   `X-Khub-Cache: MISS` followed by `HIT` within 30 seconds. An inactive banner returns
   `banner: null` and is cached too. Check visible/hidden signed-in tabs and poll actions.
3. Upload the rebuilt `bot/exports/khub-bot.tar.gz`, rebuild/restart exactly one Oracle
   worker using the owner's existing procedure. Preserve the server's `.env` and state
   volume. The new source/test files are included in the archive.
4. Check normal health, bid intake and delivery progress. A bounded outgoing batch is
   normal; it must not leave a completed send unacknowledged or duplicate an asset send.

## Local checks

- `tests/private-refresh.test.mjs`: hidden/focused tabs, failure cooldowns, single-flight
  reads and cleanup during an in-flight response.
- `tests/shared-auction-cache.test.mjs`: announcement field allowlist, 100-reader
  coalescing, independent object, stripped credentials, private admin writes and existing
  auction-cache/privacy/invalidation regression cases.
- `bot/tests/work-budget.test.mjs`: backlog interleaving with intake, exact send/ack counts,
  slow-send completion, deferred-group fairness and busy versus idle polling.
- Existing authentication, poll/banner UI, escrow, closet, recovery and supervisor tests
  provide the corresponding regression checks. No production load test is implied.
