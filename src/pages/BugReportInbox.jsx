import { useContext, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import PropTypes from 'prop-types';
import { UserContext } from '../context/UserContext';
import AuctionNavigation from '../components/AuctionNavigation';
import SiteFooter from '../components/SiteFooter';
import { supabase } from '../lib/supabase';
import { createBugReportService } from '../lib/bugReports';

const reports = createBugReportService(supabase);
const categories = [['bug', 'Bug reports'], ['trade', 'Trade queries'], ['appeal', 'Ban appeals'], ['other', 'Other']];
const notificationLabels = {
    queued: 'Queued', sent: 'Sent', needs_review: 'Needs operator review',
    sending: 'Sending / awaiting acknowledgment', not_queued: 'Not queued',
};

function RatingReview({ report, onUpdated }) {
    const [editing, setEditing] = useState(false);
    const [reason, setReason] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function save(event) {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setError('');
        try {
            await reports.reviewTradeRating(report.id, !report.negative_counted, reason);
            onUpdated();
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    return <div className="space-y-2 rounded border border-gray-200 p-3 text-sm">
        <p>Thumbs down against <strong>{report.target_username || 'the other party'}</strong> as {report.reporter_role === 'buyer' ? 'seller' : 'buyer'}: <strong>{report.negative_counted ? 'Counted' : 'Excluded after review'}</strong>.</p>
        {report.feedback_withdrawn ? <p className="text-gray-600">Withdrawn by the reporter. This negative rating cannot be restored.</p> : editing ? <form onSubmit={save} className="space-y-2">
            <label htmlFor={`review-${report.id}`} className="block font-semibold">Review reason</label>
            <textarea id={`review-${report.id}`} required minLength={3} maxLength={1000} rows={2} disabled={pending} value={reason} onChange={event => setReason(event.target.value)} className="w-full rounded border border-gray-400 bg-white p-2" />
            <div className="flex flex-wrap gap-3">
                <button disabled={pending} className="min-h-11 rounded border border-blue-700 px-3 text-blue-700 disabled:opacity-50">{pending ? 'Saving…' : report.negative_counted ? 'Confirm removal' : 'Confirm restoration'}</button>
                <button type="button" disabled={pending} onClick={() => setEditing(false)} className="min-h-11 bg-transparent px-2 text-gray-600">Cancel</button>
            </div>
        </form> : <button onClick={() => setEditing(true)} className="min-h-11 text-blue-700 underline">{report.negative_counted ? 'Remove thumbs-down count' : 'Restore thumbs-down count'}</button>}
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {report.rating_reviews?.length > 0 && <details>
            <summary className="cursor-pointer text-gray-600">Rating review history ({report.rating_reviews.length})</summary>
            <ul className="mt-2 space-y-2">{report.rating_reviews.map((review, index) => <li key={index} className="break-words">
                {review.counted ? 'Restored' : 'Excluded'} by {review.reviewer} · {new Date(review.created_at).toLocaleString()}: {review.reason}
            </li>)}</ul>
        </details>}
    </div>;
}
RatingReview.propTypes = { report: PropTypes.object.isRequired, onUpdated: PropTypes.func.isRequired };

function Inbox() {
    const [params, setParams] = useSearchParams();
    const category = ['all', ...categories.map(([value]) => value)].includes(params.get('category')) ? params.get('category') : 'all';
    const [status, setStatus] = useState('open');
    const [page, setPage] = useState(1);
    const [attempt, setAttempt] = useState(0);
    const [snapshot, setSnapshot] = useState(null);
    const [pending, setPending] = useState(null);
    const [actionError, setActionError] = useState('');
    const [noticeMessage, setNoticeMessage] = useState('');
    const key = JSON.stringify([category, status, page, attempt]);
    const result = snapshot?.key === key ? snapshot : null;
    useEffect(() => {
        let cancelled = false;
        reports.supportInbox(category, status, page).then(data => {
            if (cancelled) return;
            const lastPage = Math.max(1, Math.ceil(data.total / 20));
            if (page > lastPage) setPage(lastPage);
            else setSnapshot({ key, ...data, error: '' });
        }).catch(failure => {
            if (!cancelled) setSnapshot({ key, reports: [], total: 0, error: failure.message });
        });
        return () => { cancelled = true; };
    }, [category, status, page, key]);

    async function changeStatus(report, nextCategory) {
        if (pending) return;
        setPending(report.id);
        setActionError('');
        try {
            if (nextCategory) await reports.setCategory(report.id, nextCategory);
            else await reports.setStatus(report.id, report.status === 'open' ? 'resolved' : 'open');
            setAttempt(value => value + 1);
        } catch (failure) { setActionError(failure.message); }
        finally { setPending(null); }
    }

    async function sendMissingNotices(report) {
        if (pending) return;
        setPending(report.id);
        setActionError('');
        setNoticeMessage('');
        try {
            const result = await reports.notifyAuctionRatings(report.auction_id);
            setNoticeMessage(`${result.queued} rating ${result.queued === 1 ? 'notice' : 'notices'} queued.${result.remaining ? ' Some recipients still need a verified KoL player number before notification.' : ''}`);
            setAttempt(value => value + 1);
        } catch (failure) { setActionError(failure.message); }
        finally { setPending(null); }
    }

    return <>
        <nav aria-label="Inbox categories" className="flex flex-wrap gap-x-5 gap-y-1 border-b border-gray-200">
            {[['all', 'All'], ...categories].map(([value, label]) => <button key={value} aria-current={category === value ? 'page' : undefined}
                onClick={() => { setParams(value === 'all' ? {} : { category: value }); setPage(1); setActionError(''); }}
                className={`min-h-11 border-b-2 bg-transparent px-1 text-sm ${category === value ? 'border-blue-700 font-semibold text-blue-700' : 'border-transparent text-gray-600 hover:text-blue-700'}`}>{label}</button>)}
        </nav>
        <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="report-status" className="font-semibold">Show</label>
            <select id="report-status" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }} className="min-h-11 rounded border border-gray-400 bg-white p-2">
                <option value="open">Open messages</option><option value="resolved">Resolved messages</option><option value="self_resolved">Resolved by reporter</option><option value="all">All messages</option>
            </select>
            <button onClick={() => setAttempt(value => value + 1)} className="min-h-11 text-blue-700 underline">Refresh inbox</button>
        </div>
        {!result ? <p role="status">Loading private messages…</p> : result.error ? <p role="alert" className="text-red-700">{result.error}</p> : <>
            <p className="text-sm text-gray-600">{result.total} {result.total === 1 ? 'message' : 'messages'}</p>
            {!result.reports.length && <p className="rounded border bg-white p-5">No messages here.</p>}
            <div className="space-y-4">{result.reports.map(report => <article key={report.id} className="min-w-0 space-y-3 rounded-lg border bg-white p-4 sm:p-6">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-lg font-bold">{report.reference} · {report.status === 'open' ? 'Open' : report.resolution_kind === 'participant_resolved' ? 'Resolved by reporter' : 'Resolved'}</h2>
                    <time dateTime={report.created_at} className="text-sm text-gray-600">{new Date(report.created_at).toLocaleString()}</time>
                </div>
                <p className="break-words text-sm">From {report.reporter_username} (#{report.reporter_kol_id}) · <a href={`https://www.kingdomofloathing.com/sendmessage.php?towho=${report.reporter_kol_id}`} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">Reply by KMail</a></p>
                <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
                    <label htmlFor={`category-${report.id}`}>Category</label>
                    <select id={`category-${report.id}`} value={report.category || 'bug'} disabled={Boolean(pending)} onChange={event => changeStatus(report, event.target.value)} className="min-h-11 rounded border border-gray-300 bg-white px-2 text-gray-900 disabled:opacity-50">
                        {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                </div>
                {report.auction_id && <p className="text-sm text-gray-600">{report.message_type === 'trade_query' ? 'Trade query from' : 'Trade issue reported by'} the {report.reporter_role}. <Link to={`/auction/${report.auction_id}`} className="text-blue-700 underline">View auction</Link>.</p>}
                <p className="whitespace-pre-wrap break-words">{report.body}</p>
                {report.auction_id && typeof report.negative_counted === 'boolean' && <RatingReview report={report} onUpdated={() => setAttempt(value => value + 1)} />}
                <p className="text-sm text-gray-600">{report.has_explanation === false ? 'No administrator KMail: no explanation was provided.' : `KMail to teres Minor: ${notificationLabels[report.notification] || 'Unknown'}`}</p>
                {report.auction_id && <div className="space-y-1 text-sm text-gray-600">
                    <p>Rated player’s KMail: {notificationLabels[report.rating_notification] || 'Not queued'}</p>
                    {Number(report.missing_rating_notices) > 0 && <button disabled={Boolean(pending)} onClick={() => sendMissingNotices(report)} className="min-h-11 text-blue-700 underline disabled:opacity-50">Send missing rating notices</button>}
                </div>}
                <button onClick={() => changeStatus(report)} disabled={Boolean(pending)} className="min-h-11 rounded border border-blue-600 bg-white px-4 py-2 text-blue-700 disabled:opacity-50">{pending === report.id ? 'Saving…' : report.status === 'open' ? 'Mark resolved' : 'Reopen message'}</button>
            </article>)}</div>
            {(result.total > 20 || page > 1) && <nav aria-label="Inbox pages" className="flex flex-wrap items-center justify-center gap-4">
                <button disabled={page <= 1} onClick={() => setPage(value => value - 1)} className="min-h-11 rounded border bg-white px-3 disabled:opacity-50">Previous messages</button>
                <span>Page {page} of {Math.max(1, Math.ceil(result.total / 20))}</span>
                <button disabled={page * 20 >= result.total} onClick={() => setPage(value => value + 1)} className="min-h-11 rounded border bg-white px-3 disabled:opacity-50">Next messages</button>
            </nav>}
        </>}
        {actionError && <p role="alert" className="text-red-700">{actionError}</p>}
        {noticeMessage && <p role="status" className="text-sm text-green-800">{noticeMessage}</p>}
    </>;
}

export default function BugReportInbox() {
    const { currentUser } = useContext(UserContext);
    return <div className="flex min-h-screen flex-col bg-gray-50">
        <div className="px-4 sm:px-6"><AuctionNavigation /></div>
        <main className="mx-auto w-full max-w-4xl flex-1 space-y-5 px-4 py-6 sm:px-6">
            <h1 className="text-3xl font-bold text-blue-700">Administrator inbox</h1>
            {currentUser ? <Inbox key={currentUser.id} /> : <p><Link to="/login" className="text-blue-700 underline">Log in</Link> with an administrator account to open this inbox.</p>}
        </main>
        <SiteFooter showReportLink={false} />
    </div>;
}
