import PopularAuctions from '../components/PopularAuctions';
import HighRollers from '../components/HighRollers';
import ExploreAuctions from '../components/ExploreAuctions';
import { useContext, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { recentCompletedAuctions, highRollerAuctions } from '../lib/auctionBrowsing';
import { getAuctionStatus } from '../lib/auctionLifecycle';
import { useNow } from '../hooks/useNow';
import PendingTrades from '../components/PendingTrades';
import SiteFooter from '../components/SiteFooter';
import HomePoll from '../components/HomePoll';

export default function Home() {
    const { auctions, isLoading, error, hasLoaded = !isLoading && !error, refreshAuctions } = useContext(AuctionsContext);
    const now = useNow();
    const featuredPollTarget = useRef(null);
    const hasActiveAuctions = auctions.some(auction => ['active', 'finalizing'].includes(getAuctionStatus(auction, now)));

    const highRollers = useMemo(() => highRollerAuctions(auctions, now), [auctions, now]);
    const completed = useMemo(() => recentCompletedAuctions(auctions), [auctions]);

    return (
        <div className="site-page-background flex flex-1 w-full flex-col bg-[#F9F9F9] px-4 sm:px-6">
            <header className="mx-auto w-full max-w-6xl border-b border-gray-300 pb-6 text-center">
                <h1 className="mt-4 text-4xl font-extrabold text-[#7695FF] sm:text-6xl">KoL Auction Hub <span className="inline-flex items-center gap-1.5 whitespace-nowrap align-middle text-sm font-normal"><span>Beta</span><span aria-hidden="true">·</span><Link to="/update-log" className="text-blue-700 hover:underline">What’s New <span aria-hidden="true">↗</span></Link></span></h1>
                <p className="mt-4 text-lg text-gray-700 sm:text-xl">The best place to find and bid on rare treasures.</p>
            </header>
            <main className="mx-auto mt-6 w-full max-w-6xl flex-1 pb-8">
                <div ref={featuredPollTarget} />
                {error && <p role="alert" className="mb-4 text-red-700">
                    {hasLoaded ? 'Refresh delayed. Showing previously loaded auctions.' : 'Auctions could not be loaded. Please try again.'}{' '}
                    <button onClick={refreshAuctions} className="underline">Retry</button>
                </p>}
                <PendingTrades />
                <HighRollers auctions={highRollers} now={now}>
                    {isLoading && <p role="status">Loading High Rollers…</p>}
                    {!isLoading && !error && highRollers.length === 0 && <p>No active or completed auctions valued at 50M Meat or more yet.</p>}
                </HighRollers>
                <ExploreAuctions auctions={auctions} now={now}>
                    {isLoading && <p role="status">Loading auctions…</p>}
                    {!isLoading && !error && !hasActiveAuctions && <p>No active auctions right now. <Link to="/auctions?status=all" className="text-blue-700 underline">Browse auction history</Link> or <Link to="/auction-item" className="text-blue-700 underline">list an item</Link>.</p>}
                </ExploreAuctions>

                <div className="mt-8">
                    <PopularAuctions auctions={completed} now={now} completed>
                        {isLoading && <p role="status">Loading completed trades…</p>}
                        {!isLoading && !error && completed.length === 0 && <p>No completed trades yet.</p>}
                    </PopularAuctions>
                </div>
            </main>
            <HomePoll featuredTarget={featuredPollTarget} />
            <SiteFooter className="home-footer -mx-4 sm:-mx-6" />
        </div>
    );
}
