// Memory only: one instance per viewer/authorization scope, never browser storage.
const EMPTY = Object.freeze({ data: null, error: '', updatedAt: null, attemptedAt: null, refreshing: false });

export function createAuctionReadCache(read, { now = Date.now } = {}) {
    const entries = new Map(), listeners = new Set();
    let queue = Promise.resolve(), active = true;
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
        invalidate() { invalidate(); },
        pause() { active = false; invalidate(true); },
        resume() { active = true; },
        load(key, { maxAge = 30000, force = false } = {}) {
            if (!active || key == null) return Promise.resolve();
            const record = entry(key);
            if (record.request) return record.request;
            const state = record.state;
            if (!force && (state.data && state.updatedAt != null && now() - state.updatedAt < maxAge
                || state.error && now() < record.retryAt)) return Promise.resolve(state.data);
            const version = record.version;
            const controller = new AbortController();
            record.controller = controller;
            record.state = { ...state, refreshing: true };
            // Serialize different resources too: navigation/pending trades cannot
            // start a second read alongside a paginated dataset refresh.
            const task = queue.then(async () => {
                if (!active || version !== record.version) return;
                record.state = { ...record.state, attemptedAt: now() };
                try {
                    const data = await read(key, controller.signal);
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
                        record.retryAt = now() + Math.min(60000, 5000 * 2 ** Math.min(record.failures - 1, 4));
                        record.state = { ...record.state, error: failure.message || 'Auctions are temporarily unavailable.', refreshing: false, attemptedAt: now() };
                    }
                }
            }).finally(() => {
                if (record.request === task) record.request = null;
                publish();
            });
            record.request = task;
            queue = task.catch(() => {});
            publish();
            return task;
        },
    };
}
