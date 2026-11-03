# kHub roadmap

Repository audit: November 2, 2026. Remaining work only; implementation is not proof
of production deployment. Start with [the handoff](HANDOFF.md:1).

## Traffic reliability — current priority

- Optimize private card/detail reads; inspect projection and bid-history costs.
- Investigate expensive public Home/browse queries with targeted execution plans.
- Measure cache misses, queue failures, origin timeouts and bid-invalidation churn
  against traffic, CPU, memory and connection charts. Preserve overload protection.
- Review redundant account/admin checks and idle bot polling without weakening
  access checks, financial locks or recovery safeguards.
- Split routes/catalog loading to reduce initial browser JavaScript.
- Improve safe error diagnostics and foreground read deadlines/priority.

## UI follow-up requiring owner review

- Confirm desired Meat-stack artwork beside totals and larger Trade totals title.
- Reproduce the reported seller-profile filter/navigation inconsistency. Current
  default is All; URL parameters control selection. Do not assume the old report
  still reproduces.

## Operations and reliability

- Verify actual deployed website/cache/bot versions and applied SQL prerequisites.
- Establish private bot release history and a verified last-working release.
- Configure external host availability alerts and private off-device backups,
  encrypted database backup retention/failure alerts, and an isolated restore drill.
- Define outage, late-bid and agreed Direct-trade extension policies and UI.

## Moderation and discovery

- Assess remaining abusive-listing/dispute adjudication gaps against existing ban,
  appeal, report, withdrawal and admin review tools; do not rebuild completed tools.
- Review dependency security alerts.
- Add seller-name search with existing identity/privacy restrictions.
- Extend seller history with reviewed withdrawal/default outcomes.
- Define a completed-sales gallery. Public trade totals and admin analytics already
  exist; any new public statistics must preserve buyer anonymity/accounting rules.

## Future features

- Item/Meat/mixed offers with acceptance, replacement and refund rules.
- Private offer review and unanswered-offer reminders.
- Auction/bid archival retaining financial and moderation evidence.
