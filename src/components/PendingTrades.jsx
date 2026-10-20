import { useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import { formatCompactMeat } from '../lib/formatMeat';

function TradeCard({ auction }) {
    const { currentUser } = useContext(UserContext);
    const { confirmTrade } = useContext(AuctionsContext);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const isSeller = auction.sellerId === currentUser.id;
    const confirmed = isSeller ? auction.sellerConfirmedAt : auction.buyerConfirmedAt;

    async function confirm() {
        if (pending || !window.confirm('Confirm only after you received the agreed items or Meat in KoL. This gives the other party a positive rating and notifies them by KMail. Has the other party completed the trade?')) return;
        setPending(true);
        setError('');
        try { await confirmTrade(auction.id); }
        catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }

    return <article className="min-w-0 space-y-2 rounded-lg border border-amber-300 bg-white p-4">
        <h3 className="break-words font-bold">{auction.quantity.toLocaleString('en-US')} × {auction.item}</h3>
        <p className="text-sm">Auction #{auction.auctionNumber || auction.id} · Direct settlement · {formatCompactMeat(auction.finalPrice)} Meat</p>
        <p className="text-sm">{isSeller ? 'You are the seller.' : 'You are the winning buyer.'}</p>
        {confirmed ? <p className="text-sm text-green-800">Your confirmation is saved. Waiting for the other party.</p> : <>
            <p className="text-sm">Did the other party complete the trade?</p>
            <div className="flex flex-wrap gap-2">
            <button onClick={confirm} disabled={pending} className="min-h-11 rounded bg-green-700 px-4 py-2 text-white disabled:opacity-50">{pending ? 'Saving…' : '👍 Yes, I received my side'}</button>
            {!auction.ownTradeReport && <Link to={`/auction/${auction.id}/report-trade`} className="inline-flex min-h-11 items-center rounded border border-red-700 bg-white px-4 py-2 text-red-700">👎 No, report a problem</Link>}
            </div>
        </>}
        <Link to={`/auction/${auction.id}`} className="flex min-h-11 items-center text-sm text-blue-700 underline">Private trade details and instructions</Link>
        {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}
    </article>;
}

export default function PendingTrades() {
    const { currentUser } = useContext(UserContext);
    const { pendingTrades = [], pendingTotal = 0, pendingPage = 1, setPendingPage, pendingError, refreshAuctions } = useContext(AuctionsContext);
    if (!currentUser) return null;
    const visibleTrades = pendingTrades.filter(auction => (!auction.ownTradeReport || auction.ownTradeReportWithdrawn) && !(auction.sellerId === currentUser.id ? auction.sellerConfirmedAt : auction.buyerConfirmedAt));
    const visibleTotal = Math.max(0, pendingTotal - (pendingTrades.length - visibleTrades.length));
    if (!visibleTotal && !pendingError) return null;
    return <section aria-label="Your pending trades" className="mb-6 space-y-3 rounded-lg border border-amber-400 bg-amber-50 p-4">
        <h2 className="text-xl font-bold">Trade awaiting your confirmation</h2>
        <p className="text-sm">{visibleTotal} pending {visibleTotal === 1 ? 'trade' : 'trades'}. Only confirm after receiving your side. A sale completes when both participants confirm.</p>
        {pendingError && <p role="alert" className="text-red-700">{pendingError} <button onClick={refreshAuctions} className="min-h-11 underline">Retry</button></p>}
        <div className="grid gap-3 md:grid-cols-2">{visibleTrades.map(auction => <TradeCard key={auction.id} auction={auction} />)}</div>
        {(visibleTotal > 12 || pendingPage > 1) && <nav aria-label="Pending trade pages" className="flex flex-wrap items-center justify-center gap-3">
            <button disabled={pendingPage <= 1} onClick={() => setPendingPage(pendingPage - 1)} className="min-h-11 rounded border bg-white px-3 disabled:opacity-50">Previous trades</button>
            <span>Page {pendingPage} of {Math.max(1, Math.ceil(visibleTotal / 12))}</span>
            <button disabled={pendingPage * 12 >= visibleTotal} onClick={() => setPendingPage(pendingPage + 1)} className="min-h-11 rounded border bg-white px-3 disabled:opacity-50">Next trades</button>
        </nav>}
    </section>;
}

TradeCard.propTypes = { auction: PropTypes.object.isRequired };
