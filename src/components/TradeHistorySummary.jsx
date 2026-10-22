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
        <p className="flex items-center justify-center gap-1.5"><span>{amount(sold)} Sold</span><span aria-hidden="true" className="text-gray-400">·</span><span>Bought {amount(bought)}</span></p>
    </div>;
}
MeatTotals.propTypes = { sold: PropTypes.oneOfType([PropTypes.string, PropTypes.number]), bought: PropTypes.oneOfType([PropTypes.string, PropTypes.number]) };

function TradeValue({ value, positive = true }) {
    return <span className={`mt-0.5 block text-xs ${color(value, positive)}`} title={value == null ? undefined : `${count(value)} Meat`}>
        {value == null ? '—' : `${formatCompactMeat(value)} Meat`}
    </span>;
}
TradeValue.propTypes = { value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]), positive: PropTypes.bool };

function DetailedTradeValues({ stats }) {
    return <div aria-label="Direct trade counts and values" className="space-y-4 pt-1">
        {[
            ['Sales', stats.seller_confirmed, stats.legacy_value, stats.seller_incomplete, stats.seller_incomplete_value],
            ['Winning bids', stats.buyer_confirmed, stats.direct_bought_value, stats.buyer_incomplete, stats.buyer_incomplete_value],
        ].map(([label, completed, completedValue, incomplete, incompleteValue]) => <div key={label} className={rowClass}>
            <div><p className={`text-sm font-medium ${color(completed)}`}>{label}: {count(completed)}</p><TradeValue value={completedValue} /></div>
            <span aria-hidden="true" className="self-start text-gray-400">·</span>
            <div><p className={`text-xs ${color(incomplete, false)}`}>Incomplete: {count(incomplete)}</p><TradeValue value={incompleteValue} positive={false} /></div>
        </div>)}
        <p className="text-xs text-gray-500">Meat values use the agreed price of each trade.</p>
    </div>;
}
DetailedTradeValues.propTypes = { stats: PropTypes.object.isRequired };

