// Memory only: one instance per viewer/authorization scope, never browser storage.
const EMPTY = Object.freeze({ data: null, error: '', updatedAt: null, attemptedAt: null, refreshing: false });

export function createAuctionReadCache(read, { now = Date.now, random = Math.random } = {}) {
    const entries = new Map(), listeners = new Set();
    let active = true, retained = new Set(), running = 0;
    const waiting = [];
    const pump = () => {
        while (running < 2 && waiting.length) {
            const { run, resolve, reject } = waiting.shift();
            running++;
            Promise.resolve().then(run).then(resolve, reject).finally(() => { running--; pump(); });
        }
    };
    const schedule = run => new Promise((resolve, reject) => { waiting.push({ run, resolve, reject }); pump(); });
    const entry = key => {
        if (!entries.has(key)) entries.set(key, { state: EMPTY, version: 0, request: null, controller: null, failures: 0, retryAt: 0 });
        return entries.get(key);
    };
    const publish = () => { for (const listener of listeners) listener(); };
    const invalidate = (clear = false) => {
        for (const record of entries.values()) {
            record.version++;
            record.controller?.abort();
            record.request = null;
            if (clear) { record.failures = 0; record.retryAt = 0; }
            record.state = clear ? EMPTY : { ...record.state, updatedAt: null, refreshing: false };
        }
        publish();
    };
    return {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        snapshot(key) { return key == null ? EMPTY : entry(key).state; },
        retryAfter(key) { return key == null ? 0 : Math.max(0, entry(key).retryAt - now()); },
        retain(keys) { retained = new Set(keys); },
        cancel(key) {
            const record = entries.get(key);
            if (!record?.request) return;
            record.version++;
            record.controller?.abort();
            record.request = null;
            record.state = { ...record.state, refreshing: false };
        },
        invalidate() { invalidate(); },
        pause() { active = false; invalidate(true); },
        resume() { active = true; },
        load(key, { maxAge = 30000, force = false, fresh = false } = {}) {
            if (!active || key == null) return Promise.resolve();
            const record = entry(key);
            // Bound search/page history in long browsing sessions. In-flight
            // requests are retained until they settle; auth changes clear all.
            for (const [oldKey, old] of entries) {
                if (entries.size <= 32) break;
                if (oldKey !== key && !retained.has(oldKey) && !old.request) entries.delete(oldKey);
            }
            if (record.request) return record.request;
            const state = record.state;
            if (!force && (state.data && state.updatedAt != null && now() - state.updatedAt < maxAge
                || state.error && now() < record.retryAt)) return Promise.resolve(state.data);
            const version = record.version;
            const controller = new AbortController();
            record.controller = controller;
            record.state = { ...state, refreshing: true };
            // Two bounded slots let a slow private read coexist with the visible page.
            const task = schedule(async () => {
                if (!active || version !== record.version) return;
                record.state = { ...record.state, attemptedAt: now() };
                try {
                    const data = await read(key, controller.signal, { force, fresh });
                    if (active && version === record.version) {
                        record.failures = 0;
                        record.retryAt = 0;
                        record.state = { data, error: '', updatedAt: now(), attemptedAt: record.state.attemptedAt, refreshing: false };
                        return data;
                    }
                } catch (failure) {
                    if (active && version === record.version) {
                        // Authorization failures must never fall back to a formerly
                        // authorized snapshot, including other cached resources.
                        if (['42501', 'PGRST301', 'PGRST302', 'PGRST303', 'KHUB_PRIVACY'].includes(failure.code)
                            || [401, 403].includes(failure.status)) invalidate(true);
                        record.failures++;
                        record.retryAt = now() + Math.max(Number(failure.retryAfterMs) || 0, Math.ceil(Math.min(60000, 5000 * 2 ** Math.min(record.failures - 1, 4)) * (1 + 0.2 * random())));
                        record.state = { ...record.state, data: record.state.data ? { ...record.state.data, auctions: record.state.data.auctions.map(auction => ({ ...auction, liveUnavailable: true })) } : null, error: failure.message || 'Auctions are temporarily unavailable.', refreshing: false, attemptedAt: now() };
                    }
                }
            }).finally(() => {
                if (record.request === task) record.request = null;
                publish();
            });
            record.request = task;
            publish();
            return task;
        },
    };
}
