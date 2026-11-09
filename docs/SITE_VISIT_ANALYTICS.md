# Site visit analytics

Apply queued migration 249 once after 248 in Supabase SQL Editor as postgres, then
release the website. Matching standalone bot SQL is an alternative copy for the
same database, not another migration to apply. No bot restart required.

The existing visible-page heartbeat (90 seconds, cross-tab coordination, pressure
backoff) now updates visit history alongside unchanged recent presence. No browser
request, timer, shared cache, financial lock or external analytics dependency is added.

- Signed-in accounts are keyed by auth.uid(), coalescing tabs/devices. Guest keys
  use the existing random browser identifier; clearing storage changes identity.
- New visits begin on the first heartbeat or after >=30 minutes without activity.
  A per-identity advisory lock serializes concurrent heartbeats; there is no global
  write lock. Visits started as a guest stay separate from later signed-in visits.
- Unique active users count distinct signed-in accounts with last_seen inside the
  rolling window. Total Visits count signed-in visits whose start is inside it.
  An ongoing visit can therefore count toward active users without starting a new
  visit in that window. Signed-in and guest series are never added together.
- Background tabs send no heartbeat. Open visible tabs can count as active even
  without clicks; these are presence-based estimates, not proof of human engagement.
  Network failures/load backoff may split a visit or miss activity. Client-supplied
  guest IDs cannot establish unique people and automated clients can affect totals.
- No pre-install history is reconstructed. Recording start and definitions are in
  the chart's collapsed measurement-details section, alongside guest counts.

Private RLS tables hold only visit UUID, account UUID or random guest key and two
timestamps. An identity/last-seen index handles continuation lookup, and a last-seen
index bounds all analytics to the latest 30 days in one existing admin RPC. The
registration counts, weekly member list and pagination remain unchanged. Activity
is read only when existing Users analytics loads or the owner explicitly refreshes.
No route-change events or extra reads are sent from browser heartbeats.

At most 50 rows last seen more than 31 days ago are pruned per heartbeat with
SKIP LOCKED; idle installations retain old rows until new activity. Active long
visits remain until their last_seen ages out. Migration 249 makes the custom
password-login trigger function introduced by 248 a no-op without altering managed
Auth tables; old login records remain untouched but
are no longer read by Users analytics. Full Auth audit logging stays unnecessary.

After applying SQL and releasing the website, open a visible page using an existing
signed-in session, then refresh Users analytics. The account should appear without
logging out. Repeated heartbeats must not increase visits; a return after 30 minutes
without heartbeats starts another visit. Guests appear only in the guest breakdown.
The first heartbeat after release may wait for the existing 90-second throttle.
Local tests do not establish production installation, active browser version, or
live traffic counts.
