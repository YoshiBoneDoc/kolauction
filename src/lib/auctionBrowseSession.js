import { auctionFilters, auctionSorts } from './auctionBrowsing.js';
import { parsePrice } from './auctionPriceRange.js';

export const AUCTION_BROWSE_SESSION_KEY = 'khub.allAuctions.v1';
export const AUCTION_BROWSE_VISIT = 'allAuctionsVisit';

function sessionStorageOrNull() {
    try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

// Store only supported browse controls; page and draft search text are included.
export function normalizeAuctionBrowseParams(input) {
    const source = new URLSearchParams(input);
    const next = new URLSearchParams();
    const query = source.get('q');
    if (query) next.set('q', query);
    for (const [key, allowed, defaultValue] of [
        ['status', auctionFilters.map(([value]) => value), 'active'],
        ['sort', auctionSorts.map(([value]) => value), null],
        ['trade', ['all', 'escrow', 'direct', 'none'], 'all'],
        ['kind', ['all', 'buy', 'sell'], 'all'],
        ['mine', ['1', 'others'], null],
    ]) {
        const value = source.get(key);
        if (allowed.includes(value) && value !== defaultValue) next.set(key, value);
    }
    for (const key of ['minPrice', 'maxPrice']) {
        const value = parsePrice(source.get(key));
        if (value != null) next.set(key, String(value));
    }
    const page = Math.min(1000000, Math.max(1, Number.parseInt(source.get('page'), 10) || 1));
    if (page > 1) next.set('page', String(page));
    return next;
}

export function readAuctionBrowseSession(storage = sessionStorageOrNull()) {
    try {
        const record = JSON.parse(storage?.getItem(AUCTION_BROWSE_SESSION_KEY) ?? 'null');
        if (record?.version !== 1 || typeof record.params !== 'string' || typeof record.source !== 'string') return null;
        return { params: normalizeAuctionBrowseParams(record.params).toString(), source: normalizeAuctionBrowseParams(record.source).toString() };
    } catch { return null; }
}

export function writeAuctionBrowseSession(params, source = params, storage = sessionStorageOrNull()) {
    const record = { version: 1, params: normalizeAuctionBrowseParams(params).toString(), source: normalizeAuctionBrowseParams(source).toString() };
    try { storage?.setItem(AUCTION_BROWSE_SESSION_KEY, JSON.stringify(record)); } catch { /* Browsing still works if storage is unavailable. */ }
    return record;
}

export function restoreAuctionBrowseParams(incoming, saved, visited = false) {
    const current = normalizeAuctionBrowseParams(incoming);
    if (!saved) return visited ? new URLSearchParams() : current;
    // Restore unfinished typing on refresh/Back to its original URL.
    if (current.toString() === saved.source) return normalizeAuctionBrowseParams(saved.params);
    // A plain navigation link resumes this tab's preferences. Existing history
    // entries and explicit filtered links keep their own URL-backed controls.
    if (!current.toString() && !visited) return normalizeAuctionBrowseParams(saved.params);
    return current;
}

export function persistAuctionBrowseParams(params, storage = sessionStorageOrNull()) {
    const source = normalizeAuctionBrowseParams(params);
    const selected = new URLSearchParams(source);
    const saved = readAuctionBrowseSession(storage);
    if (saved) {
        const oldSource = new URLSearchParams(saved.source), oldSelected = new URLSearchParams(saved.params);
        if ((oldSource.get('q') || '') !== (oldSelected.get('q') || '') && (source.get('q') || '') === (oldSource.get('q') || '')) {
            if (oldSelected.get('q')) selected.set('q', oldSelected.get('q')); else selected.delete('q');
            selected.delete('page');
        }
    }
    return writeAuctionBrowseSession(selected, source, storage);
}

export function clampAuctionPriceParams(params, bounds) {
    const next = new URLSearchParams(params);
    if (!bounds) return next;
    const requestedMin = parsePrice(next.get('minPrice')), requestedMax = parsePrice(next.get('maxPrice'));
    const min = Math.max(bounds.min, Math.min(bounds.max, requestedMin ?? bounds.min));
    const max = Math.max(min, Math.min(bounds.max, requestedMax ?? bounds.max));
    if (requestedMin != null) {
        if (min > bounds.min) next.set('minPrice', String(min)); else next.delete('minPrice');
    }
    if (requestedMax != null) {
        if (max < bounds.max) next.set('maxPrice', String(max)); else next.delete('maxPrice');
    }
    if (next.toString() !== new URLSearchParams(params).toString()) next.delete('page');
    return next;
}
