import { useContext, useEffect, useState, useSyncExternalStore } from 'react';

import { UserContext } from '../context/UserContext';
import { bookmarkCountOverlay } from '../lib/bookmarkCountOverlay';

// Local TTL avoids repeat reads on navigation; the shared Durable Object owns
// database freshness, coalescing, bounded storage and failure backoff.
const snapshots = new Map();
const inflight = new Map();
async function load(key) {
    const saved = snapshots.get(key);
    if (saved && Date.now() - saved.at < 5 * 60 * 1000) return saved;
    if (inflight.has(key)) return inflight.get(key);
    const task = (async () => {
        const requestedAt = Date.now();
        const response = await fetch(`/api/public-bookmark-counts?ids=${JSON.parse(key).join(',')}`, {
            credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('Counts unavailable.');
        const data = await response.json();
        const receivedAt = Date.now();
        const ids = JSON.parse(key);
        if (!Array.isArray(data.counts) || data.counts.length > 24 || data.counts.some(row =>
            !ids.includes(row.auction_id) || !Number.isSafeInteger(row.bookmark_count) || row.bookmark_count < 0)) throw new Error('Invalid counts.');
        const counts = Object.fromEntries(data.counts.map(row => [row.auction_id, row.bookmark_count]));
        const capturedAt = Date.parse(data.public_snapshot?.captured_at);
        const readStartedAt = Date.parse(data.read_started_at);
        const age = Number(data.public_snapshot?.age_seconds);
        if (!Number.isFinite(capturedAt) || !Number.isFinite(readStartedAt) || !Number.isFinite(age) || age < 0) throw new Error('Invalid count timing.');
        // Bound the read time in the browser's own clock using request latency
        // and cache age. This avoids assuming its clock matches Cloudflare's.
        const snapshot = { at: receivedAt - age * 1000, counts,
            earliest: requestedAt - (age + 1) * 1000 - Math.max(0, capturedAt - readStartedAt),
            latest: receivedAt - age * 1000 };
        snapshots.set(key, snapshot);
        while (snapshots.size > 24) snapshots.delete(snapshots.keys().next().value);
        return snapshot;
    })();
    inflight.set(key, task);
    try { return await task; } finally { inflight.delete(key); }
}
export default function useAuctionBookmarkCounts(auctions) {
    const { currentUser } = useContext(UserContext);
    useSyncExternalStore(bookmarkCountOverlay.subscribe, bookmarkCountOverlay.version, bookmarkCountOverlay.version);
    const idsKey = JSON.stringify([...new Set(auctions.map(auction => auction.id))].sort());
    const [snapshot, setSnapshot] = useState(null);
    useEffect(() => {
        if (!JSON.parse(idsKey).length) return;
        let disposed = false;
        load(idsKey).then(data => { if (!disposed) setSnapshot({ key: idsKey, ...data }); })
            .catch(() => { if (!disposed) setSnapshot({ key: idsKey, counts: {} }); });
        return () => { disposed = true; };
    }, [idsKey]);
    return snapshot?.key === idsKey ? bookmarkCountOverlay.counts(currentUser?.id, snapshot) : {};
}
