import { auctionQuantityLabel } from '../lib/bundles';
import { useContext, useEffect, useRef, useState } from 'react';
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
            <h3 className="text-sm font-semibold leading-5"><Link to={`/auction/${auction.id}`} title="Private trade details and instructions" className="break-words text-gray-900 hover:text-blue-700 hover:underline">{auction.bundleItems?.length > 1 ? <>{auction.item} {auctionQuantityLabel(auction)}</> : <>{auction.quantity.toLocaleString('en-US')} × {auction.item}</>}</Link></h3>
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
    const [selection, setSelection] = useState({ userId: currentUser?.id, index: 0 });
    const openedSummary = useRef(null);
    const { pendingExpanded = true, setPendingExpanded, pendingTrades = [], pendingTotal = 0, pendingUpdatedAt, pendingPage = 1, setPendingPage, pendingError, pendingHasLoaded = !pendingError || pendingTrades.length > 0, refreshAuctions } = useContext(AuctionsContext);
    useEffect(() => () => setPendingExpanded?.(false), [setPendingExpanded]);
    useEffect(() => {
        if (pendingExpanded && pendingHasLoaded && !pendingTotal && !pendingError) setPendingExpanded?.(false);
    }, [pendingExpanded, pendingHasLoaded, pendingTotal, pendingError, setPendingExpanded]);
    useEffect(() => {
        if (!currentUser || currentUser.isBanned || pendingExpanded || !pendingHasLoaded || pendingTotal <= 0 || pendingError) return;
        const summary = `${currentUser.id}:${pendingUpdatedAt ?? pendingTotal}`;
        if (openedSummary.current === summary) return;
        openedSummary.current = summary;
        setPendingExpanded?.(true);
    }, [currentUser, pendingExpanded, pendingHasLoaded, pendingTotal, pendingUpdatedAt, pendingError, setPendingExpanded]);
    if (!currentUser || currentUser.isBanned) return null;
    if (pendingError && !pendingHasLoaded) return <section aria-label="Your pending trades" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
        <p role="alert" className="text-red-700">Pending trades could not be loaded. <button onClick={refreshAuctions} className="min-h-11 underline">Retry</button></p>
    </section>;
    if (!pendingExpanded) return pendingTotal > 0 ? <section aria-label="Your pending trades" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
        <p role="status" className="text-sm">Loading trade details…</p>
        {pendingError && <p role="alert">Trade details could not be loaded. <button onClick={refreshAuctions} className="underline">Retry</button></p>}
    </section> : null;
    if (!pendingHasLoaded) return <section aria-label="Your pending trades" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3"><p role="status">Loading trade details…</p></section>;
    const visibleTrades = pendingTrades.filter(auction => !auction.escrowMode
        && ['awaiting_trade', 'completed'].includes(auction.status)
        && (auction.sellerId === currentUser.id || auction.winnerId === currentUser.id)
        && (hasResponded(auction, currentUser.id) ? auction.ownFeedback == null : auction.status === 'awaiting_trade'));
    const visibleTotal = Math.max(0, pendingTotal - (pendingTrades.length - visibleTrades.length));
    if (!visibleTotal && !pendingError) return null;
    const index = Math.min(selection.userId === currentUser.id ? selection.index : 0, Math.max(0, visibleTrades.length - 1));
    const selected = visibleTrades[index];
    const position = (pendingPage - 1) * 12 + index + 1;
    function move(direction) {
        const next = index + direction;
        if (next >= 0 && next < visibleTrades.length) setSelection({ userId: currentUser.id, index: next });
        else if (setPendingPage) {
            setSelection({ userId: currentUser.id, index: direction > 0 ? 0 : 11 });
            setPendingPage(pendingPage + direction);
        }
    }
    return <section aria-label="Your pending trades" className="mb-4 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold">{visibleTotal === 1 ? 'Trade' : 'Trades'} awaiting your response</h2>
            {visibleTotal > 1 && <nav aria-label="Browse pending trades" className="flex items-center gap-2 text-xs">
                <button type="button" aria-label="Previous pending trade" disabled={position <= 1 || index === 0 && !setPendingPage} onClick={() => move(-1)} className="inline-flex h-8 w-8 items-center justify-center rounded border border-amber-200 bg-transparent p-0 disabled:opacity-40">←</button>
                <span aria-live="polite" className="tabular-nums">{position} / {visibleTotal}</span>
                <button type="button" aria-label="Next pending trade" disabled={position >= visibleTotal || index === visibleTrades.length - 1 && !setPendingPage} onClick={() => move(1)} className="inline-flex h-8 w-8 items-center justify-center rounded border border-amber-200 bg-transparent p-0 disabled:opacity-40">→</button>
            </nav>}
        </div>
        <p className="text-xs leading-5 text-gray-600">{visibleTotal} pending {visibleTotal === 1 ? 'trade' : 'trades'} awaiting a trade response or optional experience rating.</p>
        {pendingError && <p role="alert" className="text-red-700">Refresh delayed. Showing previously loaded trades. <button onClick={refreshAuctions} className="min-h-11 underline">Retry</button></p>}
        {selected && <TradeCard key={selected.id} auction={selected} />}
    </section>;
}

TradeCard.propTypes = { auction: PropTypes.object.isRequired };
