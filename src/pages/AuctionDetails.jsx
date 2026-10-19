import { useContext } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import AuctionOutcome from '../components/AuctionOutcome';
import AuctionBidForm from '../components/AuctionBidForm';
import InstantPurchaseAction from '../components/InstantPurchaseAction';
import { getAuctionResult } from '../lib/auctionLifecycle';
import { timeRemaining } from '../lib/auctionBrowsing';
import { useNow } from '../hooks/useNow';

export default function AuctionDetails() {
    const { id } = useParams();
    const { state } = useLocation();
    const browseFrom = state?.browseFrom;
    const backTo = typeof browseFrom === 'string' && (browseFrom === '/auctions' || browseFrom.startsWith('/auctions?')) ? browseFrom : '/auctions';
    const { auctions, isLoading, error } = useContext(AuctionsContext);
    const now = useNow();
    const auction = auctions.find((listing) => String(listing.id) === id);

    if (isLoading) return <p role="status" className="p-6">Loading auction…</p>;
    if (!auction) return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-4">
            <p className="text-xl font-bold text-red-700">{error ? 'Auction could not be loaded.' : 'Auction not found.'}</p>
            <Link to={backTo} className="flex min-h-11 items-center text-blue-700 underline">Back to Auctions</Link>
        </main>
    );

    const result = getAuctionResult(auction, now);
    const active = result.status === 'active';
    const price = result.finalPrice ?? auction.currentBid;
    return (
        <main className="min-h-screen bg-gray-50 p-4 sm:p-6">
            <div className="mx-auto mb-4 max-w-4xl">
                <Link to={backTo} className="inline-flex min-h-11 items-center text-sm text-blue-700 underline">Back to Auctions</Link>
            </div>
            <div className="mx-auto max-w-4xl rounded-lg bg-white p-4 shadow-lg sm:p-6">
                <div className="grid min-w-0 grid-cols-1 gap-6 md:grid-cols-2">
                    <div className="min-w-0 space-y-4 text-center md:col-start-2 md:row-start-1">
                        <h1 className="break-words text-3xl font-bold text-blue-600 sm:text-4xl">{auction.item} <span className="text-xl text-gray-600">×{auction.quantity.toLocaleString('en-US')}</span></h1>
                        {auction.auctionNumber && <p className="text-sm text-gray-600">Auction #{auction.auctionNumber}</p>}
                        <p className="text-sm text-gray-600">Minimum Bid (Meat): {auction.minBidMeat.toLocaleString('en-US')}</p>
                        <div>
                            <p className="text-sm text-gray-600">{active ? 'Current Bid' : result.winnerId ? 'Final price' : 'Last Bid'}</p>
                            <p className="break-words text-2xl font-extrabold text-gray-900 sm:text-3xl">{price ? `${price.toLocaleString('en-US')} Meat` : 'No bids yet'}</p>
                        </div>
                        <p className="break-words text-sm text-gray-700">Sold by: <strong>{auction.owner || 'Unknown'}</strong></p>
                        <p className={`text-sm ${active && auction.endTime - now <= 10800000 ? 'text-red-700' : 'text-gray-600'}`}>
                            {active ? <>Ends in <time dateTime={new Date(auction.endTime).toISOString()}>{timeRemaining(auction.endTime, now)}</time></> : result.label}
                        </p>
                    </div>
                    <div className="flex min-w-0 flex-col items-center gap-4 md:col-start-1 md:row-start-1">
                        {auction.image ? <img src={auction.image} alt={auction.item} className="h-32 w-32 object-contain sm:h-48 sm:w-48" /> : <p className="text-gray-500">No Image Available</p>}
                        {active && <div className="w-full"><InstantPurchaseAction key={`purchase-${auction.id}`} auction={auction} /><AuctionBidForm key={auction.id} auction={auction} /></div>}
                    </div>
                </div>
            </div>
            <AuctionOutcome key={auction.id} auction={auction} now={now} />
            <section aria-label="Bid history" className="mx-auto mt-6 max-w-4xl rounded-lg bg-white p-4 shadow sm:p-6">
                <h2 className="mb-4 text-2xl font-bold text-gray-800">Bid History</h2>
                {auction.bids?.length ? <ul className="divide-y divide-gray-200">
                    {auction.bids.slice().reverse().map((bid, index) => (
                        <li key={bid.id || index} className="flex flex-col gap-1 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                            <span className="min-w-0 break-words font-medium text-gray-700">{bid.bidder}</span>
                            <div className="sm:text-right">
                                <p className="font-bold text-gray-900">{bid.amount.toLocaleString('en-US')} Meat</p>
                                {auction.instantPurchasedAt && bid.bidderId === auction.winnerId && bid.amount === auction.instantPurchasePrice && <p className="text-xs font-semibold text-green-800">Instant purchase</p>}
                                <p className="text-xs text-gray-600">{new Date(bid.timestamp).toLocaleString()}</p>
                            </div>
                        </li>
                    ))}
                </ul> : <p className="text-gray-600">No bids yet.</p>}
            </section>
        </main>
    );
}
