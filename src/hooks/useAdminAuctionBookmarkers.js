import { useContext, useEffect, useState } from 'react';
import { UserContext } from '../context/UserContext';
import useAdministrator from './useAdministrator';
import { supabase } from '../lib/supabase';

// One private batch for the displayed auctions. No public cache or persistence.
export default function useAdminAuctionBookmarkers(auctions, enabled = true) {
    const admin = useAdministrator();
    const { currentUser } = useContext(UserContext);
    const userId = currentUser?.id;
    const idsKey = JSON.stringify([...new Set(auctions.map(auction => auction.id))].sort());
    const [state, setState] = useState(null);
    useEffect(() => {
        if (!admin || !enabled || !supabase || !JSON.parse(idsKey).length) return;
        let active = true;
        const controller = new AbortController();
        supabase.rpc('read_admin_auction_bookmarkers', { p_ids: JSON.parse(idsKey) }).abortSignal(controller.signal)
            .then(({ data, error }) => {
                if (!active) return;
                setState({ userId, idsKey, error: Boolean(error) || !Array.isArray(data),
                    names: !error && Array.isArray(data) ? Object.fromEntries(data.map(row => [row.auction_id, row.usernames.filter(name => typeof name === 'string')])) : {} });
            }).catch(() => { if (active) setState({ userId, idsKey, names: {}, error: true }); });
        return () => { active = false; controller.abort(); };
    }, [admin, enabled, userId, idsKey]);
    const current = admin && state?.userId === userId && state?.idsKey === idsKey ? state : null;
    return { admin, names: current?.names || {}, error: current?.error || false, loaded: Boolean(current) };
}
