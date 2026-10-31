import { giveawayConditionLabel } from '../lib/giveaway';
import { GiveawayDecorations, GiveawayCountdown } from '../components/GiveawayCard';
import GiveawayItemImage, { useGiveawayCutout } from '../components/GiveawayItemImage';
import FittedPrice from '../components/FittedPrice';
import { auctionQuantityLabel } from '../lib/bundles';
import BundleContents from '../components/BundleContents';
import AuctionEndedTime from '../components/AuctionEndedTime';
import MarketPrice from '../components/MarketPrice';
import SellPrice from '../components/SellPrice';
import BuyAuctionDetails from '../components/BuyAuctionDetails';
import TradeTypeBadge from '../components/TradeTypeBadge';
import { useContext } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import AuctionOutcome from '../components/AuctionOutcome';
import AuctionItemImage from '../components/AuctionItemImage';
import AuctionBidForm from '../components/AuctionBidForm';
import InstantPurchaseAction from '../components/InstantPurchaseAction';
import { getAuctionResult, getAuctionDisplayStatus } from '../lib/auctionLifecycle';
import { auctionEndTime, timeRemaining } from '../lib/auctionBrowsing';
import { useNow } from '../hooks/useNow';
import SellerLink from '../components/SellerLink';
import WinnerLink from '../components/WinnerLink';
import DirectTradeHelp from '../components/DirectTradeHelp';
import EscrowProtection from '../components/EscrowProtection';
import { formatCompactMeat, formatPerItemMeat } from '../lib/formatMeat';
import TradeReportDismissals from '../components/TradeReportDismissals';
import ItemResources from '../components/ItemResources';

