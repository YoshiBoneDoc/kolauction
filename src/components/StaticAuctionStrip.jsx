import { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { attachCarouselDrag } from '../lib/carouselDrag';
import HomeAuctionCard from './HomeAuctionCard';

export default function StaticAuctionStrip({ auctions, now, children, title, label, href, linkText, className = '', headerControls, panelId, labelledBy, resetKey }) {
    const viewport = useRef(null);
    const track = useRef(null);
    useEffect(() => {
        if (resetKey !== undefined && viewport.current) viewport.current.scrollLeft = 0;
    }, [resetKey]);
    useEffect(() => {
        if (!viewport.current || !track.current) return;
        return attachCarouselDrag({ viewport: viewport.current, track: track.current, moving: false,
            reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            rotate: () => {}, onElapsed: () => {},
        });
    }, [auctions.length, resetKey]);
    return <section aria-label={label} className={`min-w-0 ${className}`}>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-2xl font-bold text-gray-700">{title}</h2>
            {headerControls}
            {href && <><span aria-hidden="true" className="text-base text-slate-500">·</span><Link to={href} className="inline-flex min-h-9 items-center text-sm text-blue-700 underline">{linkText}</Link></>}
        </div>
        {children}
        {(auctions.length > 0 || panelId) && <div ref={viewport} className="high-rollers-viewport"
            id={panelId} role={panelId ? 'tabpanel' : undefined} aria-labelledby={labelledBy}>
            <ul ref={track} className="flex gap-3">
                {auctions.map(auction => <li key={auction.id} className="w-64 shrink-0"><HomeAuctionCard auction={auction} now={now} /></li>)}
            </ul>
        </div>}
    </section>;
}
StaticAuctionStrip.propTypes = { auctions: PropTypes.arrayOf(PropTypes.object).isRequired, now: PropTypes.number.isRequired,
    children: PropTypes.node, title: PropTypes.string.isRequired, label: PropTypes.string.isRequired,
    href: PropTypes.string, linkText: PropTypes.string, className: PropTypes.string,
    headerControls: PropTypes.node, panelId: PropTypes.string, labelledBy: PropTypes.string, resetKey: PropTypes.string };
