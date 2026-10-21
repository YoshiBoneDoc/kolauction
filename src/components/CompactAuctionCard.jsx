import { useContext, useId } from 'react';
import PropTypes from 'prop-types';
import { Link, useLocation } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { getAuctionResult, getAuctionDisplayStatus } from '../lib/auctionLifecycle';
import { timeRemaining } from '../lib/auctionBrowsing';
import { formatCompactMeat } from '../lib/formatMeat';
import AuctionBidForm from './AuctionBidForm';

export default function CompactAuctionCard({ auction, now, expanded = false, onToggleBid }) {
    const { currentUser } = useContext(UserContext);
    const location = useLocation();
    const formId = useId();
    const linkState = { browseFrom: `${location.pathname}${location.search}` };
    const result = getAuctionResult(auction, now);
    const active = result.status === 'active';
    const ownsAuction = currentUser?.id === auction.sellerId;
    const status = getAuctionDisplayStatus(auction, result);
    const price = result.finalPrice ?? (auction.currentBid || auction.minBidMeat);
    const priceLabel = result.hasWinner ? 'Final price' : auction.currentBid ? active ? 'Current bid' : 'Last bid' : 'Minimum bid';
    const shortPriceLabel = result.hasWinner ? 'Final' : auction.currentBid ? active ? 'Bid' : 'Last' : 'Min';
    const canBid = active && !ownsAuction && !currentUser?.isBanned;
    const showForm = expanded && canBid;
    const itemLabel = `${auction.item} ×${auction.quantity.toLocaleString('en-US')}`;

    return <article className="relative isolate grid h-[134px] min-w-0 self-start grid-cols-[60px_minmax(0,1fr)] grid-rows-[32px_44px_44px] gap-x-3 overflow-hidden rounded-lg border border-gray-200 bg-[#F8F6F4] px-3 py-1.5 shadow-sm transition-shadow hover:border-gray-300 hover:shadow-md [&_button]:relative [&_button]:z-10 [&_input]:relative [&_input]:z-10 [&_label]:relative [&_label]:z-10">
        <header className="col-span-2 flex min-h-0 items-start justify-between gap-3">
            <Link to={`/auction/${auction.id}`} state={linkState} title={itemLabel}
                className="min-w-0 flex-1 rounded text-[#14248A] after:absolute after:inset-0 after:z-0 after:cursor-pointer after:rounded-lg hover:text-[#14248A] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-blue-500">
                <h2 className="flex min-w-0 items-start gap-1 text-base font-bold leading-5">
                    <span className="line-clamp-2 min-w-0 break-words">{auction.item}</span>
                    <span className="shrink-0 whitespace-nowrap font-semibold text-[#5365AB]">×{auction.quantity.toLocaleString('en-US')}</span>
                </h2>
            </Link>
            <div className="flex max-w-[45%] shrink-0 flex-col items-end gap-1.5 text-right">
                {active ? <p className={`text-[11px] leading-3 tabular-nums ${auction.endTime - now <= 10800000 ? 'text-red-700' : 'text-gray-500'}`}>
                    <time dateTime={new Date(auction.endTime).toISOString()} title={`Ends ${new Date(auction.endTime).toLocaleString()}`}>{timeRemaining(auction.endTime, now)}</time> left
                </p> : <p title={status.label} className={`max-w-full truncate leading-3 text-xs font-semibold ${status.color}`}>{status.label}</p>}
                <span className="inline-flex rounded border border-gray-200 bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium leading-3 text-gray-600">{auction.escrowMode ? 'Escrow' : 'Direct'}</span>
            </div>
        </header>
        <Link to={`/auction/${auction.id}`} state={linkState} aria-label={`View ${itemLabel}`} className="col-start-1 row-start-2 row-span-2 flex h-[60px] w-[60px] self-center items-center justify-center rounded-md bg-white/70">
            {auction.image ? <img src={auction.image} alt="" loading="lazy" className="h-[60px] w-[60px] object-contain [image-rendering:pixelated]" /> : <span className="text-[10px] text-gray-400">No image</span>}
        </Link>
        <div className="col-span-2 col-start-1 row-start-2 flex min-h-0 min-w-0 flex-col items-center justify-center text-center">
            <p title={`${priceLabel}: ${price.toLocaleString('en-US')} Meat`} className="w-full shrink-0 truncate text-[26px] font-bold leading-7 tracking-tight text-[#112D4E]">
                <span className="text-[11px] font-normal tracking-normal text-gray-500">{shortPriceLabel}: </span>{formatCompactMeat(price)} Meat
            </p>
            {auction.instantPurchasePrice > 0 && <p title={`Buyout: ${auction.instantPurchasePrice.toLocaleString('en-US')} Meat`} className="w-full shrink-0 truncate text-xs font-medium leading-4 text-green-800">
                Buyout: {formatCompactMeat(auction.instantPurchasePrice)}
            </p>}
        </div>
        {showForm ? <section id={formId} aria-label={`Bidding for ${auction.item}`} className="col-start-2 row-start-3 min-h-0 min-w-0 [&_a]:relative [&_a]:z-10">
            {currentUser ? <AuctionBidForm auction={auction} inline showTerms={false} onClose={onToggleBid} /> : <div className="flex h-full min-w-0 items-end gap-1">
                <div role="alert" className="relative z-10 min-w-0 flex-1 rounded-[2px] border border-red-200 bg-red-50 px-1 py-0.5 text-[11px] leading-[11px] text-red-800">
                    <Link to="/register" className="font-semibold text-red-800 underline hover:text-red-900">Register</Link> or <Link to="/login" className="font-semibold text-red-800 underline hover:text-red-900">log in</Link> to bid on auctions.
                </div>
                <button type="button" onClick={onToggleBid} aria-label="Close Bid Form" className="inline-flex h-8 min-w-24 shrink-0 items-center justify-center rounded-[2px] border border-gray-300 bg-white px-4 py-0 text-xs font-semibold text-gray-700 hover:border-gray-400 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-500">Close</button>
            </div>}
        </section> : <div className="col-start-2 row-start-3 flex min-h-0 items-end justify-end">
            {ownsAuction ? <span className="rounded bg-white/70 px-2 py-1 text-[11px] font-medium text-gray-500">Your Listing</span>
                : active && <button type="button" disabled={!canBid} onClick={onToggleBid} aria-expanded={false} aria-controls={formId}
                    className="inline-flex h-8 min-w-24 items-center justify-center rounded-[2px] border border-blue-600 bg-blue-600 px-4 py-0 text-xs font-semibold text-white hover:border-blue-700 hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:border-gray-300 disabled:bg-gray-200 disabled:text-gray-500">Place Bid</button>}
        </div>}
    </article>;
}
CompactAuctionCard.propTypes = { auction: PropTypes.object.isRequired, now: PropTypes.number.isRequired, expanded: PropTypes.bool, onToggleBid: PropTypes.func };
