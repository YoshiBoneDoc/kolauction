import BarterBidHistoryRow from '../components/BarterBidHistoryRow';
import BarterAcceptedBid from '../components/BarterAcceptedBid';
import { auctionQuantityLabel } from '../lib/bundles';
import ItemResources from '../components/ItemResources';
import SellerLink from '../components/SellerLink';
import { formatCompactMeat } from '../lib/formatMeat';
import { useContext, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import useBarterRead from '../hooks/useBarterRead';
import { useAuctionBoundaryNow } from '../hooks/useAuctionBoundaryNow';
import TradeTypeBadge from '../components/TradeTypeBadge';
import BarterSymbol from '../components/BarterSymbol';
import MarketPrice from '../components/MarketPrice';
import RemainingTime from '../components/RemainingTime';
import DirectTradeHelp from '../components/DirectTradeHelp';
import BarterOfferForm from '../components/BarterOfferForm';
import BarterOfferReview from '../components/BarterOfferReview';
import { offerDescription, writeBarter } from '../lib/barter';

export default function BarterDetails() {
    const { id } = useParams();
    const { currentUser } = useContext(UserContext);
    const [revision, setRevision] = useState(null);
    const [cancelling, setCancelling] = useState(false);
    const [cancelError, setCancelError] = useState('');
    const cancelLock = useRef(false);
    const offerForm = useRef(null);
    function reviseOffer(offer) {
        setRevision(previous => ({ offer, version: (previous?.version || 0) + 1 }));
        requestAnimationFrame(() => { offerForm.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); offerForm.current?.querySelector('input')?.focus({ preventScroll: true }); });
    }
    const [historyPage, setHistoryPage] = useState(1);
    const [privatePage, setPrivatePage] = useState(1);
    const [revisionsOpen, setRevisionsOpen] = useState(false);
    const [revisionPage, setRevisionPage] = useState(1);
    const { data: auction, error, refresh } = useBarterRead('read_barter_detail', { p_id: id, p_history_page: historyPage, p_private_page: privatePage });
    const revisions = useBarterRead('read_barter_revisions', { p_id: id, p_page: revisionPage }, Boolean(auction?.isHost && revisionsOpen));
    const firstOffers = useBarterRead('read_barter_detail', { p_id: id, p_history_page: historyPage, p_private_page: 1 }, Boolean(privatePage !== 1 && currentUser && !currentUser.isBanned && auction && !auction.isHost));
    const offerState = privatePage === 1 ? auction : firstOffers.data;
    const leadingHistory = useBarterRead('read_barter_detail', { p_id: id, p_history_page: 1, p_private_page: privatePage }, historyPage !== 1);
    const acceptedOffer = (historyPage === 1 ? auction : leadingHistory.data)?.history?.find(offer => offer.id === auction?.currentOfferId);
    const hasPendingOffer = offerState?.offers?.some(offer => offer.status === 'pending');
    const visibleOffers = auction?.isHost
        ? auction.offers.filter(offer => offer.status === 'pending')
        : (auction?.offers || []).slice().sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id)).slice(0, 1);
    const now = useAuctionBoundaryNow(auction ? [auction] : []);
    const active = auction && !auction.cancelled && auction.endTime > now;
    const mayBid = Boolean(currentUser && !currentUser.isBanned && !auction?.isHost && active && offerState && !hasPendingOffer);
    async function cancelListing() {
        if (cancelLock.current || !auction?.isHost || !active || auction.currentOfferId) return;
        if (!globalThis.confirm('Cancel this barter listing? All unaccepted offers will close. This cannot be undone.')) return;
        cancelLock.current = true; setCancelling(true); setCancelError('');
        try { await writeBarter('cancel_barter_auction', { p_auction: id }); }
        catch (failure) { setCancelError(failure.message); }
        finally { refresh(); cancelLock.current = false; setCancelling(false); }
    }
    return <main className="site-page-background flex-1 bg-[#F1F3F5] px-4 py-6 sm:px-6">
        <div className="mx-auto mb-4 max-w-4xl"><Link to="/barter" className="text-sm text-blue-700 underline">Back to Barter Corner</Link></div>
        {error && <p role="alert" className="mx-auto max-w-4xl">{error} <button onClick={refresh}>Retry</button></p>}
        {auction === undefined && !error && <p role="status">Loading barter…</p>}
        {auction === null && <p>Barter not found.</p>}
        {auction && <><div className="mx-auto max-w-4xl rounded-lg border border-gray-200 relative bg-white p-4 shadow-lg sm:p-6">
            <div className="absolute right-4 top-4 flex items-center gap-3 sm:right-6 sm:top-6"><TradeTypeBadge escrow={false} short /><BarterSymbol size={42} /></div>
            <section className="grid gap-x-6 gap-y-3 sm:grid-cols-[200px_minmax(0,1fr)]">
                <div className="min-w-0 space-y-2 text-center">
                    <img src={auction.image} alt={auction.item} className="mx-auto h-48 w-48 rounded-lg bg-white p-3 object-contain [image-rendering:pixelated]" />
                    <MarketPrice itemId={auction.itemId} quantity={auction.quantity} />
                </div>
                <div className="space-y-3">
                    <div className="space-y-1 pr-36">
                        <h1 className="break-words text-3xl font-bold text-blue-600 sm:text-4xl">{auction.item} <span className="text-xl text-gray-600">{auctionQuantityLabel(auction)}</span></h1>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
                            <ItemResources item={auction.item} itemId={auction.itemId} separator={false} />
                            <span aria-hidden="true">·</span>
                            <span title={auction.minimumValue == null ? 'No minimum bid market value' : `Offer value must exceed ${auction.minimumValue.toLocaleString('en-US')} Meat`}>Min: {auction.minimumValue == null ? 'None' : `${formatCompactMeat(auction.minimumValue)} Meat`}</span>
                        </div>

                    </div>
                    <BarterAcceptedBid offer={acceptedOffer} value={auction.currentBid} />
                </div>
            </section>
            <div className="mt-4 grid items-end gap-x-6 gap-y-2 pb-4 sm:grid-cols-[200px_minmax(0,1fr)]">
                <div className="text-sm text-gray-700 sm:col-start-2 sm:row-start-1">
                    <div className="space-y-2">
                    <p className="break-words">Sold by: <SellerLink auction={{ ...auction, owner: auction.host }} /></p>
                    {active ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="inline-flex rounded border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">Live</span>
                        <span aria-hidden="true" className="text-gray-400">·</span>
                        <p className={auction.endTime - now <= 10800000 ? 'text-red-700' : 'text-gray-600'}>Ends in <time dateTime={new Date(auction.endTime).toISOString()} title={new Date(auction.endTime).toLocaleString()}><RemainingTime endTime={auction.endTime} /></time></p>
                    </div> : <p>{auction.cancelled ? 'Cancelled' : auction.currentOfferId ? 'Ended — settle the accepted offer by Direct trade' : 'Ended without an accepted offer'}</p>}
                    {cancelError && <p role="alert" className="text-xs text-red-700">{cancelError}</p>}
                    </div>
                </div>
                <div className="min-w-0 sm:col-start-1 sm:row-start-1 sm:has-[details[open]]:col-span-2 sm:has-[details[open]]:row-start-2"><DirectTradeHelp forListing /></div>
            </div>
            <hr className="m-0 border-0 border-t border-gray-200" />
            {active && auction.isHost && currentUser && !currentUser.isBanned && <>
            <div className="grid gap-x-6 pt-4 pb-1 sm:grid-cols-[200px_minmax(0,1fr)]"><div className="sm:col-start-2">
                        <button type="button" disabled={cancelling || Boolean(auction.currentOfferId)} onClick={cancelListing} className="rounded border border-red-300 bg-transparent px-3 py-1.5 text-xs text-red-700 transition-colors enabled:hover:border-red-700 enabled:hover:bg-red-700 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-50">{cancelling ? 'Cancelling…' : 'Cancel listing'}</button>
                        {auction.currentOfferId && <p className="mt-1 text-xs text-gray-500">Listings cannot be cancelled after an offer has been accepted.</p>}
            </div></div></>}
            {!active && auction.currentOfferId && <p className="my-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm">The last accepted offer is the winning barter. The host and winning bidder arrange the exact item-and-Meat exchange directly. No assets are held or sent by kHub.</p>}
            {!active && auction.winningOffer && <section className="my-3 rounded border border-gray-200 p-3 text-sm"><h2 className="font-bold">Winning barter details</h2><p className="mt-1 text-xs">{offerDescription(auction.winningOffer)}</p><p className="mt-2">Host: {auction.host} (#{auction.hostKolId})</p><p>Winning bidder: {auction.winningOffer.bidder} (#{auction.winningOffer.bidderKolId})</p><Link to="/support" className="mt-2 inline-block text-xs text-blue-700 underline">Contact support about this barter</Link></section>}
            {active && !auction.isHost && hasPendingOffer && <p role="status" className="mx-auto mt-5 max-w-xl rounded border border-amber-200 bg-amber-50 p-3 text-sm">You already have a bid awaiting the host’s response. You cannot submit another bid on this auction while it is pending.</p>}
            {mayBid && <section ref={offerForm} className="mx-auto mt-5 max-w-xl rounded border border-gray-200 p-4"><BarterOfferForm key={`${auction.id}:${revision?.version || 0}`} initialOffer={revision?.offer} auction={auction} onSubmitted={success => { if (success) setRevision(null); refresh(); }} /></section>}
            {!currentUser && active && <p><Link to="/login" className="text-blue-700 underline">Log in</Link> to offer items and Meat.</p>}
            {currentUser && !currentUser.isBanned && (auction.isHost || auction.offers.length > 0) && <section className={`${auction.isHost ? 'mt-4' : 'mt-6'} border-t border-gray-200 pt-4`}><h2 className="mb-3 text-lg font-bold">{auction.isHost ? 'Review offers' : 'Your offers and host feedback'}</h2>
                <div className="space-y-3">{visibleOffers.slice(0, 20).map(offer => <BarterOfferReview key={offer.id} offer={offer} host={auction.isHost} active={Boolean(active)} current={offer.id === auction.currentOfferId} onUpdated={refresh} onRevise={mayBid ? reviseOffer : undefined} />)}</div>
                {!visibleOffers.length && <p className="text-sm text-gray-500">{auction.isHost ? 'No pending offers to review.' : 'No offers yet.'}</p>}
                {auction.isHost && <details className="mt-6 text-sm" onToggle={event => setRevisionsOpen(event.currentTarget.open)}>
                    <summary className="w-fit cursor-pointer text-white">Requested revisions</summary>
                    <div className="mt-3 space-y-3">
                        {revisions.error && <p role="alert">Revision history unavailable. <button type="button" onClick={revisions.refresh}>Retry</button></p>}
                        {!revisions.data && !revisions.error && <p role="status">Loading revisions…</p>}
                        {revisions.data?.slice(0, 20).map(offer => <div key={offer.id} className="space-y-2"><p className="text-xs text-gray-500">{offer.status === 'withdrawn' ? <span className="font-bold text-red-700 dark:text-red-300">Withdrawn:</span> : <span className="font-bold text-yellow-800 dark:text-yellow-300">Pending:</span>}</p><BarterOfferReview offer={offer} host active={false} current={false} onUpdated={refresh} /></div>)}
                        {revisions.data?.length === 0 && <p className="text-gray-500">No requested revisions.</p>}
                        {revisions.data && (revisionPage > 1 || revisions.data.length > 20) && <nav aria-label="Requested revision pages" className="flex gap-4 text-xs"><button disabled={revisionPage === 1} onClick={() => setRevisionPage(page => page - 1)}>Previous</button><span>Page {revisionPage}</span><button disabled={revisions.data.length <= 20} onClick={() => setRevisionPage(page => page + 1)}>Next</button></nav>}
                    </div>
                </details>}
                {auction.isHost && (privatePage > 1 || auction.offers.length > 20) && <nav aria-label="Private offer pages" className="mt-3 flex gap-4 text-xs"><button disabled={privatePage === 1} onClick={() => setPrivatePage(page => page - 1)}>Previous</button><span>Page {privatePage}</span><button disabled={auction.offers.length <= 20} onClick={() => setPrivatePage(page => page + 1)}>Next</button></nav>}
            </section>}
        </div>
            <section aria-label="Bid history" className="mx-auto mt-6 max-w-4xl rounded-lg border border-gray-200 bg-white p-4 shadow sm:p-6">
                <header className="mb-2 flex items-center justify-between gap-3 border-b border-gray-200 pb-4"><h2 className="text-xl font-bold text-gray-800">Bid History</h2><span className="text-xs text-gray-500">{currentUser && !currentUser.isBanned && !auction.isHost ? 'Accepted bids' : 'Accepted bids'}</span></header>
                <ul className="divide-y divide-gray-200">{auction.history.slice(0, 20).map(offer => <BarterBidHistoryRow key={offer.id} offer={offer} />)}</ul>
                {!auction.history.length && <p className="text-sm text-gray-500">No bids to show yet.</p>}
                {(historyPage > 1 || auction.history.length > 20) && <nav aria-label="Accepted bid history pages" className="mt-3 flex gap-4 text-xs"><button disabled={historyPage === 1} onClick={() => setHistoryPage(page => page - 1)}>Previous</button><span>Page {historyPage}</span><button disabled={auction.history.length <= 20} onClick={() => setHistoryPage(page => page + 1)}>Next</button></nav>}
            </section>
        </>}
    </main>;
}
