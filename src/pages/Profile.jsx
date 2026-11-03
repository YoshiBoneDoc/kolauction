import { flushSync } from 'react-dom';
import { switchProfileTab } from '../lib/profileTabScroll';
import SavedAuctions from '../components/SavedAuctions';
import ProfileTimeLeft from '../components/ProfileTimeLeft';
import RelistButton from '../components/RelistButton';
import { auctionQuantityLabel } from '../lib/bundles';
import WinnerLink from '../components/WinnerLink';
import { useContext, useRef, useState } from "react";
import { UserContext } from "../context/UserContext";
import { AuctionsContext } from "../context/AuctionsContext";
import { Link } from "react-router-dom";
import { getAuctionResult, getAuctionStatus } from "../lib/auctionLifecycle";
import KolVerification from "../components/KolVerification";
import AuctionItemImage from '../components/AuctionItemImage';
import { formatCompactMeat } from '../lib/formatMeat';
import { useAuctionBoundaryNow as useNow } from "../hooks/useAuctionBoundaryNow";
import MeatStack from '../components/MeatStack';
import { toggleProfileSection } from '../lib/profileSections';
import { auctionEndTime } from '../lib/auctionBrowsing';
import { profileBidAuctions, latestProfileBid } from '../lib/profileBids';

const historyTabs = [['listing', 'Listing history'], ['fulfillments', 'Buy order fulfillments']];
const profileTabs = [['auctions', 'My Auctions'], ['bids', 'My Bids'], ['saved', 'Saved Auctions']];

const formatNumber = (number) => number.toLocaleString('en-US');
const historyTime = auction => Date.parse(auction.completedAt) || auctionEndTime(auction) || auction.endTime || auction.createdAt;


