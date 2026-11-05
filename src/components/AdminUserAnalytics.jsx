import PropTypes from 'prop-types';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const date = value => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const time = value => new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

export default function AdminUserAnalytics({ revision = 0 }) {
    const [page, setPage] = useState(1);
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => {
        let cancelled = false;
        setError('');
        supabase.rpc('read_admin_new_users', { p_page: page }).then(({ data, error: failure }) => {
            if (cancelled) return;
            if (failure || !data) setError(failure?.code === '42501' ? 'Administrator access required.' : 'User analytics are unavailable. Please refresh analytics to retry.');
            else if (page > Math.max(1, Math.ceil(Number(data.total) / 25))) setPage(Math.max(1, Math.ceil(Number(data.total) / 25)));
            else setResult(data);
        }).catch(() => { if (!cancelled) setError('User analytics are unavailable. Please refresh analytics to retry.'); });
        return () => { cancelled = true; };
    }, [page, revision]);
    if (error) return <p role="alert" className="text-sm text-red-700">{error}</p>;
    if (!result) return <p role="status" className="text-sm text-gray-500">Loading new users…</p>;
    const pages = Math.max(1, Math.ceil(Number(result.total) / 25));
    return <section aria-label="New users in the past week">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
            <div>
                <h2 className="text-sm font-medium text-gray-700">New users · past 7 days</h2>
                <p className="mt-1 text-xs text-gray-500">{date(result.since)} – {date(result.generated_at)} · Registration times shown in your local time zone.</p>
            </div>
            <p className="text-3xl font-semibold tabular-nums tracking-tight text-gray-900">{BigInt(result.total).toLocaleString('en-US')}</p>
        </div>
        <div className="overflow-hidden rounded-lg border border-gray-200">
            <div className="flex items-center justify-between gap-4 bg-gray-50 px-4 py-2 text-xs font-medium text-gray-600"><span>New members</span><span>Registered · newest first</span></div>
            {result.users.length ? <ul className="divide-y divide-gray-200">{result.users.map(user => <li key={user.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span className="break-all text-sm font-medium text-gray-900">{user.username}</span>
                <time dateTime={user.created_at} title={new Date(user.created_at).toLocaleString()} className="text-right text-xs tabular-nums text-gray-600">
                    {date(user.created_at)}<span className="ml-2 text-gray-500">{time(user.created_at)}</span>
                </time>
            </li>)}</ul> : <p className="px-4 py-6 text-center text-sm text-gray-500">No new registrations in the past 7 days.</p>}
        </div>
        {pages > 1 && <nav aria-label="New users pages" className="mt-3 flex items-center justify-between gap-3 text-xs text-gray-600">
            <button disabled={page === 1} onClick={() => setPage(value => value - 1)} className="min-h-9 rounded border border-gray-200 bg-white px-3 disabled:opacity-50">Previous</button>
            <span>Page {page} of {pages}</span>
            <button disabled={page === pages} onClick={() => setPage(value => value + 1)} className="min-h-9 rounded border border-gray-200 bg-white px-3 disabled:opacity-50">Next</button>
        </nav>}
        <p className="mt-3 text-xs text-gray-400">Updated {new Date(result.generated_at).toLocaleString()}</p>
    </section>;
}

AdminUserAnalytics.propTypes = { revision: PropTypes.number };
