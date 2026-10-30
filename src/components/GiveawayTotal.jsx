import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export default function GiveawayTotal() {
    const [total, setTotal] = useState(null);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setError(false);
        supabase.rpc('read_giveaway_total').then(({ data, error: failure }) => {
            if (cancelled) return;
            if (failure || !/^\d+$/.test(String(data))) setError(true);
            else setTotal(BigInt(data).toLocaleString('en-US'));
        }).catch(() => { if (!cancelled) setError(true); });
        return () => { cancelled = true; };
    }, [attempt]);
    return <aside aria-label="Total given away" className="mb-10 w-fit max-w-full text-gray-700 xl:absolute xl:right-full xl:top-12 xl:mr-8 xl:w-44">
        <h2 className="border-b border-gray-400 pb-2 text-sm font-semibold">Total Given Away</h2>
        {error ? <button onClick={() => setAttempt(value => value + 1)} className="mt-3 text-xs text-blue-700 underline">Retry loading total</button>
            : <p role="status" className="mt-3 break-words text-2xl font-bold tabular-nums tracking-tight">{total === null ? '…' : total}<span className="mt-1 block text-xs font-normal tracking-normal text-gray-500">Meat</span></p>}
    </aside>;
}
