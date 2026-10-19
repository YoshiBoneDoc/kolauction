import { auctionFilters, auctionSorts } from './auctionBrowsing.js';

export function auctionReadRequest(pathname, search = '') {
    if (pathname === '/') return { view: 'home' };
    if (pathname === '/profile') return { view: 'profile' };
    const detail = pathname.match(/^\/auction\/([^/]+)\/?$/);
    if (detail) return { view: 'detail', id: detail[1] };
    if (pathname !== '/auctions') return null;
    const params = new URLSearchParams(search);
    return {
        view: 'browse', search: params.get('q') || '',
        status: auctionFilters.some(([value]) => value === params.get('status')) ? params.get('status') : 'active',
        sort: auctionSorts.some(([value]) => value === params.get('sort')) ? params.get('sort') : 'ending',
        page: Math.min(1000000, Math.max(1, Number.parseInt(params.get('page'), 10) || 1)),
    };
}

export function auctionRefreshDelay(request) {
    return request?.view === 'detail' ? 10000 : 30000;
}

// Schedule after each read finishes, avoiding overlapping polling requests.
export function startAuctionRefresh({ refresh, delay, document, window, timers = globalThis, initialDelay = 0 }) {
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
            if (!stopped && !document.hidden) timer = timers.setTimeout(update, delay);
        }
    }
    function visibility() {
        timers.clearTimeout(timer);
        if (!document.hidden) update();
    }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', visibility);
    if (!document.hidden) timer = timers.setTimeout(update, initialDelay);
    return () => {
        stopped = true;
        timers.clearTimeout(timer);
        document.removeEventListener('visibilitychange', visibility);
        window.removeEventListener('focus', visibility);
    };
}
