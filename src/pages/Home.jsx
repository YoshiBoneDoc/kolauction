import PopularAuctions from '../components/PopularAuctions';
import { useContext, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { popularActiveAuctions } from '../lib/auctionBrowsing';
import { useNow } from '../hooks/useNow';
import PendingTrades from '../components/PendingTrades';
import SiteFooter from '../components/SiteFooter';
import HomePoll from '../components/HomePoll';

export default function Home() {
    const { auctions, isLoading, error } = useContext(AuctionsContext);
    const now = useNow();
    const popular = useMemo(() => popularActiveAuctions(auctions, now), [auctions, now]);

    return (
        <div className="flex flex-1 w-full flex-col bg-[#F9F9F9] px-4 sm:px-6">
            <header className="mx-auto w-full max-w-6xl border-b border-gray-300 pb-6 text-center">
                <h1 className="mt-4 text-4xl font-extrabold text-[#7695FF] sm:text-6xl">KoL Auction Hub <span className="text-sm">Beta</span></h1>
                <p className="mt-4 text-lg text-gray-700 sm:text-xl">The best place to find and bid on rare treasures.</p>
            </header>
            <main className="mx-auto mt-6 w-full max-w-6xl flex-1 pb-8">
                <PendingTrades />
                <PopularAuctions auctions={popular} now={now}>
                    {isLoading && <p role="status">Loading auctions…</p>}
                    {!isLoading && !error && popular.length === 0 && <p>No active auctions right now. <Link to="/auctions?status=all" className="text-blue-700 underline">Browse auction history</Link> or <Link to="/auction-item" className="text-blue-700 underline">list an item</Link>.</p>}
                </PopularAuctions>
            </main>
            <HomePoll />
            <SiteFooter className="-mx-4 sm:-mx-6" />
        </div>
    );
}
