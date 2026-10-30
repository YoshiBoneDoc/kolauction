import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { mapAuction } from '../lib/auctions';

export default function useFeaturedGiveaway() {
    const [auction, setAuction] = useState(null);
    useEffect(() => {
        let active = true;
        async function load() {
            if (!supabase) return;
            const { data, error } = await supabase.rpc('read_featured_giveaway');
            if (active && !error) setAuction(data ? mapAuction(data, []) : null);
        }
        load();
        const timer = setInterval(load, 30000);
        return () => { active = false; clearInterval(timer); };
    }, []);
    return auction;
}
