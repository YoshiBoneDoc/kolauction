import { useContext, useId, useState } from 'react';
import ConfirmTradeButton from './ConfirmTradeButton';
import TradeFeedback from './TradeFeedback';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import { formatCompactMeat } from '../lib/formatMeat';

function hasResponded(auction, userId) {
    return Boolean((auction.sellerId === userId ? auction.sellerConfirmedAt || auction.sellerResolvedAt : auction.buyerConfirmedAt || auction.buyerResolvedAt) || auction.ownTradeReport);
}

function TradeCard({ auction }) {
    const { currentUser } = useContext(UserContext);
    const isSeller = auction.sellerId === currentUser.id;
    const responded = hasResponded(auction, currentUser.id);
    return <article className="flex min-w-0 flex-col gap-2 rounded border border-amber-200 bg-white px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-5"><Link to={`/auction/${auction.id}`} title="Private trade details and instructions" className="break-words text-gray-900 hover:text-blue-700 hover:underline">{auction.quantity.toLocaleString('en-US')} × {auction.item}</Link></h3>
            <p className="mt-0.5 text-xs leading-4 text-gray-500">#{auction.auctionNumber || auction.id} · {isSeller ? 'Seller' : 'Buyer'} · <span className="font-medium text-gray-700">{formatCompactMeat(auction.finalPrice)} Meat</span></p>
            {auction.banReviewRequired && <p className="mt-1 max-w-xl text-xs text-slate-600">Account restriction: contact an administrator before sending further assets. Only confirm what you have received.</p>}
        </div>
        <div className="shrink-0">
            {responded ? <TradeFeedback auctionId={auction.id} role={isSeller ? 'buyer' : 'seller'} rating={auction.ownFeedback} /> : <>
            <p className="mb-2 text-sm font-semibold">Was this trade completed?</p>
            <div className="flex flex-wrap items-center gap-2">
            <ConfirmTradeButton auctionId={auction.id} className="button-green inline-flex min-h-8 items-center justify-center rounded border border-green-700 bg-green-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50" />
            {!auction.ownTradeReport && <Link to={`/auction/${auction.id}/report-trade`} className="button-red inline-flex min-h-8 items-center justify-center rounded border px-3 py-1.5 text-xs font-medium">Report Incomplete</Link>}
            </div></>}
        </div>
    </article>;
}

export default function PendingTrades() {
    const { currentUser } = useContext(UserContext);
    const [expanded, setExpanded] = useState(false);
    const listId = useId();
    const { pendingTrades = [], pendingTotal = 0, pendingPage = 1, setPendingPage, pendingError, pendingHasLoaded = !pendingError || pendingTrades.length > 0, refreshAuctions } = useContext(AuctionsContext);
    if (!currentUser || currentUser.isBanned) return null;
    if (pendingError && !pendingHasLoaded) return <section aria-label="Your pending trades" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
        <p role="alert" className="text-red-700">Pending trades could not be loaded. <button onClick={refreshAuctions} className="min-h-11 underline">Retry</button></p>
    </section>;
    const visibleTrades = pendingTrades.filter(auction => !auction.escrowMode
        && ['awaiting_trade', 'completed'].includes(auction.status)
        && (auction.sellerId === currentUser.id || auction.winnerId === currentUser.id)
        && (hasResponded(auction, currentUser.id) ? auction.ownFeedback == null : auction.status === 'awaiting_trade'));
    const visibleTotal = Math.max(0, pendingTotal - (pendingTrades.length - visibleTrades.length));
    if (!visibleTotal && !pendingError) return null;
    const displayedTrades = expanded ? visibleTrades : visibleTrades.slice(0, 3);
    return <section aria-label="Your pending trades" className="mb-4 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
        <h2 className="text-base font-bold">{visibleTotal === 1 ? 'Trade' : 'Trades'} awaiting your response</h2>
        <p className="text-xs leading-5 text-gray-600">{visibleTotal} pending {visibleTotal === 1 ? 'trade' : 'trades'} awaiting a trade response or optional experience rating.</p>
        {pendingError && <p role="alert" className="text-red-700">Refresh delayed. Showing previously loaded trades. <button onClick={refreshAuctions} className="min-h-11 underline">Retry</button></p>}
        <div id={listId} className="space-y-2">{displayedTrades.map(auction => <TradeCard key={auction.id} auction={auction} />)}</div>
        {visibleTrades.length > 3 && <button type="button" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)} className="min-h-8 text-xs font-medium text-blue-700 underline hover:text-blue-800">{expanded ? 'Show fewer trades' : `Show ${visibleTrades.length - 3} more ${visibleTrades.length - 3 === 1 ? 'trade' : 'trades'}`}</button>}
        {(visibleTotal > 12 || pendingPage > 1) && (expanded || visibleTrades.length <= 3) && <nav aria-label="Pending trade pages" className="flex flex-wrap items-center justify-center gap-3">
            <button disabled={pendingPage <= 1} onClick={() => { setExpanded(false); setPendingPage(pendingPage - 1); }} className="min-h-11 rounded border bg-white px-3 disabled:opacity-50">Previous trades</button>
            <span>Page {pendingPage} of {Math.max(1, Math.ceil(visibleTotal / 12))}</span>
            <button disabled={pendingPage * 12 >= visibleTotal} onClick={() => { setExpanded(false); setPendingPage(pendingPage + 1); }} className="min-h-11 rounded border bg-white px-3 disabled:opacity-50">Next trades</button>
        </nav>}
    </section>;
}

TradeCard.propTypes = { auction: PropTypes.object.isRequired };
