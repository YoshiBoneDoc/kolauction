import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export default function AdminUserSearch() {
    const [query, setQuery] = useState('');
    const [users, setUsers] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const request = useRef(0);
    useEffect(() => () => { request.current++; }, []);
    async function search(event) {
        event.preventDefault();
        const text = query.trim();
        if (!text) return;
        const current = ++request.current;
        setBusy(true); setError(''); setUsers(null);
        try {
            const { data, error: failure } = await supabase.rpc('search_admin_users', { p_query: text });
            if (current !== request.current) return;
            if (failure || !Array.isArray(data?.users)) throw failure || new Error();
            setUsers(data.users);
        } catch (failure) {
            if (current === request.current) setError(failure?.code === '42501' ? 'Administrator access required.' : 'User search is unavailable. Check that the search migration is applied, then retry.');
        } finally { if (current === request.current) setBusy(false); }
    }
    return <section aria-labelledby="admin-user-search-title" className="mb-5 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-slate-600 dark:bg-slate-800">
        <h2 id="admin-user-search-title" className="mb-2 text-sm font-semibold text-gray-800 dark:text-slate-100">Find a user</h2>
        <form onSubmit={search} className="flex flex-wrap gap-2">
            <label className="min-w-0 flex-1"><span className="sr-only">Player name or player ID</span><input type="search" maxLength={80} value={query} onChange={event => { request.current++; setQuery(event.target.value); setBusy(false); setUsers(null); setError(''); }} placeholder="Player name or player ID" className="min-h-10 w-full rounded border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100" /></label>
            <button type="submit" disabled={busy || !query.trim()} className="min-h-10 rounded border border-blue-600 px-4 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-300 dark:hover:bg-slate-700">{busy ? 'Searching…' : 'Search'}</button>
        </form>
        {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
        {users && <div className="mt-3" aria-live="polite">{users.length ? <><ul className="divide-y divide-gray-200 dark:divide-slate-600">{users.slice(0, 25).map(user => <li key={user.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm"><Link to={`/seller/${encodeURIComponent(user.id)}`} className="font-semibold text-blue-700 underline hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-200">{user.kol_player_name || user.username || 'Player'}</Link><span className="text-xs text-gray-500 dark:text-slate-400">{user.username}{user.kol_player_id ? ` · #${user.kol_player_id}` : ' · Unlinked'}</span></li>)}</ul>{users.length > 25 && <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">Showing the first 25 matches. Refine your search for more specific results.</p>}</> : <p className="text-sm text-gray-500 dark:text-slate-400">No matching users.</p>}</div>}
    </section>;
}
