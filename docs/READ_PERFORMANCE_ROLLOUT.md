# Read performance rollout

1. Apply `supabase/migrations/queue/202611030173_read_performance.sql` after all prerequisites through 172, during a quiet period. It briefly blocks bid inserts while backfilling aliases; lock acquisition fails after two seconds rather than waiting indefinitely. Move the script to the parent only after successful application. The bot copy is an alternative, not a second script to apply.
2. Deploy the website with the usual Cloudflare build. Rebuild/recreate the Oracle bot using the existing operator procedure to get rate-limited maintenance failure logs. Never run a second connected worker.
3. Confirm bot discovery maintenance runs every minute. `bot_worker_status()` now includes `discoveryRefreshedAt` and `discoveryStale` (five-minute threshold). Maintenance retries on the next minute and retains old snapshots on failure; visitor requests never rebuild discovery. The same maintenance RPC removes activity older than five minutes. Online counts still exclude visitors older than two minutes independently of cleanup.
4. Retain existing live-state rollout settings: cache Worker `LIVE_AUCTION_STATE=true`, matching migration 172 and frontend. The selective invalidation implementation is unchanged; legacy mode retains its previous behavior.

Anonymous bidder aliases are backfilled in historical first-bid timestamp/UUID order. New bidders receive the next immutable ordinal under an auction-row lock, in accepted insertion order. Repeat bids reuse their alias. Financial validation and transaction functions are unchanged.

Active Sell card overlays use a narrow projection; Buy and historical cards retain the full projection to preserve private reservation, winner and settlement display behavior.

Activity writes occur at most once per minute across tabs with Web Locks and shared local storage. Browsers without Web Locks use timestamp coordination as a best-effort fallback; storage-disabled browsers cannot coordinate across tabs. Admin counts refresh every minute. No edge tracking service is involved.