export default function AuctionDetails() {
    const { id } = useParams();
    const { state } = useLocation();
    const browseFrom = state?.browseFrom;
    const backTo = typeof browseFrom === 'string' && (browseFrom === '/auctions' || browseFrom.startsWith('/auctions?')) ? browseFrom : '/auctions';
    const { auctions, isLoading, error } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);
    const now = useNow();
    const auction = auctions.find((listing) => String(listing.id) === id);
    const giveawayImage = useGiveawayCutout(auction?.giveawayTitle ? auction.image : null);
    const backLink = <div className="mx-auto mb-4 max-w-6xl">
        <Link to={backTo} className="inline-flex min-h-11 items-center text-sm text-blue-700 underline">Back to Auctions</Link>
    </div>;

    if (isLoading) return <main className="site-page-background flex-1 bg-[#F1F3F5] px-4 py-6 sm:px-6">{backLink}<p role="status" className="mx-auto max-w-4xl">Loading auction…</p></main>;
    if (!auction) return (
        <main className="site-page-background flex-1 bg-[#F1F3F5] px-4 py-6 sm:px-6">
            {backLink}
            <p className="mx-auto max-w-4xl text-xl font-bold text-red-700">{error ? 'Auction could not be loaded.' : 'Auction not found.'}</p>
        </main>
    );

    if (auction.auctionKind === 'buy') return <BuyAuctionDetails auction={auction} now={now} backLink={backLink} />;

    const result = getAuctionResult(auction, now);
    const active = result.status === 'active';
    const ownsAuction = Boolean(currentUser && !currentUser.isBanned && currentUser.id === auction.sellerId);
    const closedSale = result.hasWinner;
    const endedAt = auctionEndTime(auction);
    const endedTime = ['awaiting_trade', 'completed', 'settling', 'ended_no_bids', 'cancelled', 'expired', 'voided'].includes(result.status)
        && Number.isFinite(endedAt) && endedAt <= now ? <AuctionEndedTime auction={auction} compact={false} /> : null;
    const price = result.finalPrice ?? auction.currentBid;
    const { reportedIncomplete, label: statusLabel, color: statusColor } = getAuctionDisplayStatus(auction, result);
    return (
        <main className={`site-page-background flex-1 bg-[#F1F3F5] px-4 py-6 sm:px-6 ${auction.giveawayTitle ? 'giveaway-detail' : ''}`}>
            {auction.giveawayTitle && <div className="giveaway-page-art" aria-hidden="true"><GiveawayDecorations source={auction.image} /></div>}
            {backLink}
            <div className={`mx-auto max-w-4xl rounded-lg border border-gray-200 bg-white p-4 shadow-lg sm:p-6 ${auction.giveawayTitle ? 'giveaway-detail-card' : ''}`}>
                <section aria-label="Auction overview" className="grid min-w-0 grid-cols-1 items-start gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-6">
                    <div className="flex min-w-0 items-center justify-center sm:pt-2">
                        {auction.image ? <AuctionItemImage key={auction.id} src={auction.giveawayTitle ? giveawayImage : auction.image} item={auction.item} enhanceEnabled /> : <p className="text-gray-500">No Image Available</p>}
                    </div>
                    <div className={`min-w-0 space-y-6 text-left ${auction.giveawayTitle ? 'giveaway-detail-info' : ''}`}>
                        {auction.giveawayTitle && <GiveawayItemImage source="https://wiki.kingdomofloathing.com/Special:Redirect/file/Shoppeng.gif" className="giveaway-penguin" />}
                        <div className="space-y-1">
                            <h1 className={`break-words text-3xl font-bold text-blue-600 sm:text-4xl ${auction.giveawayTitle ? 'giveaway-item-title giveaway-detail-item' : ''}`}>{auction.item} <span className="text-xl text-gray-600">{auctionQuantityLabel(auction)}</span></h1>
                            {auction.giveawayTitle && <div><p className="text-base font-bold">Win Condition: {giveawayConditionLabel(auction.giveawayWinCondition)}</p>{auction.giveawayWinCondition === 'random_draw' && <p className="text-xs text-gray-500">Each participant has an equal chance of winning, regardless of how many bids they place.</p>}</div>}
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-600">
                                <p className="leading-6 text-gray-800">{auction.auctionNumber && <>Auction #{auction.auctionNumber} · </>}Min Bid: <span title={`${auction.minBidMeat.toLocaleString('en-US')} Meat`}>{formatCompactMeat(auction.minBidMeat)}{auction.minBidMeat < 1000 ? ' Meat' : ''}{auction.quantity > 1 && <span className="text-xs text-gray-700"> · {formatPerItemMeat(auction.minBidMeat, auction.quantity)} each</span>}</span></p>
                                <span aria-hidden="true">·</span>
                                <TradeTypeBadge escrow={auction.escrowMode} />
                            </div>
                            {auction.isBundle ? <BundleContents items={auction.bundleItems} /> : <ItemResources item={auction.item} itemId={auction.itemId} />}
                        </div>
                        <div className="space-y-3">
                            <div className={closedSale ? 'space-y-0.5 py-1' : 'space-y-1'}>
                                <div className={closedSale ? 'flex flex-wrap items-baseline gap-x-3 gap-y-1' : undefined}>
                                    <p className="text-xs text-gray-600">{active ? 'Current Bid (whole listing)' : result.hasWinner ? 'Final price: (whole listing)' : 'Last Bid (whole listing)'}</p>
                                    {auction.giveawayTitle ? <FittedPrice as="p" fitKey={String(price)} className="giveaway-price giveaway-detail-price">{price ? `${Number(price).toLocaleString('en-US')} Meat` : 'No bids yet'}</FittedPrice> : <p className="break-words text-3xl font-extrabold text-gray-900 sm:text-4xl">{price ? <SellPrice amount={price} quantity={auction.quantity} compact={false} /> : 'No bids yet'}</p>}
                                </div>
                                {closedSale && auction.instantPurchasedAt && <p className="text-sm leading-6 text-green-700">Buyout accepted for {result.finalPrice.toLocaleString('en-US')} Meat on <span className="inline-block whitespace-nowrap">{new Date(auction.instantPurchasedAt).toLocaleString()}.</span></p>}
                            </div>
                            {!auction.isBundle && (active || result.status === 'completed') && <MarketPrice itemId={auction.itemId} auctionId={auction.id} completed={result.status === 'completed'} />}
                        </div>
                        {active && <InstantPurchaseAction key={`purchase-${auction.id}`} auction={auction} showTerms={false} />}
                        <div className="space-y-2 text-sm text-gray-700">
                            <p className="break-words">Sold by: <SellerLink auction={auction} /></p>
                            {closedSale && <p className="break-words">Winning bidder: <strong><WinnerLink auction={auction} /></strong></p>}
                            {!closedSale && active && <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                                <span className="inline-flex rounded border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">Live</span>
                                <span aria-hidden="true" className="text-gray-400">·</span>
                                {auction.giveawayTitle ? <GiveawayCountdown endTime={auction.endTime} now={now} /> : <p className={auction.endTime - now <= 10800000 ? 'text-red-700' : 'text-gray-600'}>Ends in <time dateTime={new Date(auction.endTime).toISOString()}>{timeRemaining(auction.endTime, now)}</time></p>}
                                <p className="w-full text-[11px] text-gray-500">{auction.giveawayTitle ? <>Giveaway ends at the scheduled time. No jumping ahead! <span className="giveaway-bid-warning">Minimum increases only. <strong>Overbids won't count!</strong></span></> : 'Late bids extend the auction by 1 minute.'}</p>
                            </div>}
                        </div>
                        {closedSale ? <>
                            <div className="space-y-0.5 border-t border-gray-200 pt-3">
                                <p className={`text-lg font-bold ${statusColor}`}>{statusLabel}</p>
                                {endedTime}
                                {reportedIncomplete && <p className="text-xs leading-4 text-gray-500">At least one party reported the trade incomplete.</p>}
                                <TradeReportDismissals auction={auction} compact />
                            </div>
                        </> : !active && <div className="space-y-0.5"><p className={`text-lg font-bold ${statusColor}`}>{statusLabel}</p>{endedTime}</div>}
                    </div>
                </section>
                {active && <section aria-label="Auction bidding" className="mt-4 border-t border-gray-100 pt-4">
                    <div className={`mx-auto w-full max-w-xl ${auction.escrowMode && !ownsAuction ? '' : 'rounded border border-gray-100 p-4'}`}>
                        {ownsAuction ? <AuctionOutcome key={auction.id} auction={auction} now={now} />
                            : <AuctionBidForm key={auction.id} auction={auction} showTerms={false} />}
                    </div>
                </section>}
                <div className="mt-5">
                    {auction.escrowMode ? <EscrowProtection /> : <DirectTradeHelp />}
                </div>
            </div>
            {!active && <AuctionOutcome key={auction.id} auction={auction} now={now} />}
            <section aria-label="Bid history" className="mx-auto mt-6 max-w-4xl rounded-lg border border-gray-200 bg-white p-4 shadow sm:p-6">
                <h2 className="mb-4 text-2xl font-bold text-gray-800">Bid History</h2>
                {auction.bids?.length ? <ul className="divide-y divide-gray-200">
                    {auction.bids.slice().reverse().map((bid, index) => (
                        <li key={bid.id || index} className="flex flex-col gap-1 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                            <div className="min-w-0">
                                <span className="break-words font-medium text-gray-700">{bid.bidder}</span>
                                {currentUser && bid.adminDeliveryReferences?.length > 0 && <ul aria-label="Administrator message references" className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                                    {bid.adminDeliveryReferences.map(delivery => <li key={delivery.reference}>
                                        {delivery.label}: <span className="font-mono">{delivery.reference}</span> ({delivery.state})
                                    </li>)}
                                </ul>}
                            </div>
                            <div className="sm:text-right">
                                <p className="font-bold text-gray-900">{bid.amount.toLocaleString('en-US')} Meat</p>
                                {auction.instantPurchasedAt && bid.amount === auction.instantPurchasePrice && <p className="text-xs font-semibold text-green-700">Buyout</p>}
                                {!auction.instantPurchasedAt && result.hasWinner && bid.amount === result.finalPrice && <p className="text-xs font-semibold text-green-700">Winning bid</p>}
                                <p className="text-xs text-gray-600">{new Date(bid.timestamp).toLocaleString()}</p>
                            </div>
                        </li>
                    ))}
                </ul> : <p className="text-gray-600">No bids yet.</p>}
            </section>
        </main>
    );
}
