import { createAuctionReadCache } from './auctionReadCache.js';

// Reuse the bounded memory cache. Tokens scope private data, including same-user
// authorization changes. Never persist keys/data or forward credentials to Workers.
export function createRaffleReads(client) {
    let scope, cache;
    const loaders = new Map();
    client?.auth.onAuthStateChange((event, session) => {
        const token = session?.access_token || 'anon';
        if (['INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED'].includes(event) && token === scope) return;
        cache?.pause(); cache = null; scope = null;
    });
    async function readRaffle(key, read, { maxAge = 15000, force = false } = {}) {
        const { data, error } = await client.auth.getSession();
        if (error) throw error;
        const token = data.session?.access_token || 'anon';
        if (token !== scope || !cache) {
            cache?.pause(); scope = token;
            cache = createAuctionReadCache(async (_key, signal) => {
                const query = loaders.get(_key)(signal);
                const result = await (query?.abortSignal ? query.abortSignal(signal) : query);
                if (result.error) throw result.error;
                return { value: result.data };
            });
        }
        const current = cache;
        loaders.set(key, read);
        try {
            const result = await current.load(key, { maxAge, force });
            const state = current.snapshot(key);
            if (current !== cache || state.error || !result) throw new Error(state.error || 'Raffle read interrupted.');
            return { data: result.value };
        } finally { if (loaders.get(key) === read) loaders.delete(key); }
    }
    readRaffle.invalidate = () => cache?.invalidate();
    return readRaffle;
}
