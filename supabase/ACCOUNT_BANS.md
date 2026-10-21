# Account bans and appeals

Apply migrations through 050, then queued migration **051**, before deploying the associated website changes. New scripts are in `migrations/queue/`; move them only after applying them successfully. Do not rerun already-applied scripts. Keep the standalone bot's migration copy in sync.

## Administrator controls

Open **Administrator inbox → Account bans**. Search by username (with or without `KH_`) or exact KoL player number. Search returns up to 20 accounts.

Choose **Ban account**, select 24 hours, 7 days, 30 days, a custom local expiry, or permanent, and enter an administrator reason. The form identifies the affected account before the final confirmation. Existing bans have **Change ban** and **Lift ban** controls. Both actions require a reason and retain before/after audit records in the private `khub_bot.account_ban_activity` table. An administrator cannot ban their own account. These controls do not modify trade reports, feedback, completed counts, or ticket status.

All search and mutation RPCs independently verify administrator access on the server. Bans match the linked KoL identity. Temporary bans automatically stop applying at their expiry without a cleanup job. Database checks block trading and ordinary reporting immediately, including requests made with an existing session. The website rechecks account access every 15 seconds and on window focus.

## Restricted sign-in

Password authentication remains available so banned users can access the restricted account screen and `/submit-appeal`. The normal website is replaced by the banned-account screen, with a countdown for a temporary ban. This limited authentication does not restore trading or administrator permissions. Countdown time uses the server clock; only a successful server check restores access.

The application ban table is the source of truth. Migration 048 preserves existing site and native Supabase Auth bans before clearing native Auth restrictions, which would otherwise prevent appeal sign-in. Later native Auth ban updates for linked profiles are converted to application bans atomically. Use the website's **Lift ban** control to remove restrictions; clearing `auth.users.banned_until` alone does not lift an application ban. Setting the legacy `profiles.is_banned` flag creates an application restriction; the flag itself is no longer the current status. Use `read_my_account_access()` or the administrator controls to inspect the effective status.

Ban reasons and audit records stay private to administrators/operators; they are not automatically published on the Wall of Shame.

## Active auctions and existing obligations

Migration 051 reconciles existing bans and handles new restrictions atomically with bidding. The same rules apply to administrator bans, legacy profile flags and native Auth bans:

- Direct listings without accepted bids are cancelled. Direct auctions with bids become **On hold — admin review**. Saved bids remain intact; bidding and automatic winner selection stop.
- Lifting or expiring a ban does **not** restart a held auction. In **Administrator inbox → Auctions affected by bans**, an administrator can resume it after all affected bans are lifted, or cancel it without declaring a winner. Resuming preserves the remaining auction time (at least one minute). Reviewed cancellations use a separate internal `voided` state so they do not inflate **Canceled (before bids)** statistics.
- Existing direct trades stay awaiting settlement with a restriction notice. The unrestricted party may acknowledge assets already received. The administrator can explicitly record that either party received their side, with an evidence/review reason; both parties must be recorded complete before the trade becomes completed. An outstanding counted incomplete report by that party must first be reviewed and dismissed. Closing a support ticket, dismissing a report, or lifting a ban never implies completion. Banned users retain only restricted sign-in and appeals.
- Escrow listings awaiting a deposit are cancelled. Already-deposited listings without funded bids queue their normal item return. When a funded bid exists, the bot retains the original obligation and settles at the original deadline, even if a participant is banned. New bids and deposits for restricted sellers are rejected; incoming attachments use the normal refund ledger. A banned leading bidder on an unrestricted seller's escrow auction can still be outbid and refunded normally.

Review decisions and their before/after snapshots are private in `khub_bot.auction_ban_reviews`; affected participants receive KMail notices. Ban reasons are not included in public auction responses. Bans alone do not create incomplete reports, thumb ratings or completed-trade points. Existing reports and ratings remain subject to their separate review controls.

## Appeals and image evidence

The appeal form accepts 10–2,000 characters and one optional PNG, JPEG or WebP image up to 2 MiB. The image type, header and size are checked on the server. SVG is not accepted. Image evidence is stored in a private database table, not at a public URL. Evidence and the appeal are saved in one transaction; retries with the same request preserve idempotency. Existing submission throttling also applies to appeals.

Appeals appear under **Administrator inbox → Ban appeals**. Expand the conversation and select **View evidence image** to load it; images are not included in inbox list responses. The appeal text is also queued to teres Minor by KMail; image evidence is viewed in the website inbox. Closing an appeal does not lift a ban: use **Lift ban** after reviewing it.


## Manage a ban from its appeal (057)

Apply `migrations/queue/202610210057_appeal_account_controls.sql` after 056 and
deploy the website. Ban appeals, including resolved appeals, show the current
ban status/expiry and reason directly in their gray summary, with **Change ban** /
**Lift ban** buttons on the right. Details load automatically and refresh after a
change. Clicking the summary still expands/collapses the conversation; ban buttons
open their editing form independently. Expired or lifted restrictions display
**Not banned**. There is no separate account-management panel.

The administrator-only `read_appeal_account` RPC resolves the report's stored
reporter UUID, rather than searching a cached name or trusting a client account
ID. It returns no account for missing/non-appeal reports. Ban edits still require
an administrator reason and use the existing server checks and audit trail.
Changing/lifting a ban does not mark the conversation resolved or resume held
auctions. The normal Account bans search remains available. No bot update is
required; its matching SQL copy is included for fresh installations.


## Ban history in appeal conversations (058)

Apply `migrations/queue/202610210058_appeal_ban_history.sql` after 057 and deploy
the website. Appeal/reason previews remain single-line ellipses, and a reserved
action column keeps ban statuses aligned across summaries. Open an appeal to see
full ban reasons and exact timestamps mixed with its replies, newest first.

The admin-only `read_appeal_ban_history` RPC reads the appellant's existing ban
audit records, including inactive restrictions, and reports issued/updated/removed
restriction events. A removed restriction does not imply every ban on the account
was lifted; the summary always reads current effective status. Ban changes refresh
the open history. Legacy bans without creation audit events use their original
creation time and earliest preserved snapshot; operator-created events are labeled
Operator when no administrator is recorded. No support replies, KMail deliveries,
ban states or audit records are generated by opening history. No bot update is
required; the matching SQL copy is included for fresh installations.
