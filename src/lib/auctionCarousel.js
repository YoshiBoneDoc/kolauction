// Keep the current lap stable when popularity changes. New auctions join the
// incoming end of the queue; expired/removed auctions leave it immediately.
export function reconcileAuctionQueue(previous, current) {
    const available = new Set(current);
    const kept = [...new Set(previous)].filter(id => available.has(id));
    const included = new Set(kept);
    return [...kept, ...current.filter(id => {
        if (included.has(id)) return false;
        included.add(id); return true;
    })];
}

export function rotateAuctionQueue(ids) {
    return ids.length > 1 ? [ids.at(-1), ...ids.slice(0, -1)] : ids;
}

export const CAROUSEL_POSITION_KEY = 'khub.popularAuctions.v1';
export const CAROUSEL_STEP_MS = 9000;

export function readCarouselPosition(storage) {
    try {
        const saved = JSON.parse(storage.getItem(CAROUSEL_POSITION_KEY));
        if (!Array.isArray(saved?.order) || saved.order.some(id => typeof id !== 'string')
            || !Number.isFinite(saved.elapsed) || saved.elapsed < 0 || saved.elapsed >= CAROUSEL_STEP_MS
            || typeof saved.paused !== 'boolean') return null;
        return { order: [...new Set(saved.order)], elapsed: saved.elapsed, paused: saved.paused };
    } catch { return null; }
}

export function saveCarouselPosition(storage, position) {
    try { storage.setItem(CAROUSEL_POSITION_KEY, JSON.stringify(position)); }
    catch { /* Blocked/full browser storage must never interfere with navigation. */ }
}
