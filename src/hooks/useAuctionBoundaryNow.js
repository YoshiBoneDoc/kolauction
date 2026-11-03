import { useEffect, useState } from 'react';
import { auctionNow, subscribeAuctionClock } from '../lib/auctionClock';

// Large pages only need to rerender at lifecycle/style boundaries. The small
// visible countdown components own second-by-second updates.
export function useAuctionBoundaryNow(auctions = []) {
    const [now, setNow] = useState(auctionNow);
    const deadlines = auctions.map(auction => auction.endTime).filter(Number.isFinite).join(',');
    useEffect(() => {
        let timer;
        const update = () => {
            clearTimeout(timer);
            const at = auctionNow();
            setNow(at);
            const next = deadlines.split(',').map(Number).flatMap(end =>
                [end, end-120000, end-60000, end-10800000, end-86400000, end-259200000]).filter(at => at > auctionNow());
            if (next.length) timer = setTimeout(update, Math.min(2147483647, Math.max(1, Math.min(...next)-at+1)));
        };
        update();
        const unsubscribe = subscribeAuctionClock(update);
        return () => { clearTimeout(timer); unsubscribe(); };
    }, [deadlines]);
    return now;
}
