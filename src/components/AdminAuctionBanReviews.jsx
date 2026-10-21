import { useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { createAccountRestrictionService } from '../lib/accountRestrictions';
import { supabase } from '../lib/supabase';

const accounts = createAccountRestrictionService(supabase);
function AuctionReview({ auction, onUpdated }) {
    const [action, setAction] = useState('');
    const [reason, setReason] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    async function submit(event) {
        event.preventDefault();
        if (pending) return;
        setPending(true); setError(''); setNotice('');
        try {
            await accounts.reviewAuction(auction.id, action, reason);
            setAction(''); setReason(''); setNotice('Review saved.');
            await onUpdated();
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    return <article className="space-y-2 rounded border border-gray-200 bg-white p-3 text-sm">
        <div className="flex flex-wrap justify-between gap-2">
            <Link className="font-semibold text-blue-700 underline" to={`/auction/${auction.id}`}>#{auction.number} · {auction.item}</Link>
            <span className="text-slate-600">{auction.status === 'on_hold' ? 'Bidding paused' : 'Existing trade'}</span>
        </div>
        <p>Seller: <strong>{auction.seller}</strong>{auction.seller_banned ? ' · banned' : ''}{auction.seller_complete ? ' · received their side' : ''}</p>
        <p>Buyer: <strong>{auction.buyer}</strong>{auction.buyer_banned ? ' · banned' : ''}{auction.buyer_complete ? ' · received their side' : ''}</p>
        {!action ? <div className="flex flex-wrap gap-2 pt-1">
            <button disabled={auction.seller_banned || auction.buyer_banned} onClick={() => setAction('resume')} className="rounded border border-gray-300 px-3 py-1 text-gray-700 disabled:opacity-50">{auction.status === 'on_hold' ? 'Resume auction' : 'Release review'}</button>
            {auction.status === 'on_hold' ? <button onClick={() => setAction('cancel')} className="button-red rounded border px-3 py-1">Cancel auction</button> : <>
                {!auction.seller_complete && <button onClick={() => setAction('seller_complete')} className="button-green rounded border border-green-200 bg-green-50 px-3 py-1 text-green-800">Record seller received their side</button>}
                {!auction.buyer_complete && <button onClick={() => setAction('buyer_complete')} className="button-green rounded border border-green-200 bg-green-50 px-3 py-1 text-green-800">Record buyer received their side</button>}
            </>}
        </div> : <form onSubmit={submit} className="space-y-2 border-t border-gray-100 pt-3">
            <p className="font-semibold">{action === 'cancel' ? 'Cancel this held auction without declaring a winner?' : action === 'resume' ? 'Release this auction from review?' : `Record that the ${action === 'seller_complete' ? 'seller' : 'buyer'} received everything owed to them?`}</p>
            {action.endsWith('_complete') && <p className="text-xs text-gray-600">Only record completion after reviewing evidence that the exchange happened. Closing a ticket or dismissing a report is not proof of completion. Both sides must be complete for a completed-trade count.</p>}
            <label className="block">Review reason / evidence
                <textarea required minLength={3} maxLength={1000} rows={2} value={reason} disabled={pending} onChange={event => setReason(event.target.value)} className="mt-1 block w-full rounded border border-gray-300 p-2" />
            </label>
            <div className="flex gap-3">
                <button disabled={pending} className="rounded border border-blue-700 bg-blue-700 px-3 py-1 text-white disabled:opacity-50">{pending ? 'Saving…' : 'Save decision'}</button>
                <button type="button" disabled={pending} onClick={() => setAction('')} className="text-gray-600 underline">Back</button>
            </div>
        </form>}
        {notice && <p role="status" className="text-green-700">{notice}</p>}
        {error && <p role="alert" className="text-red-700">{error}</p>}
    </article>;
}
AuctionReview.propTypes = { auction: PropTypes.object.isRequired, onUpdated: PropTypes.func.isRequired };

export default function AdminAuctionBanReviews() {
    const [auctions, setAuctions] = useState(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function refresh() {
        setPending(true); setError('');
        try { setAuctions(await accounts.auctions()); }
        catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    return <details onToggle={event => { if (event.currentTarget.open && auctions === null && !pending) refresh(); }} className="rounded-lg border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold text-gray-800">Auctions affected by bans</summary>
        <div className="mt-3 space-y-3">
            <div className="flex items-start justify-between gap-3">
                <p className="text-xs text-gray-600">Held direct auctions require an explicit decision. Lift affected bans before resuming. Already-funded escrow obligations continue through the bot.</p>
                <button disabled={pending} onClick={refresh} className="shrink-0 text-xs text-blue-700 underline disabled:opacity-50">{pending ? 'Loading…' : 'Refresh'}</button>
            </div>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            {auctions?.length === 0 && <p className="text-sm text-gray-500">No auctions awaiting review.</p>}
            {auctions?.map(auction => <AuctionReview key={auction.id} auction={auction} onUpdated={refresh} />)}
        </div>
    </details>;
}
