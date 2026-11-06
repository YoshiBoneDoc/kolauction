import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { bookmarkCountOverlay } from '../lib/bookmarkCountOverlay';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { createSavedAuctionService } from '../lib/savedAuctions';

const service = createSavedAuctionService(supabase);
const cache = new Map();
const pending = new Map();
async function read(scope) {
    const existing = cache.get(scope);
    if (existing && Date.now() - existing.at < 5 * 60 * 1000) return existing.ids;
    if (pending.has(scope)) return pending.get(scope);
    const task = service.readIds().then(rows => {
        const ids = new Set(rows);
        cache.set(scope, { ids, at: Date.now() });
        while (cache.size > 4) cache.delete(cache.keys().next().value);
        return ids;
    });
    pending.set(scope, task);
    try { return await task; } finally { pending.delete(scope); }
}
// One private, cached list for the viewer, independent of public count snapshots.
export default function useMySavedAuctionIds() {
    const { currentUser, authorizationScope } = useContext(UserContext);
    const userId = currentUser?.id;
    const scope = authorizationScope || userId;
    useSyncExternalStore(bookmarkCountOverlay.subscribe, bookmarkCountOverlay.version, bookmarkCountOverlay.version);
    const [state, setState] = useState(null);
    useEffect(() => {
        if (!userId) return;
        let active = true;
        let revision = 0;
        const refresh = async () => {
            const version = ++revision;
            try {
                const ids = await read(scope);
                if (active && version === revision) setState({ userId, scope, ids });
            } catch { /* Counts still render if private preferences are unavailable. */ }
        };
        void refresh();
        return () => { active = false; };
    }, [userId, scope]);
    return bookmarkCountOverlay.savedIds(userId, userId && state?.userId === userId && (state.scope || state.userId) === scope ? state.ids : []);
}
