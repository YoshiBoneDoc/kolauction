// Market reference data only. Never used by bidding or escrow calculations.
export const MARKET_DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;

export function processMallPrices(raw) {
    if (!raw || raw.category !== 'allitems' || raw.count !== 20 || !Array.isArray(raw.items) || raw.items.length > 50000) throw new Error('Invalid Mall snapshot.');
    const seen = new Set();
    return raw.items.map(item => {
        if (!Number.isSafeInteger(item.id) || item.id <= 0 || item.id > 2147483647 || seen.has(item.id) || !Array.isArray(item.stores) || item.stores.length > 20) throw new Error('Invalid Mall item.');
        seen.add(item.id);
        let price = null;
        for (const store of item.stores) {
            if (!Number.isSafeInteger(store.price) || store.price <= 0 || !Number.isSafeInteger(store.quantity) || store.quantity < 0
                || !Number.isSafeInteger(store.limit) || store.limit < 0) throw new Error('Invalid Mall listing.');
            if (store.limit === 0 && store.quantity > 0) price = price === null ? store.price : Math.min(price, store.price);
        }
        return { item_id: item.id, price_meat: price };
    });
}

export async function fetchMallPrices(transport, { signal } = {}) {
    // The existing raw session supplies authentication. No recovery login, no
    // individual lookups, and no automatic retries alongside the live worker.
    if (signal?.aborted || !transport.transfersAllowed()) throw new Error('Mall refresh deferred.');
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    const response = await transport.client.session.raw('api.php', {
        method: 'POST', body: new URLSearchParams({ what: 'mallprices', for: 'kHub market estimates', category: 'allitems',
            fields: 'id,store.price,store.quantity,store.limit', count: '20' }),
        responseType: 'text', retry: 0, redirect: 'manual', timeout: 20000, signal: requestSignal,
    });
    const body = response._data;
    if (response.status !== 200 || typeof body !== 'string' || Buffer.byteLength(body) > MAX_BYTES) throw new Error('Mall response unavailable.');
    return processMallPrices(JSON.parse(body));
}

export function createMarketPriceRefresher({ store, transport, signal, log = console.log, now = Date.now, fetchPrices = fetchMallPrices }) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    let nextCheck = 0, running;
    const rpc = (name, params = {}) => store.rpc(name, params, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
    async function refresh() {
        try {
            const state = await rpc('bot_market_price_state');
            if (controller.signal.aborted) return false;
            const due = Math.max(Date.parse(state?.last_success_at) + MARKET_DAY || 0, Date.parse(state?.next_attempt_at) || 0);
            if (due > now()) { nextCheck = due; return false; }
            const observed = new Date(now()).toISOString();
            const items = await fetchPrices(transport, { signal: controller.signal });
            if (controller.signal.aborted) return false;
            await rpc('bot_import_market_prices', { p_items: items, p_observed_at: observed });
            nextCheck = Date.parse(observed) + MARKET_DAY;
            log('Mall market prices refreshed; missing unrestricted listings are marked unavailable.');
            return true;
        } catch {
            nextCheck = now() + 60 * 60 * 1000;
            if (!controller.signal.aborted) {
                // Persist backoff so a restart does not hammer KoL during outages.
                try { await rpc('bot_market_price_failure'); } catch { /* optional metadata; prices remain intact */ }
                log('Mall price refresh unavailable; previous observations retained; retrying in one hour. Auction processing continues.');
            }
            return false;
        }
    }
    return {
        refresh() {
            if (controller.signal.aborted || now() < nextCheck) return Promise.resolve(false);
            if (!running) running = refresh().finally(() => { running = null; });
            return running;
        },
        stop() { signal?.removeEventListener('abort', stop); stop(); },
    };
}
