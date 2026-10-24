import { attachCarouselDrag } from '../lib/carouselDrag';
import HomeAuctionCard from './HomeAuctionCard';
import StaticAuctionStrip from './StaticAuctionStrip';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { reconcileAuctionQueue, rotateAuctionQueue, readCarouselPosition, saveCarouselPosition, rotateAuctionQueueBySteps, CAROUSEL_STEP_MS } from '../lib/auctionCarousel';

// Capture the animation before React removes its DOM on route changes. Avoid
// layout effects during server rendering and browser-free component tests.
const useBrowserLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

export default function PopularAuctions({ auctions, now, children, completed = false }) {
    if (!completed) return <StaticAuctionStrip auctions={auctions} now={now} title="Popular Items" label="Popular auctions" href="/auctions" linkText="See all auctions">{children}</StaticAuctionStrip>;
    return <CompletedAuctionCarousel auctions={auctions} now={now}>{children}</CompletedAuctionCarousel>;
}

function CompletedAuctionCarousel({ auctions, now, children }) {
    const storageKey = 'khub.completedAuctions.v1';
    const [restored] = useState(() => {
        try { return readCarouselPosition(window.sessionStorage, storageKey); }
        catch { return null; }
    });
    const [order, setOrder] = useState(() => restored?.order || rotateAuctionQueue(auctions.map(auction => auction.id)));
    const trackRef = useRef(null);
    const viewportRef = useRef(null);
    const latest = useRef(null);
    const [columns, setColumns] = useState(4);
    const [paused, setPaused] = useState(restored?.paused || false);
    const [reducedMotion, setReducedMotion] = useState(false);
    const hasAuctions = auctions.length > 0;
    useEffect(() => {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
        function update() {
            const width = viewportRef.current?.clientWidth;
            if (width) setColumns(Math.max(1, Math.ceil((width + 12) / 268)));
            setReducedMotion(reduced.matches);
        }
        update();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
        if (viewportRef.current) observer?.observe(viewportRef.current);
        reduced.addEventListener('change', update);
        window.addEventListener('resize', update);
        return () => { observer?.disconnect(); reduced.removeEventListener('change', update); window.removeEventListener('resize', update); };
    }, [hasAuctions]);
    const ids = auctions.map(auction => auction.id);
    const queue = reconcileAuctionQueue(order.length ? order : rotateAuctionQueue(ids), ids);
    const byId = new Map(auctions.map(auction => [auction.id, auction]));
    const moving = auctions.length > columns && !reducedMotion;
    const displayed = moving ? queue.map(id => byId.get(id)) : auctions;
    const resumeElapsed = restored?.elapsed || 0;
    latest.current = { order: queue, ids, elapsed: latest.current?.elapsed ?? resumeElapsed, paused };
    useEffect(() => {
        if (!viewportRef.current || !trackRef.current) return;
        return attachCarouselDrag({ viewport: viewportRef.current, track: trackRef.current, moving, reducedMotion,
            rotate: steps => flushSync(() => setOrder(previous => rotateAuctionQueueBySteps(reconcileAuctionQueue(previous, latest.current.ids), steps))),
            onElapsed: elapsed => { latest.current.elapsed = elapsed; },
        });
    }, [hasAuctions, moving, reducedMotion, paused, storageKey]);
    useBrowserLayoutEffect(() => {
        function rememberPosition() {
            if (!latest.current.order.length) return; // Don't overwrite while loading.
            const animation = trackRef.current?.getAnimations()[0];
            const progress = animation?.effect?.getComputedTiming().progress;
            const elapsed = typeof progress === 'number' ? (progress * CAROUSEL_STEP_MS) % CAROUSEL_STEP_MS : latest.current.elapsed;
            try { saveCarouselPosition(window.sessionStorage, { order: latest.current.order, paused: latest.current.paused, elapsed }, storageKey); }
            catch { /* Storage may be unavailable. */ }
        }
        window.addEventListener('pagehide', rememberPosition);
        return () => {
            rememberPosition();
            window.removeEventListener('pagehide', rememberPosition);
        };
    }, [storageKey]);
    function advance(event) {
        if (event.target !== event.currentTarget || event.currentTarget.style.animation === 'none') return;
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
    return <section aria-label="Recently completed trades" className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-2xl font-bold text-gray-700">Recently Completed Trades</h2>
                <span aria-hidden="true" className="text-base text-slate-500">·</span>
                <Link to="/auctions?status=completed" className="inline-flex min-h-9 items-center text-sm text-blue-700 underline">See completed trades</Link>
            </div>
            {moving && <button type="button" onClick={() => setPaused(value => !value)}
                aria-label={paused ? 'Resume completed trade scrolling' : 'Pause completed trade scrolling'} aria-pressed={paused}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-gray-300 bg-transparent p-0 text-gray-500 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    {paused ? <path d="M4 2v12l10-6z" /> : <path d="M4 2h3v12H4zm5 0h3v12H9z" />}
                </svg>
            </button>}
        </div>
        {children}
        {auctions.length > 0 && <div ref={viewportRef} className="popular-auction-viewport" onFocusCapture={revealKeyboardFocus} onBlurCapture={resetKeyboardScroll} data-moving={moving} data-paused={paused}>
            <ul ref={trackRef} className="popular-auction-track" style={{ animationDelay: `-${resumeElapsed}ms` }} onAnimationIteration={advance}>
                {displayed.map(auction => <li key={auction.id} className="popular-auction-slot"><HomeAuctionCard auction={auction} now={now} /></li>)}
            </ul>
        </div>}
    </section>;
}
PopularAuctions.propTypes = { auctions: PropTypes.arrayOf(PropTypes.object).isRequired, now: PropTypes.number.isRequired, children: PropTypes.node, completed: PropTypes.bool };

CompletedAuctionCarousel.propTypes = { auctions: PropTypes.arrayOf(PropTypes.object).isRequired, now: PropTypes.number.isRequired, children: PropTypes.node };
