import { useContext, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { popularActiveAuctions, timeRemaining } from '../lib/auctionBrowsing';
import { useNow } from '../hooks/useNow';
import AuctionNavigation from '../components/AuctionNavigation';

export default function Home() {
    const { auctions, total, isLoading, error } = useContext(AuctionsContext);
    const now = useNow();
    const popular = useMemo(() => popularActiveAuctions(auctions, now), [auctions, now]);
    const displayed = popular.slice(0, 4);

    return (
        <div className="flex min-h-screen w-full flex-col bg-[#F9F9F9] px-4 sm:px-6">
            <AuctionNavigation />
            <header className="mx-auto w-full max-w-6xl border-b border-gray-300 pb-6 text-center">
                <h1 className="mt-4 text-4xl font-extrabold text-[#7695FF] sm:text-6xl">KoL Auction Hub <span className="text-sm">Beta</span></h1>
                <p className="mt-4 text-lg text-gray-700 sm:text-xl">The best place to find and bid on rare treasures.</p>
            </header>
            <main className="mx-auto mt-6 w-full max-w-6xl flex-1 pb-8">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-2xl font-bold text-gray-700">Popular Items</h2>
                    <Link to="/auctions" className="flex min-h-11 items-center text-blue-700 underline">Browse active auctions</Link>
                </div>
                <p className="mb-4 text-sm text-gray-600">Active listings, ranked by number of bids.</p>
                {isLoading && <p role="status">Loading auctions…</p>}
                {!isLoading && !error && popular.length === 0 && <p>No active auctions right now. <Link to="/auctions?status=all" className="text-blue-700 underline">Browse auction history</Link> or <Link to="/auction-item" className="text-blue-700 underline">list an item</Link>.</p>}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {displayed.map((auction) => (
                        <Link key={auction.id} to={`/auction/${auction.id}`} className="flex min-w-0 items-center gap-3 rounded-md border bg-[#F8F6F4] p-4 shadow transition-shadow hover:shadow-lg">
                            {auction.image && <img src={auction.image} alt="" loading="lazy" className="h-12 w-12 shrink-0 object-contain" />}
                            <div className="min-w-0 flex-1 text-center">
                                <h3 className="break-words text-lg font-bold text-[#14248A]">{auction.item} <span className="text-[#5365AB]">×{auction.quantity.toLocaleString('en-US')}</span></h3>
                                <p className="mt-2 text-xs text-gray-600">{auction.currentBid ? 'Current bid' : 'Minimum bid'}</p>
                                <p className="break-words font-bold text-[#112D4E]">{(auction.currentBid || auction.minBidMeat).toLocaleString('en-US')} Meat</p>
                                {auction.instantPurchasePrice && <p className="mt-2 break-words text-xs font-semibold text-green-800">Instant purchase: {auction.instantPurchasePrice.toLocaleString('en-US')} Meat</p>}
                                <p className={`mt-2 text-xs ${auction.endTime - now <= 10800000 ? 'text-red-700' : 'text-gray-600'}`}>Ends in <time dateTime={new Date(auction.endTime).toISOString()}>{timeRemaining(auction.endTime, now)}</time></p>
                            </div>
                        </Link>
                    ))}
                </div>
                {(total ?? popular.length) > 4 && <Link to="/auctions" className="mt-4 inline-flex min-h-11 items-center text-blue-700 underline">See more active auctions</Link>}
            </main>
            <footer className="-mx-4 border-t bg-gray-100 px-4 py-3 text-center sm:-mx-6">
                <Link to="/donate" className="inline-flex min-h-11 items-center text-sm text-blue-700 hover:underline">Donate</Link>
                <p className="text-xs text-gray-500">All game images are copyright Asymmetric Publications from The Kingdom of Loathing</p>
            </footer>
        </div>
    );
}
