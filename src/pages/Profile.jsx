import WinnerLink from '../components/WinnerLink';
import { useContext, useState } from "react";
import { UserContext } from "../context/UserContext";
import { AuctionsContext } from "../context/AuctionsContext";
import { Link } from "react-router-dom";
import { getAuctionResult, getAuctionStatus } from "../lib/auctionLifecycle";
import KolVerification from "../components/KolVerification";
import AuctionItemImage from '../components/AuctionItemImage';
import { formatCompactMeat } from '../lib/formatMeat';
import { useNow } from "../hooks/useNow";
import MeatStack from '../components/MeatStack';
import { toggleProfileSection } from '../lib/profileSections';
import { auctionEndTime } from '../lib/auctionBrowsing';
import { profileBidAuctions, latestProfileBid } from '../lib/profileBids';

const formatNumber = (number) => number.toLocaleString('en-US');
const historyTime = auction => Date.parse(auction.completedAt) || auctionEndTime(auction) || auction.endTime || auction.createdAt;

const formatTimeLeft = (endTime, now) => {
    const remaining = Math.max(0, Math.ceil((endTime - now) / 1000));
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    return `${days ? `${days}d ` : ''}${hours}h ${minutes}m ${seconds}s left`;
};

const Profile = () => {
    const { currentUser } = useContext(UserContext);
    const { auctions, isLoading, error, refreshAuctions } = useContext(AuctionsContext);
    const now = useNow();
    const [retrying, setRetrying] = useState(false);
    const [expandedSections, setExpandedSections] = useState({});
    const [collapsedSections, setCollapsedSections] = useState({});

    if (!currentUser) {
        return (
            <div className="site-page-background flex-1 flex flex-col items-center justify-center bg-[#F1F3F5] p-6">
                <p className="text-red-500 text-xl font-bold mb-4">You must be logged in to view your profile.</p>
                <Link to="/login" className="text-blue-500 hover:underline text-lg">Log In</Link>
            </div>
        );
    }
    if (isLoading) return <div className="p-6"><p role="status" className="mt-3">Loading your auction history…</p></div>;

    if (error) return <main className="site-page-background flex-1 bg-[#F1F3F5] p-6">
        <h1 className="my-6 text-center text-4xl font-bold text-blue-600">My Account</h1>
        <section aria-labelledby="history-unavailable" className="mx-auto max-w-xl space-y-3 rounded border border-gray-200 bg-white p-6">
            <h2 id="history-unavailable" className="text-lg font-semibold text-gray-900">Auction history unavailable</h2>
            <p className="text-gray-600">Your totals and trade history could not be loaded. Please try again.</p>
            <button disabled={retrying} onClick={async () => {
                setRetrying(true);
                try { await refreshAuctions(); }
                finally { setRetrying(false); }
            }} className="rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50">{retrying ? 'Retrying…' : 'Try again'}</button>
        </section>
    </main>;

    const selling = auctions.filter((auction) => auction.sellerId === currentUser.id);
    const bidding = profileBidAuctions(auctions, currentUser.id);
    const awaitingTrades = auctions.filter((auction) => {
        const result = getAuctionResult(auction, now);
        return result.status === 'awaiting_trade'
            && (auction.sellerId === currentUser.id || result.winnerId === currentUser.id);
    });
    const completedSales = selling.filter((auction) => auction.status === 'completed' && auction.auctionKind !== 'buy');
    const completedPurchases = auctions.filter((auction) => auction.status === 'completed' && auction.winnerId === currentUser.id);
    const totalMeatGain = auctions.reduce((sum, auction) => sum + BigInt(auction.mySaleMeat || 0), 0n) + completedSales.reduce((sum, auction) => sum + BigInt(auction.finalPrice ?? 0) - BigInt(auction.escrowMode ? (auction.feeMeat || 0) : 0), 0n);
    const buyMeatSpent = selling.filter(a => a.auctionKind === 'buy').reduce((sum,a) => sum + BigInt(a.purchaseMeat || 0) + BigInt(a.buyCommissionMeat || 0), 0n);
    const totalMeatSpent = completedPurchases.reduce((sum, auction) => sum + BigInt(auction.finalPrice ?? 0), 0n);
    const sections = [
        { title: 'Buy order fulfillments', records: auctions.filter(a => a.auctionKind === 'buy' && a.fulfilledByMe) },
        { title: 'Awaiting escrow deposit', records: selling.filter((auction) => auction.status === 'pending_escrow') },
        { title: 'Awaiting settlement', records: awaitingTrades },
        { title: 'Active listings', records: selling.filter((auction) => getAuctionStatus(auction, now) === 'active') },
        { title: 'Active bids', records: bidding.filter((auction) => getAuctionStatus(auction, now) === 'active').sort((a, b) => a.endTime - b.endTime) },
        { title: 'Listing history', records: selling.filter((auction) => !['active','pending_escrow','settling'].includes(getAuctionStatus(auction, now))).sort((a, b) => historyTime(b) - historyTime(a) || b.createdAt - a.createdAt) },
        { title: 'Bid history', records: bidding.filter((auction) => !['active','settling'].includes(getAuctionStatus(auction, now))).sort((a, b) => historyTime(b) - historyTime(a)) },
    ];

    const renderAuctionSection = ({ title, records }) => {
        const canShowMore = ['Active listings', 'Active bids', 'Listing history', 'Bid history'].includes(title);
        const initialLimit = title === 'Active listings' || title === 'Active bids' ? 10 : 5;
        const visibleLimit = canShowMore ? (expandedSections[title] ?? initialLimit) : records.length;
        const visibleRecords = records.slice(0, visibleLimit);
        const remaining = Math.max(0, records.length - visibleRecords.length);
        const isExpanded = canShowMore && visibleLimit > initialLimit;
        const isCollapsed = collapsedSections[title] === true;

        return (
            <section key={title} className="profile-transaction-section">
                <div className="flex items-center justify-between gap-3 border-b pb-3 profile-divider">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <h2 className="text-[17px] font-semibold profile-text">{title}</h2>
                        {title === 'Bid history' && <span className="text-[11px] font-normal profile-label">Ended Auctions</span>}
                    </div>
                    <button
                        type="button"
                        className="profile-count-button"
                        aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${title}`}
                        aria-expanded={!isCollapsed}
                        onClick={() => setCollapsedSections(previous => toggleProfileSection(previous, title))}
                    ><span className="profile-count">{records.length}</span><span className={`profile-count-chevron${isCollapsed ? ' is-collapsed' : ''}`} aria-hidden="true" /></button>
                </div>
                <div hidden={isCollapsed}>
                    {records.length === 0 ? <p className="mt-3 py-2 text-[13px] profile-label">Nothing here yet.</p> : (
                        <div className="mt-3 space-y-[5px]">
                        {visibleRecords.map((auction) => {
                            const result = getAuctionResult(auction, now);
                            const isBuy = auction.auctionKind === 'buy';
                            const personalBid = latestProfileBid(auction, currentUser.id);
                            const historyRow = title === 'Listing history';
                            const cancelled = ['cancelled', 'voided'].includes(result.status);
                            const historyClass = historyRow ? ` profile-history-entry ${cancelled ? 'is-cancelled' : isBuy ? 'is-buy' : 'is-sell'}` : '';
                            const historyStatus = historyRow ? result.status === 'completed' ? ' is-completed'
                                : cancelled ? ' is-cancelled' : ['expired', 'ended_no_bids'].includes(result.status) ? ' is-expired' : '' : '';
                            const personallyFulfilled = auction.mySaleQuantity;
                            const bidStatus = title === 'Active bids' && auction.viewerIsHighestBidder != null
                                ? auction.viewerIsHighestBidder ? { label: 'Winning', className: 'profile-badge-winning' }
                                    : { label: 'Outbid', className: 'profile-badge-outbid' }
                                : null;
                            const historyOutcome = title === 'Bid history' && ['awaiting_trade', 'completed'].includes(result.status) && result.hasWinner && result.winnerId
                                ? result.winnerId === currentUser.id ? { label: 'Won', className: 'profile-badge-winning' }
                                    : { label: 'Lost', className: 'profile-badge-lost' }
                                : title === 'Bid history' && !result.hasWinner && ['cancelled', 'voided', 'expired', 'ended_no_bids'].includes(result.status)
                                    ? { label: result.status === 'ended_no_bids' ? 'No sale' : 'Canceled', className: 'profile-badge-neutral' }
                                    : null;
                            return (
                                <article key={auction.id} className={`profile-transaction-entry${historyClass}`}>
                                    {auction.image ? <AuctionItemImage src={auction.image} item={auction.item} size="tiny" className="profile-entry-image" fallbackText="No image" />
                                        : <span className="profile-entry-image profile-entry-image-fallback" role="img" aria-label={`${auction.item} image unavailable`}>No image</span>}
                                    <div className="profile-entry-row">
                                        <div className="profile-entry-content flex min-w-0 flex-1 items-center">
                                            <h3 className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px] leading-[18px]">
                                                <Link to={`/auction/${auction.id}`} className="break-words font-semibold profile-text hover:underline">{auction.item}</Link>
                                                <span className="text-xs font-medium profile-muted">× {isBuy && title === 'Buy order fulfillments' ? (personallyFulfilled == null ? '—' : formatNumber(personallyFulfilled)) : formatNumber(auction.quantity)}</span>
                                                {bidStatus && <span className={`profile-outcome-badge ${bidStatus.className}`}>{bidStatus.label}</span>}
                                            </h3>
                                        </div>
                                        {historyOutcome ? <span className={`profile-outcome-badge ${historyOutcome.className}`}>{historyOutcome.label}</span> : result.status === 'active' ? <time
                                            dateTime={new Date(auction.endTime).toISOString()}
                                            title={`Ends ${new Date(auction.endTime).toLocaleString()}`}
                                            className="profile-entry-endtime"
                                        >{formatTimeLeft(auction.endTime, now)}</time> : <span className={`profile-entry-status${historyStatus}`}>{result.label}</span>}
                                    </div>

                                    <div className="profile-entry-row">
                                        <p className="profile-entry-secondary">{isBuy && title === 'Buy order fulfillments' ? 'Buy order · ' : result.status === 'active' ? <><span className="profile-entry-active">{result.label}</span> · </> : ''}<span>{auction.escrowMode ? 'Escrow' : 'Direct settlement'}</span></p>
                                        <div className="profile-entry-details">
                                            {isBuy && title === 'Buy order fulfillments' && <span>{formatNumber(auction.pricePerItem)} Meat/item · Earned: <strong>{formatCompactMeat(auction.mySaleMeat)} Meat</strong></span>}
                                            {isBuy && title !== 'Buy order fulfillments' && <span>{formatNumber(auction.pricePerItem)} Meat / item · {formatNumber(auction.purchasedQuantity)} / {formatNumber(auction.quantity)} purchased</span>}
                                            {!isBuy && result.status === 'active' && <span>Current bid: <strong>{auction.currentBid > 0 ? `${formatCompactMeat(auction.currentBid)} Meat` : 'No bids yet'}</strong></span>}
                                            {result.hasWinner && <span>{result.winnerId === currentUser.id && ['awaiting_trade', 'completed'].includes(result.status) ? null : <>Winner: <WinnerLink auction={auction} /> · </>}Final: <strong>{formatCompactMeat(result.finalPrice)}</strong></span>}
                                            {personalBid && <span>Your bid: <strong>{formatCompactMeat(personalBid.amount)} Meat</strong></span>}
                                        </div>
                                    </div>

                                    {result.status === 'awaiting_trade' && <div className="profile-entry-extra">
                                        <span>{auction.sellerId === currentUser.id ? 'You are the seller.' : result.winnerId === currentUser.id ? 'You won this auction.' : 'Another bidder won.'}</span>
                                        <Link to={`/auction/${auction.id}`} className="profile-blue underline">View trade details</Link>
                                    </div>}
                                </article>
                            );
                        })}
                        </div>
                    )}
                {canShowMore && records.length > initialLimit && (remaining > 0 || isExpanded) && <button
                    type="button"
                    className="profile-show-more"
                    aria-expanded={remaining === 0}
                    onClick={() => setExpandedSections(previous => ({ ...previous, [title]: remaining > 0 ? visibleLimit + Math.min(5, remaining) : initialLimit }))}
                >{remaining > 0 ? `Show ${Math.min(5, remaining)} more ↓` : 'Show less ↑'}</button>}
                </div>
            </section>
        );
    };

    return (
        <main className="site-page-background flex-1 bg-[#F1F3F5] px-4 pb-5 pt-4 sm:px-6 sm:pt-5">
            <div className="mx-auto max-w-7xl space-y-4">
                <h1 className="text-center text-5xl font-bold text-blue-700">Account Profile</h1>
                <header className="rounded-xl border border-gray-200 bg-white px-5 py-2 shadow-sm sm:px-6">
                    <div className="grid grid-cols-1 gap-y-2 border-b border-gray-200 pb-1.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end">
                        <p className="order-2 text-xs font-semibold uppercase leading-4 tracking-wider text-gray-500 sm:order-none">Account overview</p>
                        <nav aria-label="Profile links" className="order-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm leading-4 sm:order-none">
                            <Link to="/change-password" className="text-blue-700 underline">Change password</Link>
                            {selling.some(auction => auction.status !== 'pending_escrow') && <><span aria-hidden="true" className="text-xl leading-4 text-black">·</span><Link to={`/seller/${currentUser.id}`} className="text-blue-700 underline">Public seller profile</Link></>}
                        </nav>
                    </div>
                    <p className="pt-1.5 text-left text-2xl font-bold leading-tight text-blue-700">{currentUser.khubUsername}</p>
                </header>

                <div className="profile-dashboard space-y-[18px]">
                    <KolVerification />

                    <section aria-label="Trade totals">
                        <div className="mb-3">
                            <h2 className="text-lg font-semibold profile-text">Trade totals</h2>
                            <p className="text-xs profile-label">Totals include completed bot deliveries (seller fees deducted) and direct trades confirmed by both parties.</p>
                        </div>
                        <dl className="grid grid-cols-1 gap-4 md:grid-cols-3">
                            <div className="profile-stat-card">
                                <dt className="profile-stat-label">Total Sales</dt>
                                <dd className="profile-stat-value profile-stat-main"><MeatStack total={totalMeatGain} /><span className="profile-stat-total">{formatCompactMeat(totalMeatGain)} <span>Meat</span></span></dd>
                            </div>
                            <div className="profile-stat-card">
                                <dt className="profile-stat-label">Winning Bids</dt>
                                <dd className="profile-stat-value profile-stat-main"><MeatStack total={totalMeatSpent} /><span className="profile-stat-total">{formatCompactMeat(totalMeatSpent)} <span>Meat</span></span></dd>
                            </div>
                            <div className="profile-stat-card">
                                <dt className="profile-stat-label">Buy Orders</dt>
                                <dd className="profile-stat-value profile-stat-main"><MeatStack total={buyMeatSpent} /><span className="profile-stat-total">{formatCompactMeat(buyMeatSpent)} <span>Meat</span></span></dd>
                            </div>
                        </dl>
                    </section>

                    <div className="lg:hidden space-y-[18px]">
                        {sections.map(renderAuctionSection)}
                    </div>
                    <div className="hidden grid-cols-2 items-start gap-[18px] lg:grid">
                        {[sections.filter((_, index) => index % 2 === 0), sections.filter((_, index) => index % 2 === 1)].map((column, index) => (
                            <div key={index} className="flex min-w-0 flex-col gap-[18px]">
                                {column.map(renderAuctionSection)}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </main>
    );
};

export default Profile;
