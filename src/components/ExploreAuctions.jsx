import { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { exploreAuctions, exploreAuctionTabs } from '../lib/auctionBrowsing';
import StaticAuctionStrip from './StaticAuctionStrip';

const storageKey = 'khub.exploreAuctions.tab.v1';
function savedTab() {
    try {
        const saved = window.sessionStorage.getItem(storageKey);
        if (exploreAuctionTabs.some(tab => tab.id === saved)) return saved;
    } catch { /* Storage may be unavailable; Popular remains the default. */ }
    return 'popular';
}

export default function ExploreAuctions({ auctions, sections, now, children }) {
    const [selected, setSelected] = useState(savedTab);
    const buttons = useRef([]);
    const displayed = useMemo(() => exploreAuctions(sections?.[selected] || auctions, selected, now).slice(0, 24), [auctions, sections, selected, now]);
    const tab = exploreAuctionTabs.find(option => option.id === selected);
    useEffect(() => {
        try { window.sessionStorage.setItem(storageKey, selected); } catch { /* Optional preference. */ }
    }, [selected]);

    function onKeyDown(event, index) {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % exploreAuctionTabs.length;
        if (event.key === 'ArrowLeft') next = (index + exploreAuctionTabs.length - 1) % exploreAuctionTabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = exploreAuctionTabs.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        setSelected(exploreAuctionTabs[next].id);
        buttons.current[next]?.focus();
    }

    return <StaticAuctionStrip auctions={displayed} now={now} title="Explore Auctions" label="Explore auctions"
        href={`/auctions?status=active&sort=${tab.sort}`} linkText="See all auctions"
        panelId="explore-auctions-panel" labelledBy={`explore-tab-${selected}`} resetKey={selected}
        headerControls={<div role="tablist" aria-label="Explore auction sorting" className="flex items-baseline gap-3">
            {exploreAuctionTabs.map((option, index) => <button key={option.id} type="button" role="tab"
                id={`explore-tab-${option.id}`} aria-controls="explore-auctions-panel" aria-selected={selected === option.id}
                tabIndex={selected === option.id ? 0 : -1} ref={element => { buttons.current[index] = element; }}
                onClick={() => setSelected(option.id)} onKeyDown={event => onKeyDown(event, index)}
                className="explore-auction-tab bg-transparent">{option.label}</button>)}
        </div>}>
        {children}
    </StaticAuctionStrip>;
}
ExploreAuctions.propTypes = { auctions: PropTypes.arrayOf(PropTypes.object).isRequired,
    sections: PropTypes.object, now: PropTypes.number.isRequired, children: PropTypes.node };
