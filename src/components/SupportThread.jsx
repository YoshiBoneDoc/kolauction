import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { createBugReportService } from '../lib/bugReports';
import { supabase } from '../lib/supabase';
import { supportCategories, threadKey, threadRoleStatus, formatSupportTimestamp, supportTimeline } from '../lib/supportThreads';
import TradeResponseBadge from './TradeResponseBadge';
import AppealEvidence from './AppealEvidence';
import AppealBanControls from './AppealBanControls';
import { createAccountRestrictionService } from '../lib/accountRestrictions';

const reports = createBugReportService(supabase);
const accounts = createAccountRestrictionService(supabase);

function RatingReview({ report, onUpdated, heading }) {
    const [editing, setEditing] = useState(false);
    const [reason, setReason] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const targetName = report.target_username || 'the other player';
    async function save(event) {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setError('');
        try {
            await reports.reviewTradeRating(report.id, !report.negative_counted, reason);
            setEditing(false);
            setReason('');
            onUpdated();
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    return <div className="grid h-full grid-cols-[minmax(0,1fr)_auto] text-xs leading-4">
        <div className={`min-w-0 px-3 py-1.5 ${editing || report.feedback_withdrawn ? 'col-span-2' : ''}`}>
        {heading}
        <p className={report.negative_counted && !report.feedback_withdrawn ? 'text-red-700' : 'text-gray-600'}>
            {report.feedback_withdrawn ? <>Incomplete report withdrawn from <strong>{targetName}&apos;s profile</strong>.</>
                : report.negative_counted ? <>Incomplete report on <strong>{targetName}&apos;s profile</strong>.</>
                : <>Incomplete report excluded from <strong>{targetName}&apos;s profile</strong>.</>}
        </p>
        <p className="text-gray-500">Reported by {report.reporter_role === 'seller' ? 'the seller' : 'the buyer'} · {report.reference}</p>
        </div>
        {!report.feedback_withdrawn && (editing ? <form onSubmit={save} className="col-span-2 space-y-2 px-3 pb-3">
            <label htmlFor={`review-${report.id}`} className="block font-medium">Reason for {report.negative_counted ? 'removing' : 'restoring'} the incomplete report on {targetName}&apos;s profile</label>
            <textarea id={`review-${report.id}`} required minLength={3} maxLength={1000} rows={2} disabled={pending} value={reason} onChange={event => setReason(event.target.value)} className="w-full rounded border border-gray-300 bg-white p-2" />
            <div className="flex flex-wrap gap-3">
                <button disabled={pending} className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 font-medium text-blue-800 disabled:opacity-50">{pending ? 'Saving…' : report.negative_counted ? 'Confirm removal' : 'Confirm restoration'}</button>
                <button type="button" disabled={pending} onClick={() => setEditing(false)} className="px-2 text-gray-600">Cancel</button>
            </div>
        </form> : <button onClick={() => setEditing(true)} aria-label={`${report.negative_counted ? 'Exclude incomplete report from' : 'Restore incomplete report on'} ${targetName}’s profile`} className="col-start-2 row-start-1 m-1 max-w-36 self-stretch rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-center text-xs font-medium leading-4 text-blue-800 transition-colors hover:border-blue-300 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">{report.negative_counted ? 'Exclude incomplete report' : 'Restore incomplete report'}</button>)}
        {error && <p role="alert" className="col-span-2 mt-2 text-red-700">{error}</p>}
        {report.rating_reviews?.length > 0 && <details className="col-span-2 mt-1">
            <summary className="cursor-pointer text-gray-500">Review history ({report.rating_reviews.length})</summary>
            <ul className="mt-2 space-y-2">{report.rating_reviews.map((review, index) => <li key={index} className="break-words text-gray-600">
                {review.counted ? 'Restored' : 'Excluded'} by {review.reviewer} · {new Date(review.created_at).toLocaleString()}: {review.reason}
            </li>)}</ul>
        </details>}
    </div>;
}
RatingReview.propTypes = { report: PropTypes.object.isRequired, onUpdated: PropTypes.func.isRequired, heading: PropTypes.node.isRequired };

function ChangeType({ thread, pending, onChange }) {
    const [editing, setEditing] = useState(false);
    const types = new Set(thread.messages.map(message => message.category));
    const category = types.size === 1 ? thread.messages[0].category : '';
    const typeLabel = { bug: 'Bug report', trade: 'Trade query', appeal: 'Ban appeal', other: 'Other' }[category] || 'Mixed types';
    return <div className="mt-1 text-xs">
        <p className="mb-1 font-medium text-gray-600">{typeLabel}</p>
        <button aria-expanded={editing} aria-controls={`type-${threadKey(thread)}`} disabled={pending} onClick={() => setEditing(value => !value)} className="rounded border border-gray-200 bg-white px-2 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-50">{editing ? 'Cancel' : 'Change type'}</button>
        {editing && <select id={`type-${threadKey(thread)}`} aria-label="Message type" value={category} disabled={pending} onChange={event => { onChange(thread, event.target.value); setEditing(false); }} className="mt-2 block max-w-full rounded border border-gray-300 bg-white p-2 text-sm text-gray-900">
            {!category && <option value="" disabled>Mixed types</option>}
            {supportCategories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>}
    </div>;
}
ChangeType.propTypes = { thread: PropTypes.object.isRequired, pending: PropTypes.bool.isRequired, onChange: PropTypes.func.isRequired };

function Participant({ thread, role }) {
    const status = threadRoleStatus(thread, role);
    return <span className="flex min-w-0 flex-col justify-between gap-2 break-words py-0.5 text-sm">
        <span className="block"><span className="text-gray-500">{role === 'seller' ? 'Seller' : 'Buyer'}: </span>
            <span className="font-medium text-gray-800">{thread.auction?.[role]?.name || 'Unknown'}</span>
        </span>
        <span className="block">{thread.auction?.escrow ? <span className="text-xs text-slate-500">Escrow</span> : <TradeResponseBadge status={status} role={role} />}</span>
    </span>;
}
Participant.propTypes = { thread: PropTypes.object.isRequired, role: PropTypes.string.isRequired };

export default function SupportThread({ thread, expanded, onToggle, pending, onCategoryChange, onStatusChange, onUpdated, onDelete }) {
    const key = threadKey(thread);
    const auction = thread.auction;
    const first = thread.messages[0];
    const isAppeal = !auction && first.category === 'appeal';
    const [banRevision, setBanRevision] = useState(0);
    const [banHistory, setBanHistory] = useState(null);
    const historyKey = `${first.id}:${banRevision}`;
    const currentHistory = banHistory?.key === historyKey ? banHistory : null;
    useEffect(() => {
        if (!isAppeal || !expanded) return;
        let cancelled = false;
        accounts.appealHistory(first.id).then(events => {
            if (!cancelled) setBanHistory({ key: historyKey, events, error: '' });
        }).catch(failure => {
            if (!cancelled) setBanHistory({ key: historyKey, events: [], error: failure.message });
        });
        return () => { cancelled = true; };
    }, [isAppeal, expanded, first.id, historyKey]);
    const timeline = supportTimeline(thread, isAppeal ? currentHistory?.events || [] : []);
    const messageCount = isAppeal ? thread.messages.length : timeline.length;
    const withdrawals = timeline.filter(message => message.message_type === 'trade_resolution');
    const state = thread.status === 'open' ? 'Open' : thread.resolution_kind === 'participant_resolved' ? 'Resolved by reporter' : 'Resolved';
    const canReopen = thread.messages.some(message => message.resolution_kind !== 'participant_resolved');
    const summary = <>
        {auction && <span className="flex h-12 w-12 shrink-0 self-center items-center justify-center rounded-md bg-gray-50">
            {auction.image ? <img src={auction.image} alt={auction.item} className="h-10 w-10 object-contain" /> : <span className="text-xs text-gray-400">No image</span>}
        </span>}
        <span className={auction ? 'grid min-w-0 flex-1 gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-stretch md:gap-4' : 'block min-w-0 flex-1'}>
            <span className="min-w-0">
                <span className={`block ${isAppeal ? 'truncate' : 'break-words'} text-sm font-semibold text-gray-900`}>{auction ? `${auction.quantity.toLocaleString('en-US')} × ${auction.item}` : thread.poll ? `Poll: ${thread.poll.question}` : first.reporter_username}</span>
                <span className={`mt-1 block text-xs text-gray-500 ${isAppeal ? 'truncate' : ''}`}>{auction ? `Auction #${auction.number || auction.id}` : first.reference} · {state} · {messageCount} {messageCount === 1 ? 'message' : 'messages'}</span>
                {withdrawals.length > 0 && <span className="mt-1 block text-xs font-semibold text-green-700">{withdrawals.length === 1 ? 'Report withdrawn' : `${withdrawals.length} reports withdrawn`}</span>}
                {!auction && <span className="mt-1 block truncate text-sm text-gray-600">{first.body}</span>}
            </span>
            {auction && <><Participant thread={thread} role="seller" /><Participant thread={thread} role="buyer" /></>}
        </span>
    </>;
    return <article className="min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className={isAppeal ? 'flex flex-wrap items-start gap-3 px-3 py-2 sm:px-4' : 'flex flex-wrap items-start gap-3 p-3 sm:p-4'}>
            {isAppeal ? <AppealBanControls reportId={first.id} expanded={expanded}
                controlsId={`body-${key}`} onToggle={onToggle} onBanUpdated={() => setBanRevision(value => value + 1)}>{summary}</AppealBanControls> : <button aria-expanded={expanded} aria-controls={`body-${key}`} onClick={onToggle} className="flex min-w-0 flex-1 basis-full items-stretch gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:basis-0">
                {summary}
                <span aria-hidden="true" className="shrink-0 self-center text-gray-400">{expanded ? '▴' : '▾'}</span>
            </button>}
            <div className={`ml-auto shrink-0 text-right ${isAppeal ? 'w-32' : 'w-fit'}`}>
                <time dateTime={thread.updated_at} className="block whitespace-nowrap text-xs leading-5 text-gray-500">{formatSupportTimestamp(thread.updated_at)}</time>
                <ChangeType thread={thread} pending={pending} onChange={onCategoryChange} />
                {onDelete && <button type="button" disabled={pending} onClick={() => onDelete(thread)}
                    className="mt-1 min-h-9 border-0 bg-transparent px-2 py-1 text-xs text-red-700 underline disabled:opacity-50">{thread.poll ? 'Delete responses' : 'Delete conversation'}</button>}
            </div>
        </div>
        {expanded && <div id={`body-${key}`} className={isAppeal ? 'space-y-3 border-t border-gray-100 px-4 py-3 sm:px-5' : 'space-y-4 border-t border-gray-100 p-4 sm:px-5'}>
            {isAppeal && (!currentHistory ? <p role="status" className="text-xs text-gray-500">Loading ban history…</p>
                : currentHistory.error && <div className="flex flex-wrap items-center gap-3 text-xs">
                    <p role="alert" className="text-red-700">{currentHistory.error}</p>
                    <button type="button" onClick={() => setBanRevision(value => value + 1)} className="text-blue-700 underline">Retry ban history</button>
                </div>)}
            {auction && <div className="space-y-3">
                <div className="flex justify-end text-xs"><Link to={`/auction/${auction.id}`} className="text-blue-700 underline">View auction</Link></div>
                <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">{['seller', 'buyer'].map(role => {
                    const heading = <h3 className="text-xs font-medium leading-4 text-gray-800"><span className="text-gray-500">{role === 'seller' ? 'Seller' : 'Buyer'}: </span>{auction[role]?.name || 'Unknown'}{auction[role]?.player_id && ` (#${auction[role].player_id})`}</h3>;
                    const ratings = thread.messages.filter(message => typeof message.negative_counted === 'boolean' && message.reporter_role === (role === 'seller' ? 'buyer' : 'seller'));
                    return <section key={role} aria-label={`${role === 'seller' ? 'Seller' : 'Buyer'} trade response`} className="min-w-0 break-words rounded-md bg-gray-50">
                        {ratings.length ? ratings.map(message => <RatingReview key={message.id} report={message} heading={heading} onUpdated={onUpdated} />) : <div className="px-3 py-1.5">{heading}</div>}
                    </section>;
                })}</div>
            </div>}
            <div className="divide-y divide-gray-100">{timeline.map(message => message.message_type === 'account_ban_event' ? <section key={message.id} aria-label="Ban history update" className="py-2 first:pt-0 last:pb-0">
                <div className={`rounded border-l-2 px-3 py-2 ${message.action === 'removed' ? 'border-green-300 bg-green-50' : 'border-red-200 bg-red-50/60'}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-1 text-xs">
                        <p className={`font-semibold ${message.action === 'removed' ? 'text-green-800' : 'text-red-800'}`}>{message.action === 'removed' ? 'Ban restriction removed' : message.action === 'updated' ? 'Ban updated' : 'Ban issued'} · {message.administrator_username}</p>
                        <time dateTime={message.created_at} className="whitespace-nowrap text-gray-500">{new Date(message.created_at).toLocaleString('en-US')}</time>
                    </div>
                    {message.action !== 'removed' && <p className="mt-1 text-xs text-gray-600">{message.expires_at ? `Banned until ${new Date(message.expires_at).toLocaleString()}` : 'Permanent ban'}</p>}
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-gray-800">{message.reason}</p>
                </div>
            </section> : message.message_type === 'trade_resolution' ? <section key={message.id} aria-label="Report withdrawal update" className="py-3 first:pt-0 last:pb-0">
                <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-1">
                        <p className="text-sm font-bold text-green-800">Report withdrawn</p>
                        {message.created_at && <time dateTime={message.created_at} className="whitespace-nowrap text-xs text-green-700">{formatSupportTimestamp(message.created_at)}</time>}
                    </div>
                    <p className="mt-1 text-sm leading-5 text-green-900"><strong>{message.reporter_username}</strong> withdrew their incomplete report{message.withdrawal_confirmed_complete ? <> and changed their response to <strong>Confirmed Complete</strong>.</> : '.'}</p>
                    <p className="mt-1 text-xs text-green-700">System update · {message.reference}</p>
                </div>
            </section> : <section key={message.id} className={`space-y-2 ${isAppeal ? 'py-2' : 'py-4'} first:pt-0 last:pb-0`}>
                <div className="flex flex-wrap items-baseline justify-between gap-1 text-xs text-gray-500">
                    <p><strong className="font-medium text-gray-800">{message.reporter_username}</strong>{message.reporter_role && ` · ${message.reporter_role}`} · {message.message_type === 'trade_rating' ? `Reported Incomplete about ${message.target_username || 'the other player'}` : message.message_type === 'trade_query' ? 'Trade query' : message.message_type === 'poll_response' ? 'Poll response' : supportCategories.find(([value]) => value === message.category)?.[1]} · {message.reference}{message.status === 'resolved' && ` · ${message.resolution_kind === 'participant_resolved' ? 'Withdrawn' : 'Resolved'}`}</p>
                    <div className="flex items-center gap-2">
                        <time dateTime={message.created_at} className="whitespace-nowrap">{formatSupportTimestamp(message.created_at)}</time>
                        {onDelete && <button type="button" disabled={pending} onClick={() => onDelete(thread, message)} aria-label={`Delete message ${message.reference}`}
                            className="min-h-9 border-0 bg-transparent px-2 py-1 text-xs text-red-700 underline disabled:opacity-50">Delete</button>}
                    </div>
                </div>
                <p className={`whitespace-pre-wrap break-words text-sm ${isAppeal ? 'leading-5' : 'leading-6'} text-gray-800`}>{message.body}</p>
                {message.has_evidence && <AppealEvidence reportId={message.id} />}
            </section>)}</div>
            <div className={`flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 ${isAppeal ? 'pt-3' : 'pt-4'}`}>
                {(thread.status === 'open' || canReopen) && <button onClick={() => onStatusChange(thread)} disabled={pending} className="button-green rounded-md border border-green-200 bg-green-50 px-4 py-2 text-sm font-medium text-green-800 disabled:opacity-50">{pending ? 'Saving…' : thread.status === 'open' ? 'Mark resolved' : 'Reopen conversation'}</button>}
                {auction && <details className="text-xs text-gray-500"><summary className="cursor-pointer">Internal reference</summary><p className="mt-1 break-all font-mono">{auction.id}</p></details>}
            </div>
        </div>}
    </article>;
}
SupportThread.propTypes = {
    thread: PropTypes.object.isRequired, expanded: PropTypes.bool.isRequired, onToggle: PropTypes.func.isRequired,
    pending: PropTypes.bool.isRequired, onCategoryChange: PropTypes.func.isRequired,
    onStatusChange: PropTypes.func.isRequired, onUpdated: PropTypes.func.isRequired,
    onDelete: PropTypes.func,
};
