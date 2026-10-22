import FittedPrice from './FittedPrice';
import SellPrice from './SellPrice';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import TradeTypeBadge from './TradeTypeBadge';
import { reconcileAuctionQueue, rotateAuctionQueue, readCarouselPosition, saveCarouselPosition, CAROUSEL_STEP_MS } from '../lib/auctionCarousel';
import { timeRemaining } from '../lib/auctionBrowsing';
import { formatCompactMeat } from '../lib/formatMeat';

// Capture the animation before React removes its DOM on route changes. Avoid
// layout effects during server rendering and browser-free component tests.
const useBrowserLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

export default function PopularAuctions({ auctions, now, children, completed = false }) {
    const storageKey = completed ? 'khub.completedAuctions.v1' : 'khub.popularAuctions.v1';
    const [restored] = useState(() => {
        try { return readCarouselPosition(window.sessionStorage, storageKey); }
        catch { return null; }
    });
    const [order, setOrder] = useState(() => restored?.order || rotateAuctionQueue(auctions.map(auction => auction.id)));
    const trackRef = useRef(null);
    const latest = useRef(null);
    const [columns, setColumns] = useState(4);
    const [paused, setPaused] = useState(restored?.paused || false);
    const [reducedMotion, setReducedMotion] = useState(false);
    useEffect(() => {
        const desktop = window.matchMedia('(min-width: 1024px)');
        const tablet = window.matchMedia('(min-width: 640px)');
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
        function update() {
            setColumns(desktop.matches ? 4 : tablet.matches ? 2 : 1);
            setReducedMotion(reduced.matches);
        }
        update();
        for (const query of [desktop, tablet, reduced]) query.addEventListener('change', update);
        return () => { for (const query of [desktop, tablet, reduced]) query.removeEventListener('change', update); };
    }, []);
    const ids = auctions.map(auction => auction.id);
    const queue = reconcileAuctionQueue(order.length ? order : rotateAuctionQueue(ids), ids);
    const byId = new Map(auctions.map(auction => [auction.id, auction]));
    const moving = auctions.length > columns && !reducedMotion;
    const displayed = moving ? queue.map(id => byId.get(id)) : auctions;
    const resumeElapsed = restored?.elapsed || 0;
    latest.current = { order: queue, elapsed: resumeElapsed, paused };
    useBrowserLayoutEffect(() => {
        function rememberPosition() {
            if (!latest.current.order.length) return; // Don't overwrite while loading.
            const animation = trackRef.current?.getAnimations()[0];
            const progress = animation?.effect?.getComputedTiming().progress;
            const elapsed = typeof progress === 'number' ? (progress * CAROUSEL_STEP_MS) % CAROUSEL_STEP_MS : latest.current.elapsed;
            try { saveCarouselPosition(window.sessionStorage, { ...latest.current, elapsed }, storageKey); }
            catch { /* Storage may be unavailable. */ }
        }
        window.addEventListener('pagehide', rememberPosition);
        return () => {
            rememberPosition();
            window.removeEventListener('pagehide', rememberPosition);
        };
    }, [storageKey]);
    function advance(event) {
        if (event.target !== event.currentTarget) return;
        // Commit the queue rotation at the animation boundary so the next card
        // enters without a jump. Each auction exists in the strip exactly once.
        flushSync(() => setOrder(previous => rotateAuctionQueue(reconcileAuctionQueue(previous.length ? previous : rotateAuctionQueue(ids), ids))));
    }
    function revealKeyboardFocus(event) {
        if (event.target.matches('a:focus-visible')) {
            // The focus-visible rule makes the strip stationary first. Bring
            // the focused card into that scrollable viewport, including cards
            // that were outside the animated window.
            event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }
    function resetKeyboardScroll(event) {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.scrollLeft = 0;
    }
    return <section aria-label={completed ? 'Recently completed trades' : 'Popular auctions'} className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-2xl font-bold text-gray-700">{completed ? 'Recently Completed Trades' : 'Popular Items'}</h2>
                <span aria-hidden="true" className="text-base text-slate-500">·</span>
                <Link to={completed ? "/auctions?status=completed" : "/auctions"} className="inline-flex min-h-9 items-center text-sm text-blue-700 underline">{completed ? 'See completed trades' : 'See all auctions'}</Link>
            </div>
            {moving && <button type="button" onClick={() => setPaused(value => !value)}
                aria-label={completed ? (paused ? 'Resume completed trade scrolling' : 'Pause completed trade scrolling') : (paused ? 'Resume auction scrolling' : 'Pause auction scrolling')} aria-pressed={paused}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-gray-300 bg-transparent p-0 text-gray-500 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    {paused ? <path d="M4 2v12l10-6z" /> : <path d="M4 2h3v12H4zm5 0h3v12H9z" />}
                </svg>
            </button>}
        </div>
        <p className="mb-3 text-sm text-gray-600">{completed ? 'Successful trades, most recently completed first.' : 'Active listings, ranked by number of bids.'}</p>
        {children}
        {auctions.length > 0 && <div className="popular-auction-viewport" onFocusCapture={revealKeyboardFocus} onBlurCapture={resetKeyboardScroll} data-moving={moving} data-paused={paused}>
            <ul ref={trackRef} className="popular-auction-track" style={{ animationDelay: `-${resumeElapsed}ms` }} onAnimationIteration={advance}>
                {displayed.map(auction => <li key={auction.id} className="popular-auction-slot">
                    <Link to={`/auction/${auction.id}`} className={`grid h-[192px] min-w-0 grid-cols-[64px_minmax(0,1fr)] grid-rows-[44px_minmax(0,1fr)_18px] gap-x-3 gap-y-1 rounded-md border ${completed ? 'bg-green-50' : 'bg-[#F8F6F4]'} p-3 shadow transition-shadow hover:shadow-lg`}>
                        <div className="col-start-1 row-span-3 row-start-1 flex items-center justify-center">
                            {auction.image && <img src={auction.image} alt="" loading="lazy" className="h-16 w-16 shrink-0 object-contain [image-rendering:pixelated]" />}
                        </div>
                        <h3 title={`${auction.item} ×${auction.quantity.toLocaleString('en-US')}`} className="col-start-2 row-start-1 line-clamp-2 break-words text-center text-lg font-bold leading-[22px] text-[#14248A]">{auction.item} <span className="text-[#5365AB]">×{auction.quantity.toLocaleString('en-US')}</span></h3>
                        <div className="col-start-2 row-start-2 flex min-h-0 min-w-0 flex-col items-center text-center">
                            <p title={`${auction.auctionKind === 'buy' ? 'Price per item' : completed ? 'Final price' : auction.currentBid ? 'Bid' : 'Minimum bid'}: ${(auction.auctionKind === 'buy' ? auction.pricePerItem : completed ? auction.finalPrice ?? auction.currentBid : auction.currentBid || auction.minBidMeat).toLocaleString('en-US')} Meat`} className="w-full min-w-0 text-[#112D4E]">
                                <span className="block text-xs font-medium leading-[14px] text-gray-500">{auction.auctionKind === 'buy' ? 'Buy · per item' : completed ? 'Final · whole listing' : auction.currentBid ? 'Bid' : 'Min'}</span>
                                <FittedPrice fitKey={`${auction.auctionKind}:${auction.pricePerItem}:${auction.finalPrice}:${auction.currentBid}:${auction.minBidMeat}:${auction.quantity}`} className={`block ${auction.auctionKind !== 'buy' && auction.quantity > 1 ? 'text-[24px]' : 'text-[30px]'} font-bold leading-[34px] tracking-tight`}>{auction.auctionKind === 'buy' ? `${formatCompactMeat(auction.pricePerItem)} Meat` : <SellPrice amount={completed ? auction.finalPrice ?? auction.currentBid : auction.currentBid || auction.minBidMeat} quantity={auction.quantity} />}</FittedPrice>
                            </p>
                            <p className="h-4 w-full truncate text-xs font-semibold leading-4 text-green-800">{auction.auctionKind === 'buy' ? `${auction.purchasedQuantity.toLocaleString('en-US')} purchased · ${(auction.availableQuantity ?? auction.remainingQuantity).toLocaleString('en-US')} available` : !completed && auction.instantPurchasePrice ? `Buyout Price: ${formatCompactMeat(auction.instantPurchasePrice)}` : null}</p>
                            <div className="flex w-full flex-1 items-center justify-center"><TradeTypeBadge escrow={auction.escrowMode} short /></div>
                        </div>
                        {completed ? <p className="col-start-2 row-start-3 whitespace-nowrap text-center text-[11px] leading-[18px] text-green-700">Trade completed{auction.completedAt && <> · <time dateTime={new Date(auction.completedAt).toISOString()}>{new Date(auction.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</time></>}</p>
                            : <p className={`col-start-2 row-start-3 whitespace-nowrap text-center text-[11px] leading-[18px] ${auction.endTime - now <= 10800000 ? 'text-red-700' : 'text-gray-600'}`}>Ends in <time dateTime={new Date(auction.endTime).toISOString()}>{timeRemaining(auction.endTime, now)}</time></p>}
                    </Link>
                </li>)}
            </ul>
        </div>}
    </section>;
}
PopularAuctions.propTypes = { auctions: PropTypes.arrayOf(PropTypes.object).isRequired, now: PropTypes.number.isRequired, children: PropTypes.node, completed: PropTypes.bool };
