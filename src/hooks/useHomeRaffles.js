import { canViewRaffles } from '../lib/raffleVisibility';
import { UserContext } from '../context/UserContext';
import { useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { auctionNow } from '../lib/auctionClock';
import { useAuctionBoundaryNow } from './useAuctionBoundaryNow';

export default function useHomeRaffles(includePrizeNames = false) {
    const { currentUser } = useContext(UserContext);
    const [counts, setCounts] = useState(null);
    const [raffles, setRaffles] = useState([]);
    const now = useAuctionBoundaryNow(raffles.map(r => ({ endTime: Date.parse(r.ends_at) })));
    useEffect(() => {
        let active = true;
        setRaffles([]);
        if (!supabase || !canViewRaffles(currentUser)) return;
        // One bounded public read on Home mount. No polling, financial RPC or cache invalidation.
        supabase.from('mystery_raffles').select(`id,raffle_number,name,ticket_price,ends_at,created_at${includePrizeNames ? ',prizes:mystery_raffle_prizes(name)' : ''}`)
            .in('state', ['preview', 'active']).gt('ends_at', new Date(auctionNow()).toISOString())
            .order('created_at', { ascending: false }).limit(20)
            .then(({ data, error }) => { if (active && !error) setRaffles(data || []); })
            .catch(() => {});
        return () => { active = false; };
    }, [includePrizeNames, currentUser]);
    useEffect(() => {
        let active = true;
        if (currentUser?.id && raffles.length) {
            supabase.rpc('read_my_raffle_counts', { p_ids: raffles.map(r => r.id) }).then(({ data, error }) => {
                if (active && !error) setCounts({ owner: currentUser.id, data });
            }).catch(() => {});
        }
        return () => { active = false; };
    }, [currentUser?.id, raffles]);
    return (canViewRaffles(currentUser) ? raffles : []).map(r => ({ ...r, user_ticket_count: counts?.owner === currentUser?.id ? counts?.data?.[r.id] ?? '0' : '0' })).filter(r => Date.parse(r.ends_at) > now);
}
