# Recorded login activity

Apply queued migration 248 once after 247/246, then release the website. No bot
restart, full audit-log storage, browser event RPC, new polling or shared cache is
needed. Keep the personal bot quickstart unchanged.

The website signs in with passwords. Supabase Auth's `IssueRefreshToken` transaction
creates a session and adds an authentication-method claim before issuing tokens.
The after-insert trigger on `auth.mfa_amr_claims`, restricted to method `password`,
records session ID (deduplication), account UUID and server statement time. Token
refreshes do not insert password claims. The event rolls back if the login transaction
fails. This measures committed password-authenticated sessions, not delivery of the
HTTP response to the client. Other sign-in methods are deliberately excluded.

Upstream references:
- https://github.com/supabase/auth/blob/master/internal/tokens/service.go
- https://github.com/supabase/auth/blob/master/internal/models/amr.go

The private table has RLS, no browser grants and no session foreign key: logout or
Auth cleanup cannot erase counted history. There are no emails, IPs or tokens.
A time index covers the account UUID; one 720-hour bounded read groups by account
and computes all rolling 24/168/720-hour counts. The existing administrator RPC
returns both series, alongside unchanged registration counts/list/pagination.
No existing financial lock or bot read is involved.

No historical backfill is attempted. A singleton records installation time and the
chart discloses that windows crossing it contain partial data. After 31 days, old
events are deleted in indexed batches of at most 100 during password logins, using
SKIP LOCKED. Idle installations retain old rows until later logins; analytics still
exclude them. The batch cap bounds work in the authentication path.

## Installation verification

The database owner must be able to create the trigger on the standard Supabase
Auth claim table. The migration fails if that prerequisite is absent; do not create
a replacement Auth table in production. Test fixtures must model auth.sessions and
auth.mfa_amr_claims, including session_id and authentication_method columns.

After applying, perform one successful password logout/login and manually refresh
Users analytics. Total logins should increase by one; another login by that same
account should increase total but not unique users. A wrong password and a token
refresh should not increase either. Verify no Auth errors before declaring rollout
complete. Local synthetic database tests cannot verify the hosted Auth version.

The trigger participates in the login transaction. If an unexpected integration
failure blocks sign-in, the database owner can disable only this trigger:

```sql
alter table auth.mfa_amr_claims disable trigger khub_record_password_login;
```

Before re-enabling after any recording gap, set login_recording.started_at to the
new start time and clear only the dedicated login_events table, in one transaction,
to avoid presenting incomplete recording as full coverage. Investigate first; do
not alter Supabase's own claims/sessions or financial tables.

Validation: disposable tests cover repeat sessions, deduplication, rollback,
refresh/recovery/MFA exclusions, rolling counts, logout independence, bounded
cleanup, administrator authorization and raw-table privacy. Frontend tests cover
adjacent bar values and the partial-history notice.
