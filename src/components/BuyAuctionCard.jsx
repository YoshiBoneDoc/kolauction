import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { getAuctionResult } from '../lib/auctionLifecycle';
import { timeRemaining } from '../lib/auctionBrowsing';
import { formatCompactMeat } from '../lib/formatMeat';

export default function BuyAuctionCard({ auction, now }) {
    const result = getAuctionResult(auction, now);
    const purchased = auction.purchasedQuantity || 0;
    const target = Math.max(purchased, auction.quantity - (auction.reducedQuantity || 0));
    return <article className={`relative flex h-[134px] min-w-0 flex-col rounded-lg border border-gray-200 px-3 py-2 shadow-sm ${auction.status === 'completed' ? 'bg-green-50' : 'bg-[#F8F6F4]'}`}>
        <div className="flex min-w-0 justify-between gap-2"><h2 className="truncate font-bold text-[#14248A]"><Link to={`/auction/${auction.id}`}>{auction.item} ×{auction.quantity.toLocaleString('en-US')}</Link></h2><span className="shrink-0 text-xs font-semibold text-blue-700">Buy · Escrow</span></div>
        <p className="mt-1 text-center text-2xl font-bold text-[#112D4E]">{formatCompactMeat(auction.pricePerItem)} <span className="text-xs font-normal">Meat / item</span></p>
        <p className="truncate text-center text-xs text-gray-600">{purchased.toLocaleString('en-US')} / {target.toLocaleString('en-US')} purchased · {auction.availableQuantity ?? auction.remainingQuantity} available{auction.reducedQuantity > 0 && <> · {auction.reducedQuantity} reduced</>}</p>
        <progress aria-label="Order fulfillment" value={purchased} max={target || 1} className="mt-1 h-1.5 w-full accent-blue-600" />
        <div className="mt-auto flex items-center justify-between gap-2 text-xs"><span>{auction.buyClosingReason ? 'Closing' : result.status === 'active' ? timeRemaining(auction.endTime, now) + ' left' : result.label}</span><Link to={`/auction/${auction.id}`} className="font-semibold text-blue-700 underline">{result.status === 'active' && !auction.buyClosingReason ? 'Sell to this order' : 'View order'}</Link></div>
    </article>;
}
BuyAuctionCard.propTypes = { auction: PropTypes.object.isRequired, now: PropTypes.number.isRequired };
