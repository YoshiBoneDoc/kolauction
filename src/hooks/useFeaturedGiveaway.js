import { useEffect, useState } from 'react';
import { mapAuction } from '../lib/auctions';
import { auctionClockRequestStarted, auctionNow, observeAuctionServerTime } from '../lib/auctionClock';
import { startAuctionRefresh } from '../lib/auctionRefresh';
import { useNow } from './useNow';

export default function useFeaturedGiveaway() {
    const [auction, setAuction] = useState(null);
    const now = useNow();
    useEffect(() => {
        let active = true;
        let current = null;
        let failures = 0;
        const controller = new AbortController();
        const stop = startAuctionRefresh({
            document,
            delay: () => Math.max(failures ? Math.min(60000, 5000 * 2 ** failures) : 0,
                current && current.endTime > auctionNow() ? Math.min(30000, current.endTime - auctionNow()) : 30000),
            refresh: async () => {
                const started = auctionClockRequestStarted();
                try {
                    const response = await fetch('/api/public-auctions?view=featured', {
                        credentials: 'omit', cache: 'no-store', redirect: 'error',
                        headers: { Accept: 'application/json' }, signal: controller.signal,
                    });
                    if (!response.ok) throw new Error('Featured giveaway unavailable.');
                    const data = await response.json();
                    if (data?.privacy_version !== 1 || data.shared_cache_version !== 1 || !Array.isArray(data.rows)
                        || data.rows.length > 1 || !Number.isFinite(Date.parse(data.server_time))) throw new Error('Invalid featured giveaway.');
                    if (!active) return;
                    observeAuctionServerTime(data.server_time, started);
                    current = data.rows.length ? mapAuction(data.rows[0], []) : null;
                    failures = 0;
                    setAuction(current);
                } catch {
                    if (active) failures++;
                }
            },
        });
        return () => { active = false; stop(); controller.abort(); };
    }, []);
    // Never display an expired cached banner while waiting for a network refresh.
    return auction?.status === 'active' && auction.endTime > now ? auction : null;
}
