import { auctionQuantityLabel } from '../lib/bundles';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { timeRemaining, auctionEndingSoon } from '../lib/auctionBrowsing';
import { formatCompactMeat } from '../lib/formatMeat';
import FittedPrice from './FittedPrice';
import SellPrice from './SellPrice';
import TradeTypeBadge from './TradeTypeBadge';
import { getAuctionStatus } from '../lib/auctionLifecycle';

export default function HomeAuctionCard({ auction, now }) {
    const completed = auction.status === 'completed';
    const hot = getAuctionStatus(auction, now) === 'active' && auction.isHot;
    const buy = auction.auctionKind === 'buy';
    const purchased = auction.purchasedQuantity || 0;
    const target = Math.max(purchased, auction.quantity - (auction.reducedQuantity || 0));
    const amount = buy ? auction.pricePerItem : completed ? auction.finalPrice ?? auction.currentBid : auction.currentBid || auction.minBidMeat;
    const label = buy ? 'Buy' : completed ? 'Final' : auction.currentBid ? 'Bid' : 'Min';
    return (
        <Link to={`/auction/${auction.id}`} draggable={false} className={`relative grid h-24 min-w-0 grid-cols-[40px_minmax(0,1fr)] ${buy ? 'grid-rows-[auto_minmax(0,1fr)_6px_16px]' : 'grid-rows-[auto_minmax(0,1fr)_16px]'} gap-x-2 gap-y-0.5 rounded-md border p-2 shadow transition-shadow hover:shadow-md ${completed ? 'bg-green-50' : 'bg-[#F8F6F4]'} auction-card`}>
            {buy && <span className="absolute right-2 top-2 inline-flex rounded border border-red-200 bg-red-100 px-1.5 py-0.5 text-[11px] font-medium leading-3 text-red-700">Buy</span>}
            <div className="col-start-1 row-span-2 row-start-1 flex items-center justify-center">
                {auction.image && <img src={auction.image} alt="" draggable={false} loading="lazy" className="h-10 w-10 object-contain [image-rendering:pixelated]" />}
            </div>
            <h3 title={`${auction.item} ${auctionQuantityLabel(auction)}`} className={`col-start-2 row-start-1 line-clamp-2 self-center break-words text-sm font-bold leading-4 text-[#14248A] ${buy ? 'pr-10' : ''}`}>{auction.item} <span className="text-[#5365AB]">{auctionQuantityLabel(auction)}</span></h3>
            <FittedPrice fitKey={`${label}:${amount}:${auction.quantity}:${hot}:${auction.bidCount ?? auction.bids?.length ?? 0}`} title={`${label}: ${amount.toLocaleString('en-US')} Meat${buy ? ' per item' : ''}`} className={`col-start-2 row-start-2 block min-w-0 self-center text-center text-lg font-bold ${buy ? 'leading-5' : 'leading-[22px]'} text-[#112D4E]`}>
                <span className="text-xs font-normal text-gray-600">{label}: </span>{buy ? <>{formatCompactMeat(amount)} Meat<span className="text-xs font-normal text-gray-600"> / item</span></> : <SellPrice amount={amount} quantity={auction.quantity} />}
                {hot && <><span role="img" aria-label="Top 10% of active auctions by total bids" title="Top 10% of active auctions by total bids" className="ml-1 inline-block text-base">🔥</span><span className="ml-1 text-[9px] font-normal text-gray-500" aria-label={`${auction.bidCount ?? auction.bids?.length ?? 0} bids`}>({(auction.bidCount ?? auction.bids?.length ?? 0).toLocaleString('en-US')})</span></>}
            </FittedPrice>
            {buy && <progress aria-label="Order fulfillment" data-status={getAuctionStatus(auction, now)} value={purchased} max={target || 1}
                title={`${purchased.toLocaleString('en-US')} / ${target.toLocaleString('en-US')} purchased`}
                className="buy-card-progress col-span-2 col-start-1 row-start-3 block h-1.5 w-full" />}
            <div className={`col-span-2 col-start-1 ${buy ? 'row-start-4' : 'row-start-3'} flex min-w-0 items-center gap-1`}>
                {completed ? <p className="min-w-0 flex-1 truncate text-[11px] leading-4 text-green-700">{auction.completedAt ? <>Completed · <time dateTime={new Date(auction.completedAt).toISOString()}>{new Date(auction.completedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></> : 'Trade completed'}</p>
                    : <p className={`min-w-0 flex-1 truncate text-[11px] leading-4 ${auctionEndingSoon(auction, now) ? 'text-red-700' : 'text-gray-600'}`}>Ends in <time dateTime={new Date(auction.endTime).toISOString()}>{timeRemaining(auction.endTime, now)}</time></p>}
                {!buy && <span className="shrink-0"><TradeTypeBadge escrow={auction.escrowMode} tiny short /></span>}
            </div>
        </Link>
    );
}
HomeAuctionCard.propTypes = { auction: PropTypes.object.isRequired, now: PropTypes.number.isRequired };
