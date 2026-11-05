// Authorization-scoped, memory-only card context. No credentials/data persist or
// enter public transport. Missing cards coalesce into batches of at most 24 IDs.
export function createPrivateCardCache(read, { now = Date.now, ttl = 60000, maximum = 256 } = {}) {
    const entries = new Map(), inflight = new Map();
    let scope, generation = 0;
    const clear = () => { generation++; entries.clear(); inflight.clear(); };
    return {
        clear,
        async load(token, rows, { signal } = {}) {
            if (scope !== token) { clear(); scope = token; }
            const stamp = generation;
            const statuses = new Map(rows.map(row => [row.id, row.status]));
            const keys = [...statuses.keys()];
            for (const id of keys) {
                const value = entries.get(id);
                if (value && (now() >= value.expires || value.status !== statuses.get(id))) entries.delete(id);
            }
            const missing = keys.filter(id => !entries.has(id) && !inflight.has(id));
            for (let offset = 0; offset < missing.length; offset += 24) {
                const ids = missing.slice(offset, offset + 24);
                const task = Promise.resolve().then(() => read(ids, signal)).then(data => {
                    if (stamp !== generation) throw new Error('Auction authorization changed.');
                    if (data?.privacy_version !== 1 || !Array.isArray(data.rows) || data.rows.length > ids.length
                        || new Set(data.rows.map(row => row.id)).size !== data.rows.length || data.rows.some(row => !ids.includes(row.id))) {
                        clear(); throw Object.assign(new Error('Invalid private auction context.'), { code: 'KHUB_PRIVACY' });
                    }
                    signal?.throwIfAborted();
                    const at = now();
                    for (const id of ids) {
                        const row = data.rows.find(row => row.id === id);
                        const expiry = Date.parse(row?.my_reservation?.expires_at);
                        entries.delete(id);
                        entries.set(id, { row, status: row?.status ?? statuses.get(id), expires: Math.min(at + ttl, Number.isFinite(expiry) ? expiry : at + ttl), serverTime: data.server_time });
                    }
                }).catch(error => {
                    if (stamp === generation && (['42501','PGRST301','PGRST302','PGRST303','KHUB_PRIVACY'].includes(error.code) || [401,403].includes(error.status))) clear();
                    throw error;
                }).finally(() => { for (const id of ids) if (inflight.get(id) === task) inflight.delete(id); });
                for (const id of ids) inflight.set(id, task);
            }
            await Promise.all([...new Set(keys.map(id => inflight.get(id)).filter(Boolean))]);
            signal?.throwIfAborted();
            if (stamp !== generation) throw new Error('Auction authorization changed.');
            // A concurrent request can have observed a different listing state.
            if (keys.some(id => entries.get(id)?.status !== statuses.get(id))) throw new Error('Auction state changed; refresh to retry.');
            const values = keys.map(id => entries.get(id));
            const result = { privacy_version: 1, rows: values.flatMap(value => value?.row ? [value.row] : []),
                server_time: values.map(value => value?.serverTime).filter(Boolean).sort().at(-1) || new Date(now()).toISOString() };
            for (const id of entries.keys()) {
                if (entries.size <= maximum) break;
                if (!inflight.has(id)) entries.delete(id);
            }
            return result;
        },
    };
}
