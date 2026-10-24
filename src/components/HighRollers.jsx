import { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { attachCarouselDrag } from '../lib/carouselDrag';
import { timeRemaining, auctionEndingSoon } from '../lib/auctionBrowsing';
import { formatCompactMeat } from '../lib/formatMeat';
import FittedPrice from './FittedPrice';
import TradeTypeBadge from './TradeTypeBadge';

export default function HighRollers({ auctions, now, children }) {
    const viewport = useRef(null);
    const track = useRef(null);
    useEffect(() => {
        if (!viewport.current || !track.current) return;
        return attachCarouselDrag({ viewport: viewport.current, track: track.current, moving: false,
            reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            rotate: () => {}, onElapsed: () => {},
        });
    }, [auctions.length]);
    return <section aria-label="High Rollers" className="mb-8 min-w-0">
        <h2 className="mb-2 text-2xl font-bold text-gray-700">High Rollers</h2>
        {children}
        {auctions.length > 0 && <div ref={viewport} className="high-rollers-viewport">
            <ul ref={track} className="flex gap-3">
                {auctions.map(auction => {
                    const completed = auction.status === 'completed';
                    const buy = auction.auctionKind === 'buy';
                    const amount = buy ? auction.pricePerItem : completed ? auction.finalPrice ?? auction.currentBid : auction.currentBid || auction.minBidMeat;
                    const label = buy ? 'Buy' : completed ? 'Final' : auction.currentBid ? 'Bid' : 'Min';
                    return <li key={auction.id} className="w-64 shrink-0">
                        <Link to={`/auction/${auction.id}`} draggable={false} className={`grid h-24 min-w-0 grid-cols-[40px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_22px_18px] gap-x-2 gap-y-0.5 rounded-md border p-2 shadow transition-shadow hover:shadow-md ${completed ? 'bg-green-50' : 'bg-[#F8F6F4]'}`}>
                            <div className="col-start-1 row-span-3 row-start-1 flex items-center justify-center">
                                {auction.image && <img src={auction.image} alt="" draggable={false} loading="lazy" className="h-10 w-10 object-contain [image-rendering:pixelated]" />}
                            </div>
                            <h3 title={`${auction.item} ×${auction.quantity.toLocaleString('en-US')}`} className="col-start-2 row-start-1 line-clamp-2 self-center break-words text-sm font-bold leading-4 text-[#14248A]">{auction.item} <span className="text-[#5365AB]">×{auction.quantity.toLocaleString('en-US')}</span></h3>
                            <FittedPrice fitKey={`${label}:${amount}`} title={`${label}: ${amount.toLocaleString('en-US')} Meat${buy ? ' per item' : ''}`} className="col-start-2 row-start-2 block min-w-0 text-lg font-bold leading-[22px] text-[#112D4E]">
                                <span className="text-xs font-normal text-gray-600">{label}: </span>{formatCompactMeat(amount)} Meat{buy && <span className="text-xs font-normal text-gray-600"> / item</span>}
                            </FittedPrice>
                            <div className="col-start-2 row-start-3 flex min-w-0 items-center gap-1">
                            {completed ? <p className="min-w-0 flex-1 truncate text-[11px] leading-4 text-green-700">{auction.completedAt ? <>Completed · <time dateTime={new Date(auction.completedAt).toISOString()}>{new Date(auction.completedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></> : 'Trade completed'}</p>
                                : <p className={`min-w-0 flex-1 truncate text-[11px] leading-4 ${auctionEndingSoon(auction, now) ? 'text-red-700' : 'text-gray-600'}`}>Ends in <time dateTime={new Date(auction.endTime).toISOString()}>{timeRemaining(auction.endTime, now)}</time></p>}
                                <span className="shrink-0"><TradeTypeBadge escrow={auction.escrowMode} tiny short /></span>
                            </div>
                        </Link>
                    </li>;
                })}
            </ul>
        </div>}
    </section>;
}
HighRollers.propTypes = { auctions: PropTypes.arrayOf(PropTypes.object).isRequired, now: PropTypes.number.isRequired, children: PropTypes.node };
