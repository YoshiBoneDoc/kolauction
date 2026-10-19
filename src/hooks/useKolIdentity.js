import { useContext, useEffect, useState } from 'react';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';

export default function useKolIdentity() {
    const { currentUser } = useContext(UserContext);
    const userId = currentUser?.id;
    const [result, setResult] = useState(null);

    useEffect(() => {
        if (!supabase || !userId) return;
        let cancelled = false;
        async function refresh() {
            try {
                const { data, error } = await supabase.from('profiles')
                    .select('kol_player_id').eq('id', userId).single();
                if (!cancelled && !error) setResult({ userId, identity: data });
            } catch { /* Keep the last known status if the connection fails. */ }
        }
        refresh();
        const timer = setInterval(refresh, 10000);
        window.addEventListener('focus', refresh);
        return () => {
            cancelled = true;
            clearInterval(timer);
            window.removeEventListener('focus', refresh);
        };
    }, [userId]);

    return userId && result?.userId === userId ? result.identity : null;
}
