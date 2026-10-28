import { parsePrice } from './auctionPriceRange.js';
import { auctionFilters, resolveAuctionSort, resolveBrowseSort } from './auctionBrowsing.js';

export function auctionReadRequest(pathname, search = '', viewerId = null) {
    pathname = pathname.replace(/\/+$/, '') || '/';
    if (pathname === '/') return { view: 'home' };
    if (pathname === '/profile') return { view: 'profile' };
    const detail = pathname.match(/^\/auction\/([^/]+)(?:\/(?:report-trade|trade-query))?\/?$/);
    if (detail) return { view: 'detail', id: detail[1] };
    const seller = pathname.match(/^\/seller\/([^/]+)\/?$/);
    if (pathname !== '/auctions' && !seller) return null;
    const params = new URLSearchParams(search);
    const status = auctionFilters.some(([value]) => value === params.get('status')) ? params.get('status') : seller ? 'all' : 'active';
    return {
        view: seller ? 'seller' : 'browse', ...(seller ? { id: seller[1] } : {}),
        ...(!seller && viewerId && params.get('mine') === '1' ? { sellerId: viewerId } : {}),
        ...(!seller && viewerId && params.get('mine') === 'others' ? { excludeOwn: true } : {}), search: params.get('q') || '',
        ...(['buy', 'sell'].includes(params.get('kind')) ? { kind: params.get('kind') } : {}),
        status,
        ...(!seller && parsePrice(params.get('minPrice')) != null ? { minPrice: parsePrice(params.get('minPrice')) } : {}),
        ...(!seller && parsePrice(params.get('maxPrice')) != null ? { maxPrice: parsePrice(params.get('maxPrice')) } : {}),
        ...(['escrow', 'direct', 'none'].includes(params.get('trade')) ? { trade: params.get('trade') } : {}),
        sort: (seller ? resolveAuctionSort : resolveBrowseSort)(status, params.get('sort')),
        page: Math.min(1000000, Math.max(1, Number.parseInt(params.get('page'), 10) || 1)),
    };
}

export function auctionRefreshDelay(request, auctions = [], now = Date.now()) {
    // Public summary/page reads keep a stable cadence during simultaneous endings.
    if (['home', 'browse'].includes(request?.view)) return 60000;
    let delay = request?.view === 'detail' ? 10000 : 30000;
    for (const auction of auctions) {
        if (auction.status !== 'active') continue;
        const remaining = auction.endTime - now;
        if (!Number.isFinite(remaining) || remaining <= 0) continue;
        // One page-level read at the next deadline, even with simultaneous expirations.
        delay = Math.min(delay, remaining);
        if (auction.auctionKind === 'buy' || auction.biddingRestricted) continue;
        if (remaining <= 60000) delay = Math.min(delay, 5000);
        // Wake at the final-minute boundary without introducing a second timer.
        else delay = Math.min(delay, remaining - 60000);
    }
    return delay;
}

// Schedule after each read finishes, avoiding overlapping polling requests.
export function startAuctionRefresh({ refresh, delay, document, timers = globalThis, initialDelay = 0, jitter = 0, random = Math.random }) {
    let stopped = false;
    let running = false;
    let timer;
    async function update() {
        timers.clearTimeout(timer);
        if (stopped || running || document.hidden) return;
        running = true;
        try { await refresh(); }
        finally {
            running = false;
            if (!stopped && !document.hidden) timer = timers.setTimeout(update, Math.ceil((typeof delay === 'function' ? delay() : delay) * (1 + jitter * random())));
        }
    }
    function visibility() {
        timers.clearTimeout(timer);
        if (!document.hidden) update();
    }
    document.addEventListener('visibilitychange', visibility);
    if (!document.hidden) timer = timers.setTimeout(update, initialDelay);
    return () => {
        stopped = true;
        timers.clearTimeout(timer);
        document.removeEventListener('visibilitychange', visibility);
    };
}
