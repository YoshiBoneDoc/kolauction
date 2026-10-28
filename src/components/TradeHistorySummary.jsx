import TradeHistoryHelp from './TradeHistoryHelp';
import PropTypes from 'prop-types';
import { formatCompactMeat } from '../lib/formatMeat';
import { reputationSummary } from '../lib/reputation';
import ThumbIcon from './ThumbIcon';

const count = value => value == null ? '—' : BigInt(value).toLocaleString('en-US');
const color = (value, positive = true) => BigInt(value ?? 0) > 0n ? positive ? 'text-green-700' : 'text-red-700' : 'text-gray-500';
const rowClass = 'mx-auto grid w-full max-w-sm grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1 text-center';

function MeatTotals({ sold, bought }) {
    const amount = value => value == null ? '—' : formatCompactMeat(value);
    return <div className="space-y-0.5 pt-3 text-xs text-gray-500">
        <h4 className="font-semibold text-black">Meat Totals</h4>
        <p className="flex items-center justify-center gap-1.5"><span><span className="public-profile-trade-stat">{amount(sold)}</span> <span className="public-profile-trade-label">Sold</span></span><span aria-hidden="true" className="public-profile-trade-label">·</span><span><span className="public-profile-trade-label">Bought</span> <span className="public-profile-trade-stat">{amount(bought)}</span></span></p>
    </div>;
}
MeatTotals.propTypes = { sold: PropTypes.oneOfType([PropTypes.string, PropTypes.number]), bought: PropTypes.oneOfType([PropTypes.string, PropTypes.number]) };

function DashboardStat({ label, value, positive = false }) {
    return <div className="public-profile-dashboard-stat">
        <dt>{label}</dt>
        <dd className={positive ? 'is-positive' : ''}>{value}</dd>
    </div>;
}
DashboardStat.propTypes = { label: PropTypes.string.isRequired, value: PropTypes.node.isRequired, positive: PropTypes.bool };

function DashboardCard({ title, children }) {
    return <section className="public-profile-dashboard-card">
        <h3>{title}</h3>
        <dl className="public-profile-dashboard-stat-list">{children}</dl>
    </section>;
}
DashboardCard.propTypes = { title: PropTypes.string.isRequired, children: PropTypes.node.isRequired };

function FeedbackCounts({ label, summary }) {
    return <div className="public-profile-feedback-group">
        <h4>{label}</h4>
        <div className="public-profile-feedback-counts">
            <span className="is-positive" aria-label={`${count(summary.positive)} positive feedback`}>
                <ThumbIcon /> <span>{count(summary.positive)}</span> <span>Positive</span>
            </span>
            <span className="is-negative" aria-label={`${count(summary.negative)} negative feedback`}>
                <ThumbIcon down /> <span>{count(summary.negative)}</span> <span>Negative</span>
            </span>
        </div>
    </div>;
}
FeedbackCounts.propTypes = {
    label: PropTypes.string.isRequired,
    summary: PropTypes.object.isRequired,
};

function DetailedTradeHistory({ stats, reputation }) {
    const amount = value => value == null ? '—' : `${formatCompactMeat(value)} Meat`;

    return <div className="public-profile-detailed-trade-history">
        <h2>Trade History</h2>
        <div className="public-profile-dashboard-cards">
            <DashboardCard title="Direct Trades">
                <DashboardStat label="Sales" value={count(stats.seller_confirmed)} positive />
                <DashboardStat label="Winning bids" value={count(stats.buyer_confirmed)} positive />
                <DashboardStat label="Meat sold" value={amount(stats.legacy_value)} />
                <DashboardStat label="Meat bought" value={amount(stats.direct_bought_value)} />
            </DashboardCard>
            <DashboardCard title="Escrow Trades">
                <DashboardStat label="Sales" value={count(stats.escrow_sales)} positive />
                <DashboardStat label="Winning bids" value={count(stats.escrow_buys)} positive />
                <DashboardStat label="Items sold" value={count(stats.escrow_units)} />
                <DashboardStat label="Meat sold" value={amount(stats.escrow_value)} />
                <DashboardStat label="Meat bought" value={amount(stats.escrow_bought_value)} />
            </DashboardCard>
            <div className="public-profile-buy-order-stack">
            <DashboardCard title="Buy Orders Created">
                <DashboardStat label="Orders created" value={count(stats.buy_orders_created)} positive />
                <DashboardStat label="Items bought" value={count(stats.buy_orders_bought_units)} />
                <DashboardStat label="Meat spent" value={amount(stats.buy_orders_spent)} />
            </DashboardCard>
            <DashboardCard title="Buy Orders Fulfilled">
                <DashboardStat label="Orders fulfilled" value={count(stats.buy_order_sales)} positive />
                <DashboardStat label="Items sold" value={count(stats.buy_order_units)} />
                <DashboardStat label="Meat earned" value={amount(stats.buy_order_value)} />
            </DashboardCard>
            </div>
        </div>

        <section className="public-profile-trade-feedback" aria-label="Trade feedback">
            <h3>Trade Feedback</h3>
            {reputation ? <div className="public-profile-feedback-grid">
                <FeedbackCounts label="Overall" summary={reputation.overall} />
                <FeedbackCounts label="As Seller" summary={reputation.seller} />
                <FeedbackCounts label="As Buyer" summary={reputation.buyer} />
            </div> : <p className="public-profile-feedback-unavailable">Feedback unavailable.</p>}
            <p className="public-profile-feedback-note">Feedback is separate from trade completion; a negative rating does not necessarily indicate an incomplete trade.</p>
            <details>
                <summary>How this works</summary>
                <TradeHistoryHelp />
            </details>
        </section>
    </div>;
}
DetailedTradeHistory.propTypes = { stats: PropTypes.object.isRequired, reputation: PropTypes.object };

