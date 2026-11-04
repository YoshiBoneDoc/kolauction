import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { bookmarkCountOverlay } from '../lib/bookmarkCountOverlay';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { createSavedAuctionService } from '../lib/savedAuctions';

const service = createSavedAuctionService(supabase);
const cache = new Map();
const pending = new Map();
async function read(userId) {
    const existing = cache.get(userId);
    if (existing && Date.now() - existing.at < 5 * 60 * 1000) return existing.ids;
    if (pending.has(userId)) return pending.get(userId);
    const task = service.read().then(rows => {
        const ids = new Set(rows.map(row => row.id));
        cache.set(userId, { ids, at: Date.now() });
        while (cache.size > 4) cache.delete(cache.keys().next().value);
        return ids;
    });
    pending.set(userId, task);
    try { return await task; } finally { pending.delete(userId); }
}
// One private, cached list for the viewer, independent of public count snapshots.
export default function useMySavedAuctionIds() {
    const { currentUser } = useContext(UserContext);
    const userId = currentUser?.id;
    useSyncExternalStore(bookmarkCountOverlay.subscribe, bookmarkCountOverlay.version, bookmarkCountOverlay.version);
    const [state, setState] = useState(null);
    useEffect(() => {
        if (!userId) return;
        let active = true;
        let revision = 0;
        const refresh = async () => {
            const version = ++revision;
            try {
                const ids = await read(userId);
                if (active && version === revision) setState({ userId, ids });
            } catch { /* Counts still render if private preferences are unavailable. */ }
        };
        void refresh();
        return () => { active = false; };
    }, [userId]);
    return bookmarkCountOverlay.savedIds(userId, state?.userId === userId ? state.ids : []);
}
