import { useContext, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import SiteFooter from '../components/SiteFooter';
import { supabase } from '../lib/supabase';
import { createBugReportService } from '../lib/bugReports';
import SupportThread from '../components/SupportThread';
import AdminAccountControls from '../components/AdminAccountControls';
import AdminAuctionBanReviews from '../components/AdminAuctionBanReviews';
import { supportCategories as categories, threadKey } from '../lib/supportThreads';

const reports = createBugReportService(supabase);
function Inbox() {
    const [params, setParams] = useSearchParams();
    const category = ['all', ...categories.map(([value]) => value)].includes(params.get('category')) ? params.get('category') : 'all';
    const [status, setStatus] = useState('open');
    const [page, setPage] = useState(1);
    const [attempt, setAttempt] = useState(0);
    const [snapshot, setSnapshot] = useState(null);
    const [pending, setPending] = useState(null);
    const [actionError, setActionError] = useState('');
    const [expanded, setExpanded] = useState(() => new Set());
    const key = JSON.stringify([category, status, page, attempt]);
    const result = snapshot?.key === key ? snapshot : null;
    const visibleThreads = result?.threads || [];
    const anyExpanded = visibleThreads.some(thread => expanded.has(threadKey(thread)));
    useEffect(() => {
        setExpanded(new Set());
    }, [category, status]);
    useEffect(() => {
        let cancelled = false;
        reports.supportThreads(category, status, page).then(data => {
            if (cancelled) return;
            const lastPage = Math.max(1, Math.ceil(data.total / 20));
            if (page > lastPage) setPage(lastPage);
            else setSnapshot({ key, ...data, error: '' });
        }).catch(failure => {
            if (!cancelled) setSnapshot({ key, threads: [], total: 0, error: failure.message });
        });
        return () => { cancelled = true; };
    }, [category, status, page, key]);

    async function updateThread(thread, nextCategory) {
        if (pending) return;
        setPending(threadKey(thread));
        setActionError('');
        try {
            await reports.updateSupportThread(thread.id, thread.is_trade, nextCategory
                ? { category: nextCategory }
                : { status: thread.status === 'open' ? 'resolved' : 'open' });
            setAttempt(value => value + 1);
        } catch (failure) { setActionError(failure.message); }
        finally { setPending(null); }
    }

    function toggleThread(thread) {
        const id = threadKey(thread);
        setExpanded(previous => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    return <>
        {result && !result.error && <AdminAccountControls />}
        {result && !result.error && <AdminAuctionBanReviews />}
        <nav aria-label="Inbox categories" className="flex flex-wrap gap-x-5 gap-y-1 border-b border-gray-200">
            {[['all', 'All'], ...categories].map(([value, label]) => <button key={value} aria-current={category === value ? 'page' : undefined}
                onClick={() => { setParams(value === 'all' ? {} : { category: value }); setPage(1); setActionError(''); }}
                className={`min-h-11 border-b-2 bg-transparent px-1 text-sm ${category === value ? 'border-blue-700 font-semibold text-blue-700' : 'border-transparent text-gray-600 hover:text-blue-700'}`}>{label}</button>)}
        </nav>
        <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="report-status" className="font-semibold">Show</label>
            <select id="report-status" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }} className="min-h-11 rounded border border-gray-400 bg-white p-2">
                <option value="open">Open conversations</option><option value="resolved">Resolved conversations</option><option value="self_resolved">Resolved by reporter</option><option value="all">All conversations</option>
            </select>
            <button onClick={() => setAttempt(value => value + 1)} className="min-h-11 text-blue-700 underline">Refresh inbox</button>
            <button disabled={!visibleThreads.length} onClick={() => setExpanded(previous =>
                visibleThreads.some(thread => previous.has(threadKey(thread)))
                    ? new Set()
                    : new Set([...previous, ...visibleThreads.map(threadKey)]))}
                className="ml-auto min-h-11 border-0 bg-transparent px-0 text-sm text-blue-700 underline disabled:opacity-50">
                {anyExpanded ? 'Collapse all' : 'Open all'}
            </button>
        </div>
        {!result ? <p role="status">Loading private messages…</p> : result.error ? <p role="alert" className="text-red-700">{result.error}</p> : <>
            <p className="text-sm text-gray-600">{result.total} {result.total === 1 ? 'conversation' : 'conversations'}</p>
            {!result.threads.length && <p className="rounded border bg-white p-5">No messages here.</p>}
            <div className="space-y-2">{result.threads.map(thread => <SupportThread key={threadKey(thread)}
                thread={thread} expanded={expanded.has(threadKey(thread))} onToggle={() => toggleThread(thread)}
                pending={Boolean(pending)} onCategoryChange={updateThread} onStatusChange={thread => updateThread(thread)}
                onUpdated={() => setAttempt(value => value + 1)} />)}</div>
            {(result.total > 20 || page > 1) && <nav aria-label="Inbox pages" className="flex flex-wrap items-center justify-center gap-4">
                <button disabled={page <= 1} onClick={() => setPage(value => value - 1)} className="min-h-11 rounded border bg-white px-3 disabled:opacity-50">Previous</button>
                <span>Page {page} of {Math.max(1, Math.ceil(result.total / 20))}</span>
                <button disabled={page * 20 >= result.total} onClick={() => setPage(value => value + 1)} className="min-h-11 rounded border bg-white px-3 disabled:opacity-50">Next</button>
            </nav>}
        </>}
        {actionError && <p role="alert" className="text-red-700">{actionError}</p>}
    </>;
}

export default function BugReportInbox() {
    const { currentUser } = useContext(UserContext);
    return <div className="flex flex-1 flex-col bg-gray-50">
        <main className="mx-auto w-full max-w-6xl flex-1 space-y-5 px-4 py-6 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-3xl font-bold text-blue-700">Administrator inbox</h1>
                <div className="flex flex-wrap gap-4">
                    <Link to="/admin/polls" className="text-sm text-blue-700 underline">Manage polls</Link>
                    <Link to="/admin/banner" className="text-sm text-blue-700 underline">Manage site banner</Link>
                </div>
            </div>
            {currentUser ? <Inbox key={currentUser.id} /> : <p><Link to="/login" className="text-blue-700 underline">Log in</Link> with an administrator account to open this inbox.</p>}
        </main>
        <SiteFooter showReportLink={false} />
    </div>;
}
