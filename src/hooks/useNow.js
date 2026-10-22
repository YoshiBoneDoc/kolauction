import { useEffect, useState } from 'react';
import { auctionNow, subscribeAuctionClock } from '../lib/auctionClock';

export function useNow() {
    const [now, setNow] = useState(auctionNow);
    useEffect(() => {
        const update = () => setNow(auctionNow());
        const unsubscribe = subscribeAuctionClock(update);
        update();
        const timer = setInterval(update, 1000);
        return () => { clearInterval(timer); unsubscribe(); };
    }, []);
    return now;
}
