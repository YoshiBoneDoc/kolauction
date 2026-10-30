import PopularAuctions from '../components/PopularAuctions';
import HighRollers from '../components/HighRollers';
import GiveawayCard from '../components/GiveawayCard';
import useFeaturedGiveaway from '../hooks/useFeaturedGiveaway';
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
import SiteTradeTotals from '../components/SiteTradeTotals';

export default function Home() {
    const { auctions, homeSections, siteTotals, isLoading, error, hasLoaded = !isLoading && !error, refreshAuctions } = useContext(AuctionsContext);
    const now = useNow();
    const featuredGiveaway = useFeaturedGiveaway();
    const featuredPollTarget = useRef(null);
    const hasActiveAuctions = auctions.some(auction => ['active', 'finalizing'].includes(getAuctionStatus(auction, now)));

    const highRollers = useMemo(() => highRollerAuctions(homeSections?.highRollers || auctions, now), [auctions, homeSections, now]);
    const completed = useMemo(() => recentCompletedAuctions(homeSections?.recent || auctions), [auctions, homeSections]);

    return (
        <div className="site-page-background flex flex-1 w-full flex-col bg-[#F9F9F9] px-4 sm:px-6">
            <header className="mx-auto w-full max-w-6xl text-center">
                <div className="mt-4 grid grid-cols-1 items-baseline gap-y-1 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                    <h1 className="text-4xl font-extrabold text-[#7695FF] sm:text-6xl lg:col-start-2">KoL Auction Hub</h1>
                    <Link to="/update-log" className="justify-self-center whitespace-nowrap text-sm font-normal text-blue-700 hover:underline lg:col-start-3 lg:ml-2 lg:justify-self-start">What’s New <span aria-hidden="true">↗</span></Link>
                </div>
                <SiteTradeTotals totals={siteTotals} />
            </header>
            <main className="mx-auto mt-6 w-full max-w-6xl flex-1 pb-8">
                <div ref={featuredPollTarget} />
                {error && <p role="alert" className="mb-4 text-red-700">
                    {hasLoaded ? 'Refresh delayed. Showing previously loaded auctions.' : 'Auctions could not be loaded. Please try again.'}{' '}
                    <button onClick={refreshAuctions} className="underline">Retry</button>
                </p>}
                <PendingTrades />
                {featuredGiveaway && getAuctionStatus(featuredGiveaway, now) === 'active' && <div className="mb-8">
                    <GiveawayCard auction={featuredGiveaway} now={now} />
                    <p className="mt-1.5 text-center text-xs"><Link to="/giveaways" className="text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200">Seriously, wtf is this?</Link></p>
                </div>}
                <HighRollers auctions={highRollers} now={now}>
                    {isLoading && <p role="status">Loading High Rollers…</p>}
                    {!isLoading && !error && highRollers.length === 0 && <p>No active or completed auctions valued at 50M Meat or more yet.</p>}
                </HighRollers>
                <ExploreAuctions sections={homeSections} auctions={auctions} now={now}>
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