export default function TradeHistorySummary({ stats, detailed = false }) {
    const reputation = reputationSummary(stats);
    const feedback = reputation?.overall;
    const buySales = BigInt(stats.buy_order_sales || 0) > 0n ? <section aria-label="Buy order sales" className="space-y-1 text-sm"><h3 className="font-bold">Sales to Buy Orders</h3><p>{count(stats.buy_order_sales)} fulfillments · {count(stats.buy_order_units)} items</p><p>{formatCompactMeat(BigInt(stats.buy_order_value || 0))} Meat paid to seller</p></section> : null;
    const directTrades = <section aria-label="Direct trades" className={detailed ? 'space-y-2 rounded-lg border border-gray-200 bg-gray-50/50 p-5' : 'space-y-2'}>
            <h3 className="text-base font-bold text-gray-900">Direct Trades</h3>
            {detailed ? <DetailedTradeValues stats={stats} /> : <>
            <div className="space-y-1 text-sm text-gray-700">
                <p className={`${rowClass} whitespace-nowrap`}><span className={`font-medium ${color(stats.seller_confirmed)}`}>Sales: {count(stats.seller_confirmed)}</span><span aria-hidden="true" className="text-gray-400">·</span><span className={`text-xs ${color(stats.seller_incomplete, false)}`}>Incomplete: {count(stats.seller_incomplete)}</span></p>
                <p className={`${rowClass} whitespace-nowrap`}><span className={`font-medium ${color(stats.buyer_confirmed)}`}>Winning bids: {count(stats.buyer_confirmed)}</span><span aria-hidden="true" className="text-gray-400">·</span><span className={`text-xs ${color(stats.buyer_incomplete, false)}`}>Incomplete: {count(stats.buyer_incomplete)}</span></p>
            </div>
            <MeatTotals sold={stats.legacy_value} bought={stats.direct_bought_value} />
            </>}
            <div className="pt-3">
                <h4 className="mb-0.5 text-xs font-bold leading-4 text-gray-700">Feedback</h4>
                {feedback ? <p className="flex items-center justify-center gap-2 text-sm">
                    <span aria-label={`${feedback.positive} thumbs up`} className={`inline-flex items-center justify-center gap-1.5 font-medium ${color(feedback.positive)}`}>{count(feedback.positive)}<ThumbIcon className="h-5 w-5 shrink-0" /></span>
                    <span aria-hidden="true" className="text-gray-400">·</span>
                    <span aria-label={`${feedback.negative} thumbs down`} className={`inline-flex items-center justify-center gap-1.5 font-medium ${color(feedback.negative, false)}`}><ThumbIcon down className="h-5 w-5 shrink-0" />{count(feedback.negative)}</span>
                </p> : <p className="text-xs text-gray-500">Feedback unavailable.</p>}
                {detailed && feedback && <div className="mx-auto mt-3 max-w-sm">
                    <table className="w-full text-sm">
                        <caption className="sr-only">Independent feedback by trading role</caption>
                        <thead><tr className="border-b border-gray-200 text-xs text-gray-500">
                            <th scope="col" className="py-1 text-left font-medium">Role</th>
                            <th scope="col" className="py-1 font-medium"><span className="inline-flex items-center gap-1"><ThumbIcon className="h-4 w-4" /><span className="sr-only">Thumbs up</span></span></th>
                            <th scope="col" className="py-1 font-medium"><span className="inline-flex items-center gap-1"><ThumbIcon down className="h-4 w-4" /><span className="sr-only">Thumbs down</span></span></th>
                        </tr></thead>
                        <tbody>{['seller', 'buyer'].map(role => <tr key={role} className="border-b border-gray-100 last:border-0">
                            <th scope="row" className="py-1.5 text-left text-xs font-medium text-gray-600">As {role === 'seller' ? 'Seller' : 'Buyer'}</th>
                            <td className={`py-1.5 ${color(reputation[role].positive)}`}>{count(reputation[role].positive)}</td>
                            <td className={`py-1.5 ${color(reputation[role].negative, false)}`}>{count(reputation[role].negative)}</td>
                        </tr>)}</tbody>
                    </table>
                </div>}
                <details className="mt-2 text-xs text-gray-600">
                    <summary className="cursor-pointer">How this works</summary>
                    <TradeHistoryHelp />
                </details>
            </div>
        </section>;
    const escrowTrades = <section aria-label="Escrow trades" className={detailed ? 'space-y-2 rounded-lg border border-gray-200 bg-gray-50/50 p-5' : 'space-y-2 border-t border-gray-200 pt-5'}>
            <h3 className="text-base font-bold text-gray-900">Escrow Trades</h3>
            {detailed ? <div aria-label="Escrow trade counts and values" className="space-y-4 pt-1">
                <div><p className={`text-sm font-medium ${color(stats.escrow_sales)}`}>Sales: {count(stats.escrow_sales)}</p><TradeValue value={stats.escrow_value} /></div>
                <div><p className={`text-sm font-medium ${color(stats.escrow_buys)}`}>Winning bids: {count(stats.escrow_buys)}</p><TradeValue value={stats.escrow_bought_value} /></div>
            </div> : <>
                <div className="space-y-1">
                    <p className={`text-sm font-medium ${color(stats.escrow_sales)}`}>Sales: {count(stats.escrow_sales)}</p>
                    <p className={`text-sm font-medium ${color(stats.escrow_buys)}`}>Winning bids: {count(stats.escrow_buys)}</p>
                </div>
                <MeatTotals sold={stats.escrow_value} bought={stats.escrow_bought_value} />
            </>}
            {detailed && <p className="pt-3 text-xs text-gray-500">{count(stats.escrow_units)} item units sold · Bot-verified trades</p>}
        </section>;
    return <div className="space-y-6 text-center">
        <h2 className="text-xl font-bold text-gray-900">Trade History</h2>
        {detailed ? <div className="grid items-start gap-5 md:grid-cols-2">{directTrades}{buySales}{escrowTrades}</div> : <>{directTrades}{buySales}{escrowTrades}</>}
    </div>;
}
TradeHistorySummary.propTypes = { stats: PropTypes.object.isRequired, detailed: PropTypes.bool };
