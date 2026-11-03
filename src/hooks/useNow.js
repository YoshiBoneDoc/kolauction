import { useEffect, useState } from 'react';
import { auctionNow, subscribeAuctionClock } from '../lib/auctionClock';

const listeners = new Set();
let timer;
let unsubscribeClock;
function subscribe(update) {
    listeners.add(update);
    if (listeners.size === 1) {
        const tick = () => { if (!globalThis.document?.hidden) for (const listener of listeners) listener(); };
        timer = setInterval(tick, 1000);
        unsubscribeClock = subscribeAuctionClock(tick);
    }
    return () => {
        listeners.delete(update);
        if (!listeners.size) { clearInterval(timer); unsubscribeClock?.(); }
    };
}

export function useNow() {
    const [now, setNow] = useState(auctionNow);
    useEffect(() => {
        const update = () => setNow(auctionNow());
        const unsubscribe = subscribe(update);
        update();
        return unsubscribe;
    }, []);
    return now;
}