const Profile = () => {
    const { currentUser } = useContext(UserContext);
    const { auctions, isLoading, error, refreshAuctions } = useContext(AuctionsContext);
    const now = useNow(auctions);
    const activityRef = useRef(null);
    const [selectedTab, setSelectedTab] = useState('auctions');
    const [historyTab, setHistoryTab] = useState('listing');
    const [retrying, setRetrying] = useState(false);
    const [expandedSections, setExpandedSections] = useState({});
    const [collapsedSections, setCollapsedSections] = useState({});

    function selectTab(id, inner = false) {
        if (id === (inner ? historyTab : selectedTab)) return;
        switchProfileTab({ activity: activityRef.current,
            commit: () => flushSync(() => inner ? setHistoryTab(id) : setSelectedTab(id)) });
    }

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

    const selectedHistorySection = sections.find(section => section.title === historyTabs.find(([id]) => id === historyTab)[1]);
    const attentionSections = sections.filter(section => ['Awaiting escrow deposit', 'Awaiting settlement'].includes(section.title) && section.records.length > 0);

    const renderSectionToggle = (title, count) => {
        const collapsed = collapsedSections[title] === true;
        return <button type="button" className="profile-count-button"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`} aria-expanded={!collapsed}
            onClick={() => setCollapsedSections(previous => toggleProfileSection(previous, title))}>
            <span className="profile-count">{count}</span><span className={`profile-count-chevron${collapsed ? ' is-collapsed' : ''}`} aria-hidden="true" />
        </button>;
    };

    const renderAuctionSection = ({ title, records, embedded = false, compact = false }) => {
        const canShowMore = ['Active listings', 'Active bids', 'Listing history', 'Bid history', 'Buy order fulfillments'].includes(title);
        const initialLimit = title === 'Active listings' || title === 'Active bids' ? 10 : 5;
        const visibleLimit = canShowMore ? (expandedSections[title] ?? initialLimit) : records.length;
        const visibleRecords = records.slice(0, visibleLimit);
        const remaining = Math.max(0, records.length - visibleRecords.length);
        const isExpanded = canShowMore && visibleLimit > initialLimit;
        const isCollapsed = collapsedSections[title] === true;

        return (
            <section key={title} className={`profile-transaction-section${embedded ? ' profile-transaction-embedded' : ''}`}>
                {embedded && !compact ? <h2 className="sr-only">{title}</h2> : <div className={`flex items-center justify-between gap-3 border-b profile-divider ${compact ? 'pb-1.5' : 'pb-3'}`}>
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <h2 className="text-[17px] font-semibold profile-text">{compact && title === 'Awaiting escrow deposit' ? 'Awaiting item deposit' : title}</h2>
                        {title === 'Bid history' && <span className="text-[11px] font-normal profile-label">Ended Auctions</span>}
                    </div>
                    {renderSectionToggle(title, records.length)}
                </div>}
                <div hidden={isCollapsed}>
                    {records.length === 0 ? <p className="mt-3 py-2 text-[13px] profile-label">Nothing here yet.</p> : (
                        <div className={`${compact ? 'mt-2' : 'mt-3'} space-y-[5px]`}>
                        {visibleRecords.map((auction) => {
                            const result = getAuctionResult(auction, now);
                            const isBuy = auction.auctionKind === 'buy';
                            const personalBid = latestProfileBid(auction, currentUser.id);
                            const historyRow = title === 'Listing history';
                            const shadedRow = historyRow || title === 'Active listings';
                            const cancelled = ['cancelled', 'voided'].includes(result.status);
                            const historyClass = shadedRow ? ` profile-history-entry ${cancelled ? 'is-cancelled' : result.status === 'ended_no_bids' ? 'is-unsold' : isBuy ? 'is-buy' : 'is-sell'}` : '';
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
                                                <span className="text-xs font-medium profile-muted">{isBuy && title === 'Buy order fulfillments' ? `× ${personallyFulfilled == null ? '—' : formatNumber(personallyFulfilled)}` : auctionQuantityLabel(auction)}</span>
                                                {bidStatus && <span className={`profile-outcome-badge ${bidStatus.className}`}>{bidStatus.label}</span>}
                                            </h3>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2">{shadedRow && !historyRow && <RelistButton auction={auction} now={now} />}
                                        {historyOutcome ? <span className={`profile-outcome-badge ${historyOutcome.className}`}>{historyOutcome.label}</span> : result.status === 'active' ? <time
                                            dateTime={new Date(auction.endTime).toISOString()}
                                            title={`Ends ${new Date(auction.endTime).toLocaleString()}`}
                                            className="profile-entry-endtime"
                                        ><ProfileTimeLeft endTime={auction.endTime} /></time> : <span className={`profile-entry-status${historyStatus}`}>{result.label}</span>}</div>
                                    </div>

                                    <div className="profile-entry-row">
                                        <p className="profile-entry-secondary">{isBuy && title === 'Buy order fulfillments' ? 'Buy order · ' : result.status === 'active' ? <><span className="profile-entry-active">{result.label}</span> · </> : ''}<span>{auction.escrowMode ? 'Escrow' : 'Direct settlement'}</span></p>
                                        <div className="profile-entry-details">
                                            {isBuy && title === 'Buy order fulfillments' && <span>{formatNumber(auction.pricePerItem)} Meat/item · Earned: <strong>{formatCompactMeat(auction.mySaleMeat)} Meat</strong></span>}
                                            {isBuy && title !== 'Buy order fulfillments' && <span>{formatNumber(auction.pricePerItem)} Meat / item · {formatNumber(auction.purchasedQuantity)} / {formatNumber(auction.quantity)} purchased</span>}
                                            {!isBuy && result.status === 'active' && <span>Current bid: <strong>{auction.currentBid > 0 ? `${formatCompactMeat(auction.currentBid)} Meat` : 'No bids yet'}</strong></span>}
                                            {result.hasWinner && <span>{result.winnerId === currentUser.id && ['awaiting_trade', 'completed'].includes(result.status) ? null : <>Winner: <WinnerLink auction={auction} /> · </>}Final: <strong>{formatCompactMeat(result.finalPrice)}</strong></span>}
                                            {personalBid && <span>Your bid: <strong>{formatCompactMeat(personalBid.amount)} Meat</strong></span>}
                                            {historyRow && <RelistButton auction={auction} now={now} subtle />}
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
                <div className="profile-dashboard">
                    <KolVerification publicSellerHref={selling.some(auction => auction.status !== 'pending_escrow') ? `/seller/${currentUser.id}` : undefined} />
                </div>

                <div className="profile-dashboard space-y-[18px]">

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

                    {attentionSections.length > 0 && <section aria-label="Auctions needing attention" className="profile-panel space-y-4 p-3 sm:px-4">
                        {attentionSections.map(section => renderAuctionSection({ ...section, embedded: true, compact: true }))}
                    </section>}

                    <section ref={activityRef} aria-label="Your auctions and bids" className="profile-panel p-3 sm:p-4">
                        <div role="tablist" aria-label="Account auctions" className="profile-auction-tabs mb-4 grid grid-cols-3 gap-3">
                            {profileTabs.map(([id, label], index) => <button key={id} type="button" role="tab"
                                id={`profile-tab-${id}`} aria-controls={`profile-panel-${id}`} aria-selected={selectedTab === id}
                                tabIndex={selectedTab === id ? 0 : -1} className="profile-auction-tab"
                                onClick={() => selectTab(id)} onKeyDown={event => {
                                    const next = event.key === 'ArrowRight' ? (index + 1) % profileTabs.length
                                        : event.key === 'ArrowLeft' ? (index + profileTabs.length - 1) % profileTabs.length
                                            : event.key === 'Home' ? 0 : event.key === 'End' ? profileTabs.length - 1 : null;
                                    if (next === null) return;
                                    event.preventDefault();
                                    selectTab(profileTabs[next][0]);
                                    document.getElementById(`profile-tab-${profileTabs[next][0]}`)?.focus({ preventScroll: true });
                                }}>{label}</button>)}
                        </div>
                        <div role="tabpanel" id="profile-panel-auctions" aria-labelledby="profile-tab-auctions" hidden={selectedTab !== 'auctions'}>
                            <div data-profile-auction-columns className="grid items-start gap-3 lg:grid-cols-2">
                                <div className="min-w-0">{sections.filter(section => section.title === 'Active listings').map(renderAuctionSection)}</div>
                                <div className="profile-panel min-w-0 p-4 sm:p-[18px]">
                                    <div className="mb-3 flex items-center justify-between gap-3 border-b pb-2 profile-divider">
                                    <div role="tablist" aria-label="Listing history and fulfillments" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                                        {historyTabs.map(([id, label], index) => <button key={id} type="button" role="tab"
                                            id={`profile-history-tab-${id}`} aria-controls={`profile-history-panel-${id}`} aria-selected={historyTab === id}
                                            tabIndex={historyTab === id ? 0 : -1} className="profile-history-tab"
                                            onClick={() => selectTab(id, true)} onKeyDown={event => {
                                                const next = ['ArrowRight', 'ArrowLeft'].includes(event.key) ? 1 - index
                                                    : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : null;
                                                if (next === null) return;
                                                event.preventDefault();selectTab(historyTabs[next][0], true);
                                                document.getElementById(`profile-history-tab-${historyTabs[next][0]}`)?.focus({ preventScroll: true });
                                            }}>{label}</button>)}
                                    </div>
                                    {renderSectionToggle(selectedHistorySection.title, selectedHistorySection.records.length)}
                                    </div>
                                    {historyTabs.map(([id, title]) => <div key={id} role="tabpanel" id={`profile-history-panel-${id}`}
                                        aria-labelledby={`profile-history-tab-${id}`} hidden={historyTab !== id}>
                                        {renderAuctionSection({ ...sections.find(section => section.title === title), embedded: true })}
                                    </div>)}
                                </div>
                            </div>
                        </div>
                        <div role="tabpanel" id="profile-panel-bids" aria-labelledby="profile-tab-bids" hidden={selectedTab !== 'bids'}>
                            <div className="grid items-start gap-3 lg:grid-cols-2">
                                {sections.filter(section => ['Active bids', 'Bid history'].includes(section.title)).map(renderAuctionSection)}
                            </div>
                        </div>
                        <div role="tabpanel" id="profile-panel-saved" aria-labelledby="profile-tab-saved" hidden={selectedTab !== 'saved'}>
                            <SavedAuctions />
                        </div>
                    </section>
                </div>
            </div>
        </main>
    );
};

export default Profile;
