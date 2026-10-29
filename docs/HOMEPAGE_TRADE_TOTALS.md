# Homepage totals

Apply [migration 150](../supabase/migrations/queue/202610290150_homepage_trade_totals.sql),
then deploy the website and public cache Worker through the existing Git workflows.
No bot update is required. Until the migration is applied and the homepage snapshot
refreshes, the totals row is omitted rather than displaying invented zero values.

The three figures are public lifetime aggregates:

- Meat: completed Sell final prices plus confirmed Buy fulfillment payments,
  excluding commissions, funding deposits, refunds and donations.
- Items: quantities from those trades; bundle components are summed individually.
- Trades: one per completed Sell auction and one per paid Buy fulfillment.
  Partial Buy-order purchases remain included if the order later expires or cancels.

An independent, nonblocking five-minute database snapshot is reused by both the
direct and shared-cache homepage reads. The browser makes no extra request for
these figures. The public cache allows only three nonnegative decimal strings;
no account balances, participant details or transaction records are shared.
The display may lag by the snapshot interval plus normal public-cache refresh.
These numbers never authorize any financial operation.

Icons are served locally; sources and artwork credits are in
[the icon README](../public/images/site-stats/README.md).
