import { canViewRaffles } from '../lib/raffleVisibility';
import { UserContext } from '../context/UserContext';
import { useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { readRaffle } from '../lib/raffleService';
import { auctionNow } from '../lib/auctionClock';
import { useAuctionBoundaryNow } from './useAuctionBoundaryNow';

const EMPTY_RAFFLES = [];

export default function useHomeRaffles(includePrizeNames = false) {
    const { currentUser } = useContext(UserContext);
    const [counts, setCounts] = useState(null);
    const viewerId = currentUser?.id;
    const raffleAccess = canViewRaffles(currentUser);
    const [listing, setListing] = useState(null);
    const raffles = listing?.owner === viewerId && listing?.includePrizeNames === includePrizeNames && raffleAccess ? listing.rows : EMPTY_RAFFLES;
    const now = useAuctionBoundaryNow(raffles.map(r => ({ endTime: Date.parse(r.ends_at) })));
    useEffect(() => {
        let active = true;
        if (!supabase || !raffleAccess) return;
        // One bounded public read on Home mount. No polling, financial RPC or cache invalidation.
        readRaffle(`home-raffles:${includePrizeNames}`, () => supabase.from('mystery_raffles').select(`id,raffle_number,name,ticket_price,ends_at,created_at${includePrizeNames ? ',prizes:mystery_raffle_prizes(name)' : ''}`)
            .eq('is_test', false).in('state', ['preview', 'active']).gt('ends_at', new Date(auctionNow()).toISOString())
            .order('created_at', { ascending: false }).limit(20))
            .then(({ data, error }) => { if (active && !error) setListing({ owner: viewerId, includePrizeNames, rows: data || [] }); })
            .catch(() => {});
        return () => { active = false; };
    }, [includePrizeNames, viewerId, raffleAccess]);
    useEffect(() => {
        let active = true;
        if (currentUser?.id && raffles.length) {
            readRaffle(`counts:${raffles.map(r => r.id).sort().join(',')}`, () => supabase.rpc('read_my_raffle_counts', { p_ids: raffles.map(r => r.id) })).then(({ data, error }) => {
                if (active && !error) setCounts({ owner: currentUser.id, data });
            }).catch(() => {});
        }
        return () => { active = false; };
    }, [currentUser?.id, raffles]);
    return (canViewRaffles(currentUser) ? raffles : []).map(r => ({ ...r, user_ticket_count: counts?.owner === currentUser?.id ? counts?.data?.[r.id] ?? '0' : '0' })).filter(r => Date.parse(r.ends_at) > now);
}
