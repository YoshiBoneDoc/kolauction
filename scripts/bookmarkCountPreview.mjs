import { PublicAuctionCache } from '../workers/public-auction-cache/index.js';

// Vite has no Cloudflare binding. Reuse the production cache in process, rather
// than making the browser fall back to uncached database requests.
export function createBookmarkCountPreview(env) {
    const storage = new Map();
    let ready;
    const cache = new PublicAuctionCache({
        blockConcurrencyWhile(callback) { ready = callback(); },
        storage: {
            async get(key) { return storage.get(key); },
            async put(key, value) {
                if (typeof key === 'string') storage.set(key, value);
                else for (const [name, entry] of Object.entries(key)) storage.set(name, entry);
            },
        },
        waitUntil(promise) { void promise.catch(() => {}); },
    }, { SUPABASE_URL: env.VITE_SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: env.VITE_SUPABASE_PUBLISHABLE_KEY });
    return async request => {
        await ready;
        const url = new URL(request.url);
        const path = url.pathname === '/api/public-auctions' ? '/public-auctions' : '/public-bookmark-counts';
        return cache.fetch(new Request(`https://cache.internal${path}${url.search}`, {
            method: request.method,
            headers: request.headers.get('X-Khub-Live-State') === '1' ? { 'X-Khub-Live-State': '1' } : {},
        }));
    };
}
