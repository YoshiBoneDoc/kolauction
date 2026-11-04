// Session-local adjustments only. No user state enters the shared cache.
export function createBookmarkCountOverlay() {
    const users = new Map();
    const listeners = new Set();
    let version = 0;
    return {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        version: () => version,
        changed(user, id, wasSaved, saved, start, end) {
            if (!user || wasSaved === saved) return;
            if (!users.has(user)) users.set(user, new Map());
            const records = users.get(user);
            const record = records.get(id) || { changes: [], display: null };
            if (record.saved === saved) return;
            record.saved = saved;
            record.changes = record.changes.filter(change => end - change.end < 11 * 60 * 1000);
            const delta = saved ? 1 : -1;
            record.changes.push({ delta, start, end });
            if (record.display !== null) record.display = Math.max(0, record.display + delta);
            records.set(id, record);
            // A profile can hold at most 200 bookmarks; keep long sessions bounded.
            while (records.size > 400) records.delete(records.keys().next().value);
            while (users.size > 4) users.delete(users.keys().next().value);
            version++;
            for (const listener of listeners) listener();
        },
        savedIds(user, ids) {
            const result = new Set(ids);
            for (const [id, record] of users.get(user) || []) {
                if (record.saved === true) result.add(id);
                else if (record.saved === false) result.delete(id);
            }
            return result;
        },
        counts(user, snapshot) {
            if (!snapshot) return {};
            if (!user) return snapshot.counts;
            if (!users.has(user)) users.set(user, new Map());
            const records = users.get(user);
            for (const [id, count] of Object.entries(snapshot.counts)) {
                if (!records.has(id)) records.set(id, { changes: [], display: count });
            }
            while (records.size > 400) records.delete(records.keys().next().value);
            while (users.size > 4) users.delete(users.keys().next().value);
            const counts = { ...snapshot.counts };
            for (const [id, record] of records) {
                if (!(id in counts)) continue;
                // A fresh read that started after a successful write includes it.
                // Keep history until all locally cached snapshots have expired.
                const pending = record.changes.filter(change => snapshot.earliest < change.end);
                const ambiguous = pending.some(change => snapshot.latest >= change.start);
                if (ambiguous) {
                    // An origin read overlapped a write: preserve our last known
                    // display rather than risk applying the same change twice.
                    if (record.display !== null) counts[id] = record.display;
                } else {
                    counts[id] = Math.max(0, counts[id] + pending.reduce((sum, change) => sum + change.delta, 0));
                    record.display = counts[id];
                }
            }
            return counts;
        },
    };
}
export const bookmarkCountOverlay = createBookmarkCountOverlay();
