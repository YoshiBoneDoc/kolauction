import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const format = value => BigInt(value).toLocaleString('en-US');

export default function AdminAnalytics() {
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setResult(null); setError('');
        supabase.rpc('read_admin_analytics').then(({ data, error: failure }) => {
            if (cancelled) return;
            if (failure || !data) setError(failure?.code === '42501' ? 'Administrator access required.' : 'Analytics are unavailable. Please retry.');
            else setResult(data);
        }).catch(() => { if (!cancelled) setError('Analytics are unavailable. Please retry.'); });
        return () => { cancelled = true; };
    }, [attempt]);
    return <section aria-label="Administrator analytics" className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div><h2 className="text-base font-semibold text-gray-900">At a glance</h2>
                <p className="mt-1 text-xs text-gray-500">Last month is the rolling month ending now. Meat totals count escrow fees and donations recorded in the income ledger.</p></div>
            <button onClick={() => setAttempt(value => value + 1)} className="min-h-11 text-sm text-blue-700 hover:underline">Refresh analytics</button>
        </div>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !result ? <p role="status" className="text-sm text-gray-500">Loading analytics…</p> : <>
            <div className="grid gap-3 sm:grid-cols-3">
                {[
                    ['Registered users', result.users.total, result.users.month, 'new last month'],
                    ['Escrow sales · fees', result.sales.total, result.sales.month, 'meat last month'],
                    ['Donations · meat', result.donations.total, result.donations.month, 'meat last month'],
                ].map(([label, total, month, caption]) => <div key={label} className="min-w-0 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                    <h3 className="text-xs font-medium text-gray-600">{label}</h3>
                    <p className="mt-2 break-words text-2xl font-semibold tabular-nums tracking-tight text-gray-900">{format(total)}</p>
                    <p className="mt-1 text-xs text-gray-500">All time</p>
                    <p className="mt-3 border-t border-gray-200 pt-2 text-xs text-gray-600"><span className="font-semibold tabular-nums text-blue-700">{format(month)}</span> {caption}</p>
                </div>)}
            </div>
            <p className="mt-3 text-xs text-gray-400">Updated {new Date(result.generated_at).toLocaleString()}</p>
        </>}
    </section>;
}
