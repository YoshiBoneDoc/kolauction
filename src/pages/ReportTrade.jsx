import { useContext, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import WithdrawTradeRating from '../components/WithdrawTradeRating';
import PropTypes from 'prop-types';
import { UserContext } from '../context/UserContext';
import { AuctionsContext } from '../context/AuctionsContext';
import AuctionNavigation from '../components/AuctionNavigation';
import SiteFooter from '../components/SiteFooter';
import { supabase } from '../lib/supabase';
import { BUG_REPORT_MAX_LENGTH, createBugReportService } from '../lib/bugReports';

const reports = createBugReportService(supabase);

function TradeReportForm({ auction }) {
    const { refreshAuctions } = useContext(AuctionsContext);
    const [body, setBody] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [reference, setReference] = useState('');
    const requestId = useRef(null);

    async function submit(event) {
        event.preventDefault();
        if (pending) return;
        if (!window.confirm('Give the other party a thumbs down? It counts on their profile immediately and notifies them by KMail. An administrator can exclude it after review.')) return;
        setPending(true);
        setError('');
        try {
            requestId.current ||= crypto.randomUUID();
            const result = await reports.submitTradeReport(requestId.current, auction.id, body);
            setReference(result.reference);
            await refreshAuctions();
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }

    if (reference) return <p role="status" className="rounded border border-green-300 bg-green-50 p-4">Thumbs-down saved: {reference}. Your response is recorded.</p>;
    return <form onSubmit={submit} className="space-y-3 rounded-lg border bg-white p-4 sm:p-6">
        <label htmlFor="trade-problem" className="block font-semibold">Explanation (optional)</label>
        <p id="trade-problem-help" className="text-sm text-gray-600">You can submit without an explanation. The other player receives a rating notification by KMail. Any explanation stays private to administrators, with a separate KMail copy to teres Minor. Please leave out passwords.</p>
        <textarea id="trade-problem" rows={8} maxLength={BUG_REPORT_MAX_LENGTH} disabled={pending}
            value={body} onChange={event => { setBody(event.target.value); setError(''); requestId.current = null; }}
            aria-describedby="trade-problem-help trade-problem-length" className="block w-full min-w-0 rounded border border-gray-400 p-3 text-base text-gray-900" />
        <p id="trade-problem-length" className="text-right text-xs text-gray-600">{body.length.toLocaleString('en-US')} / 2,000 characters</p>
        {error && <p role="alert" className="break-words text-red-700">{error}</p>}
        <button disabled={pending} className="min-h-11 rounded bg-red-700 px-5 py-3 font-semibold text-white disabled:opacity-50">{pending ? 'Saving…' : 'Submit thumbs down'}</button>
    </form>;
}
TradeReportForm.propTypes = { auction: PropTypes.object.isRequired };

export default function ReportTrade() {
    const { id } = useParams();
    const { currentUser, signedInUserId } = useContext(UserContext);
    const { auctions, isLoading, error } = useContext(AuctionsContext);
    const userId = signedInUserId || currentUser?.id;
    const auction = auctions.find(entry => String(entry.id) === id);
    const isSeller = Boolean(userId && auction?.sellerId === userId);
    const participant = Boolean(userId && auction && (isSeller || auction.winnerId === userId));
    const confirmed = isSeller ? auction?.sellerConfirmedAt : auction?.buyerConfirmedAt;
    const eligible = participant && !auction.escrowMode && auction.status === 'awaiting_trade' && auction.finalizedAt;

    return <div className="flex min-h-screen flex-col bg-gray-50">
        <div className="px-4 sm:px-6"><AuctionNavigation /></div>
        <main className="mx-auto w-full max-w-2xl flex-1 space-y-5 px-4 py-6 sm:px-6">
            <Link to={`/auction/${id}`} className="inline-flex min-h-11 items-center text-blue-700 underline">Back to auction</Link>
            <h1 className="text-3xl font-bold text-blue-700">Give thumbs down</h1>
            {isLoading ? <p role="status">Loading trade…</p> : error ? <p role="alert">This trade could not be loaded.</p>
                : !userId ? <p><Link to="/login" className="text-blue-700 underline">Log in</Link> as the seller or winning buyer to report a problem.</p>
                : !eligible ? <p>Only the seller or winning buyer of a direct sale awaiting settlement can submit a report.</p>
                : auction.ownTradeReport ? <div className="space-y-3"><p role="status">{auction.ownTradeReportWithdrawn ? 'Your earlier thumbs down was withdrawn.' : `Your thumbs-down response ${auction.ownTradeReport} is saved.`}</p>{!auction.ownTradeReportWithdrawn && <WithdrawTradeRating auctionId={auction.id} />}</div>
                : confirmed ? <p>You already confirmed this trade. Contact an administrator to request a reviewed correction.</p>
                : <>
                    <p className="break-words">Auction #{auction.auctionNumber || auction.id}: {auction.quantity.toLocaleString('en-US')} × {auction.item} · {auction.finalPrice.toLocaleString('en-US')} Meat</p>
                    <p className="text-sm text-gray-600">Your thumbs down counts on the other party’s profile immediately. An administrator can exclude it after review. It does not complete the sale or automatically ban anyone.</p>
                    <TradeReportForm key={`${id}:${userId}`} auction={auction} />
                </>}
        </main>
        <SiteFooter />
    </div>;
}
