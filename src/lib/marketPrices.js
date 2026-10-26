const DAY = 86400000;
const validId = id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647;

// Shared per-item cache and microtask batching: concurrent consumers share one
// request, and page changes/countdown renders never trigger polling.
function createBatchedPriceService(client, now, { rpc, parameter, key, valid }) {
    const cache = new Map(), pending = new Map();
    let scheduled = false;
    async function flush() {
        scheduled = false;
        const batch = [...pending].filter(([, value]) => !value.started).slice(0, 500);
        if (!batch.length) return;
        batch.forEach(([, value]) => { value.started = true; });
        const ids = batch.map(([id]) => id);
        try {
            const request = client.rpc(rpc, { [parameter]: ids });
            if (typeof request.abortSignal === 'function') request.abortSignal(AbortSignal.timeout(10000));
            const { data, error } = await request;
            if (error || !Array.isArray(data) || data.length !== ids.length) throw new Error('Price read unavailable');
            const rows = new Map();
            for (const row of data) {
                if (!ids.includes(row[key]) || rows.has(row[key]) || typeof row.available !== 'boolean'
                    || (row.available && (!Number.isSafeInteger(row.price_meat) || row.price_meat <= 0 || !Number.isFinite(Date.parse(row.observed_at))))
                    || (row.checked_at !== null && !Number.isFinite(Date.parse(row.checked_at)))) throw new Error('Invalid price data');
                rows.set(row[key], row);
            }
            for (const [id, entry] of batch) {
                const row = rows.get(id);
                cache.set(id, { value: row, expires: now() + 300000 });
                pending.delete(id); entry.resolve(row);
            }
        } catch {
            for (const [id, entry] of batch) {
                const value = { ...(cache.get(id)?.value || { [key]: id, available: false }), readFailed: true };
                cache.set(id, { value, expires: now() + 30000 });
                pending.delete(id); entry.resolve(value);
            }
        }
        if ([...pending.values()].some(entry => !entry.started) && !scheduled) { scheduled = true; queueMicrotask(flush); }
    }
    function loadOne(id) {
        if (!valid(id) || !client) return Promise.resolve({ [key]: id, available: false });
        const cached = cache.get(id);
        if (cached?.expires > now()) return Promise.resolve(cached.value);
        if (pending.has(id)) return pending.get(id).promise;
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        pending.set(id, { promise, resolve, started: false });
        if (!scheduled) { scheduled = true; queueMicrotask(flush); }
        return promise;
    }
    return { async load(ids) { return new Map(await Promise.all([...new Set(ids)].map(async id => [id, await loadOne(id)]))); } };
}

export function createMarketPriceService(client, now = Date.now) {
    return createBatchedPriceService(client, now, { rpc: 'read_market_prices', parameter: 'p_item_ids', key: 'item_id', valid: validId });
}

export function createCompletedMarketPriceService(client, now = Date.now) {
    return createBatchedPriceService(client, now, { rpc: 'read_completed_market_prices', parameter: 'p_auction_ids', key: 'auction_id',
        valid: id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) });
}

export function marketPriceDisplay(record, now = Date.now()) {
    if (!record?.available || !Number.isSafeInteger(record.price_meat) || record.price_meat <= 0) return { text: 'Market price unavailable', stale: false };
    return { text: `Market Value: ${record.price_meat.toLocaleString('en-US')} Meat per item`,
        stale: Boolean(record.readFailed) || !Number.isFinite(Date.parse(record.checked_at)) || (Number.isFinite(Date.parse(record.captured_at)) ? Date.parse(record.captured_at) : now) - Date.parse(record.checked_at) >= DAY };
}
