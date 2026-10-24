import { useContext, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import PropTypes from 'prop-types';
import { UserContext } from '../context/UserContext';
import { AuctionsContext } from '../context/AuctionsContext';
import SiteFooter from '../components/SiteFooter';
import { supabase } from '../lib/supabase';
import { BUG_REPORT_MAX_LENGTH, createBugReportService } from '../lib/bugReports';
import { canSendTradeQuery } from '../lib/tradeQueries';

const reports = createBugReportService(supabase);

function TradeQueryForm({ auction }) {
    const { refreshAuctions } = useContext(AuctionsContext);
    const [body, setBody] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [reference, setReference] = useState('');
    const requestId = useRef(null);

    async function submit(event) {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setError('');
        try {
            requestId.current ||= crypto.randomUUID();
            const result = await reports.submitTradeQuery(requestId.current, auction.id, body);
            setReference(result.reference);
            await refreshAuctions();
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }

    if (reference) return <p role="status" className="rounded border border-green-300 bg-green-50 p-4">Trade query saved: {reference}. An administrator can review your concern.</p>;
    return <form onSubmit={submit} className="space-y-3 rounded-lg border bg-white p-4 sm:p-6">
        <label htmlFor="trade-problem" className="block font-semibold">What would you like the administrator to review?</label>
        <p id="trade-problem-help" className="text-sm text-gray-600">{auction.escrowMode ? 'Describe your concern, including any relevant KMail or delivery details.' : 'Describe your concern and any attempts to resolve it with the other party.'} Your message is private to administrators. {auction.escrowMode ? 'Sending a query does not change payments or delivery status.' : 'Contacting an administrator does not change trade responses or feedback ratings.'}</p>
        <textarea id="trade-problem" rows={8} required minLength={10} maxLength={BUG_REPORT_MAX_LENGTH} disabled={pending}
            value={body} onChange={event => { setBody(event.target.value); setError(''); requestId.current = null; }}
            aria-describedby="trade-problem-help trade-problem-length" className="block w-full min-w-0 rounded border border-gray-400 p-3 text-base text-gray-900" />
        <p id="trade-problem-length" className="text-right text-xs text-gray-600">{body.length.toLocaleString('en-US')} / 2,000 characters</p>
        {error && <p role="alert" className="break-words text-red-700">{error}</p>}
        <button disabled={pending} className="button-red min-h-11 rounded px-5 py-3 font-semibold disabled:opacity-50">{pending ? 'Saving…' : 'Send trade query'}</button>
    </form>;
}
TradeQueryForm.propTypes = { auction: PropTypes.object.isRequired };

export default function TradeQuery() {
    const { id } = useParams();
    const { currentUser, signedInUserId } = useContext(UserContext);
    const { auctions, isLoading, error } = useContext(AuctionsContext);
    const userId = signedInUserId || currentUser?.id;
    const auction = auctions.find(entry => String(entry.id) === id);
    const eligible = canSendTradeQuery(auction, currentUser);

    return <div className="site-page-background flex flex-1 flex-col bg-gray-50">
        <main className="mx-auto w-full max-w-2xl flex-1 space-y-5 px-4 py-6 sm:px-6">
            <Link to={`/auction/${id}`} className="inline-flex min-h-11 items-center text-blue-700 underline">Back to auction</Link>
            <h1 className="text-3xl font-bold text-blue-700">Trade query</h1>
            {isLoading ? <p role="status">Loading trade…</p> : error ? <p role="alert">This trade could not be loaded.</p>
                : !userId ? <p><Link to="/login" className="text-blue-700 underline">Log in</Link> as the seller or winning buyer to report a problem.</p>
                : !eligible ? <p>Trade queries are available to the seller of an Escrow listing, or the seller and winning buyer after a sale closes. An unrestricted account is required.</p>
                : <>
                    <p className="break-words">Auction #{auction.auctionNumber || auction.id}: {auction.quantity.toLocaleString('en-US')} × {auction.item} · {auction.escrowMode ? 'Escrow' : 'Direct Trade'}{auction.finalPrice != null && <> · {auction.finalPrice.toLocaleString('en-US')} Meat</>}</p>
                    <p className="text-sm text-gray-600">{auction.escrowMode ? 'Send a private query about this auction to the administrator inbox.' : 'Please try to resolve the trade with the other party first. If you still have concerns, send a private query to the administrator inbox.'}</p>
                    <TradeQueryForm key={`${id}:${userId}`} auction={auction} />
                </>}
        </main>
        <SiteFooter />
    </div>;
}