export default function TradeHistorySummary({ stats, detailed = false }) {
    const reputation = reputationSummary(stats);
    const feedback = reputation?.overall;
    if (detailed) return <DetailedTradeHistory stats={stats} reputation={reputation} />;

    const buySales = BigInt(stats.buy_order_sales || 0) > 0n ? <section aria-label="Buy orders" className="public-profile-buy-orders space-y-1 text-sm"><h3 className="text-base font-bold text-gray-900">Buy Orders</h3><p className="public-profile-buy-stat"><span className="public-profile-trade-stat">{count(stats.buy_order_sales)}</span> <span className="public-profile-trade-label">orders filled ·</span> <span className="public-profile-trade-stat">{count(stats.buy_order_units)}</span> <span className="public-profile-trade-label">items sold</span></p><p className="public-profile-buy-stat"><span className="public-profile-trade-stat">{formatCompactMeat(BigInt(stats.buy_order_value || 0))} Meat</span> <span className="public-profile-trade-label">earned</span></p></section> : null;
    const directTrades = <section aria-label="Direct trades" className="space-y-2">
        <h3 className="text-base font-bold text-gray-900">Direct Trades</h3>
        <div className="space-y-1 text-sm text-gray-700">
            <p className={`${rowClass} whitespace-nowrap`}><span className={`font-medium ${color(stats.seller_confirmed)}`}>Sales: {count(stats.seller_confirmed)}</span><span aria-hidden="true" className="text-gray-400">·</span><span className={`text-xs ${color(stats.seller_incomplete, false)}`}>Incomplete: {count(stats.seller_incomplete)}</span></p>
            <p className={`${rowClass} whitespace-nowrap`}><span className={`font-medium ${color(stats.buyer_confirmed)}`}>Winning bids: {count(stats.buyer_confirmed)}</span><span aria-hidden="true" className="text-gray-400">·</span><span className={`text-xs ${color(stats.buyer_incomplete, false)}`}>Incomplete: {count(stats.buyer_incomplete)}</span></p>
        </div>
        <MeatTotals sold={stats.legacy_value} bought={stats.direct_bought_value} />
        <div className="pt-3">
            <h4 className="mb-0.5 text-xs font-bold leading-4 text-gray-700">Feedback</h4>
            {feedback ? <p className="flex items-center justify-center gap-2 text-sm">
                <span aria-label={`${feedback.positive} thumbs up`} className={`inline-flex items-center justify-center gap-1.5 font-medium ${color(feedback.positive)}`}>{count(feedback.positive)}<ThumbIcon className="h-5 w-5 shrink-0" /></span>
                <span aria-hidden="true" className="text-gray-400">·</span>
                <span aria-label={`${feedback.negative} thumbs down`} className={`inline-flex items-center justify-center gap-1.5 font-medium ${color(feedback.negative, false)}`}><ThumbIcon down className="h-5 w-5 shrink-0" />{count(feedback.negative)}</span>
            </p> : <p className="text-xs text-gray-500">Feedback unavailable.</p>}
            <details className="mt-2 text-xs text-gray-600">
                <summary className="cursor-pointer">How this works</summary>
                <TradeHistoryHelp />
            </details>
        </div>
    </section>;
    const escrowTrades = <section aria-label="Escrow trades" className="space-y-2 border-t border-gray-200 pt-5">
        <h3 className="text-base font-bold text-gray-900">Escrow Trades</h3>
        <div className="space-y-1">
            <p className={`text-sm font-medium ${color(stats.escrow_sales)}`}>Sales: {count(stats.escrow_sales)}</p>
            <p className={`text-sm font-medium ${color(stats.escrow_buys)}`}>Winning bids: {count(stats.escrow_buys)}</p>
        </div>
        <MeatTotals sold={stats.escrow_value} bought={stats.escrow_bought_value} />
    </section>;
    return <div className="space-y-6 text-center">
        <h2 className="text-xl font-bold text-gray-900">Trade History</h2>
        {directTrades}{escrowTrades}{buySales}
    </div>;
}
TradeHistorySummary.propTypes = { stats: PropTypes.object.isRequired, detailed: PropTypes.bool };
