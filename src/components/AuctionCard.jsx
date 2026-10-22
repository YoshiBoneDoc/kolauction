import TradeTypeBadge from './TradeTypeBadge';
import WinnerLink from './WinnerLink';
import { useContext, useState } from 'react';
import PropTypes from 'prop-types';
import { Link, useLocation } from 'react-router-dom';
import { getAuctionResult, getAuctionDisplayStatus } from '../lib/auctionLifecycle';
import { timeRemaining } from '../lib/auctionBrowsing';
import AuctionBidForm from './AuctionBidForm';
import { UserContext } from '../context/UserContext';
import InstantPurchaseAction from './InstantPurchaseAction';
import SellerLink from './SellerLink';
import { formatCompactMeat } from '../lib/formatMeat';

export default function AuctionCard({ auction, now }) {
    const [showBid, setShowBid] = useState(false);
    const { currentUser } = useContext(UserContext);
    const location = useLocation();
    const linkState = { browseFrom: `${location.pathname}${location.search}` };
    const result = getAuctionResult(auction, now);
    const active = result.status === 'active';
    const displayStatus = getAuctionDisplayStatus(auction, result);
    return (
        <article className="flex min-w-0 flex-col rounded-lg border bg-[#F8F6F4] p-4 shadow">
            <Link to={`/auction/${auction.id}`} state={linkState} className="flex flex-col items-center gap-3 text-center">
                {auction.image && <img src={auction.image} alt="" loading="lazy" className="h-24 w-24 object-contain" />}
                <h2 className="w-full break-words text-xl font-bold text-[#14248A]">{auction.item} <span className="text-[#5365AB]">×{auction.quantity.toLocaleString('en-US')}</span></h2>
            </Link>
            {auction.auctionNumber && <p className="mt-2 text-center text-xs text-gray-600">Auction #{auction.auctionNumber}</p>}
            <p className="mt-2 break-words text-center text-sm">Sold by <SellerLink auction={auction} /></p>
            <p className="mt-1 text-center"><TradeTypeBadge escrow={auction.escrowMode} /></p>
            <p className="mt-3 text-center text-sm text-gray-600">Minimum bid: {formatCompactMeat(auction.minBidMeat)} Meat</p>
            <div className="my-3 text-center">
                <p className="text-sm text-gray-600">{active ? 'Current bid' : result.hasWinner ? 'Final price' : 'Last bid'}</p>
                <p className="break-words text-xl font-bold text-[#112D4E]">{(result.finalPrice ?? auction.currentBid) ? `${formatCompactMeat(result.finalPrice ?? auction.currentBid)} Meat` : 'No bids yet'}</p>
            </div>
            {active ? (
                <p className={`text-center text-sm ${auction.endTime - now <= 10800000 ? 'text-red-700' : 'text-gray-600'}`}>
                    Ends in <time dateTime={new Date(auction.endTime).toISOString()}>{timeRemaining(auction.endTime, now)}</time>
                </p>
            ) : (
                <div className="space-y-1 text-center text-sm">
                    {result.hasWinner && <p className="break-words">Winner: <WinnerLink auction={auction} /></p>}
                </div>
            )}
            <div className="mt-auto pt-3">
                {active && <InstantPurchaseAction auction={auction} compact />}
                {active && currentUser?.id === auction.sellerId && <p className="text-center text-sm text-gray-600">This is your listing.</p>}
                {active && currentUser?.id !== auction.sellerId && (showBid ? (
                    <>
                        <AuctionBidForm auction={auction} />
                        <button onClick={() => setShowBid(false)} className="mt-2 min-h-11 w-full border border-gray-400 bg-white text-gray-700">Close bid form</button>
                    </>
                ) : (
                    <button onClick={() => setShowBid(true)} className="min-h-11 w-full rounded bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-700">Place Bid</button>
                ))}
                {!active && <p className={`text-center text-lg font-bold ${displayStatus.color}`}>{displayStatus.label}</p>}
                <Link to={`/auction/${auction.id}`} state={linkState} className="mt-2 flex min-h-11 items-center justify-center text-center text-sm text-blue-700 underline">
                    {active ? 'More Info' : 'View outcome and history'}
                </Link>
            </div>
        </article>
    );
}

AuctionCard.propTypes = { auction: PropTypes.object.isRequired, now: PropTypes.number.isRequired };
