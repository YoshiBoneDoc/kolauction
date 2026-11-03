import { useContext, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { createSavedAuctionService, reminderOptions } from '../lib/savedAuctions';
import { withReadDeadline } from '../lib/readDeadline';
import { startPrivateRefresh } from '../lib/privateRefresh';
import { useAuctionBoundaryNow } from '../hooks/useAuctionBoundaryNow';
import { auctionStatusLabels, getAuctionStatus } from '../lib/auctionLifecycle';
import RemainingTime from './RemainingTime';

const service = createSavedAuctionService(supabase);
const changed = 'khub:saved-auctions-changed';
export default function SavedAuctions({ auctionId }) {
    const { currentUser } = useContext(UserContext);
    if (!currentUser || currentUser.isBanned) return null;
    return <SavedAuctionPanel key={`${currentUser.id}:${auctionId || 'profile'}`} auctionId={auctionId} />;
}
SavedAuctions.propTypes = { auctionId: PropTypes.string };

function SavedAuctionPanel({ auctionId }) {
    const sequence = useRef(0);
    const [rows, setRows] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [visibleLimit, setVisibleLimit] = useState(5);
    const [reload, setReload] = useState(0);
    const now = useAuctionBoundaryNow((rows || []).map(row => ({ endTime: Date.parse(row.end_time) })));
    useEffect(() => {
        let active = true;
        const controller = new AbortController();
        const refresh = async () => {
            const version = ++sequence.current;
            try {
                const result = await withReadDeadline(signal => service.read(auctionId || null, signal), { signal: controller.signal });
                if (active && version === sequence.current) { setRows(result); setError(''); }
            } catch {
                if (active && version === sequence.current) setError('Saved auctions could not be refreshed.');
                return false;
            }
        };
        const notify = () => { void refresh(); };
        window.addEventListener(changed, notify);
        const stop = startPrivateRefresh({ refresh, interval: 60000, document, window });
        return () => { active = false; controller.abort(); stop(); window.removeEventListener(changed, notify); };
    }, [auctionId, reload]);
    async function update(id, saved, minutes = 0) {
        setBusy(true); setError('');
        try {
            await service.set(id, saved, minutes);
            // Update locally even when a follow-up read is temporarily unavailable.
            setRows(previous => saved ? [...(previous || []).filter(row => row.id !== id),
                { ...(previous || []).find(row => row.id === id), id, reminder_minutes: minutes }] : (previous || []).filter(row => row.id !== id));
            window.dispatchEvent(new Event(changed));
        } catch { setError('Saved auction could not be updated. Please try again.'); }
        finally { setBusy(false); }
    }
    const controls = row => <div className="flex max-w-full flex-wrap items-center gap-3">
        <div className="profile-saved-reminder relative min-w-0">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4">
                {row.reminder_minutes === 0 ? <><path d="m3 3 18 18M10.6 4.1A6 6 0 0 1 18 10c0 3 2 5 2 5M6.3 6.3A6 6 0 0 0 6 10c0 5-3 7-3 7h14M10 21h4" /></> : <path d="M18 10a6 6 0 0 0-12 0c0 5-3 7-3 7h18s-3-2-3-7M10 21h4" />}
            </svg>
            <select aria-label="KMail reminder" disabled={busy} value={row.reminder_minutes}
                onChange={event => update(row.id, true, Number(event.target.value))} className="profile-saved-reminder-select">
                {reminderOptions.map(([minutes, label]) => <option key={minutes} value={minutes}>{label}</option>)}
            </select>
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="pointer-events-none absolute right-2 top-3 h-3 w-3"><path d="m5 7.5 5 5 5-5" /></svg>
        </div>
        <button type="button" title="Remove from saved" aria-label="Remove from saved" disabled={busy} onClick={() => update(row.id, false)} className="profile-saved-remove inline-flex h-8 w-8 shrink-0 items-center justify-center disabled:opacity-50">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M6 3h12v18l-6-4-6 4zM10 8l4 4m0-4-4 4" /></svg>
        </button>
        {row.reminder_attempted && <span className="text-xs profile-muted">{row.reminder_outcome === 'sent' ? 'Reminder sent' : 'Reminder claimed; no resend'}</span>}
    </div>;
    const saved = rows?.find(row => row.id === auctionId);
    return <section aria-label={auctionId ? 'Save auction' : 'Saved Auctions'} className={auctionId ? (error ? 'mb-3 space-y-2 pr-10' : '') : 'profile-transaction-section space-y-3'}>
        {!auctionId && <div className="border-b pb-3 profile-divider">
            <h2 className="text-[17px] font-semibold profile-text">Saved Auctions</h2>
        </div>}
        {error && <p role="status" className="text-xs text-red-700">{error} <button onClick={() => setReload(value => value + 1)} className="underline">Retry</button></p>}
        {auctionId ? <>
            <button type="button" aria-label={saved ? 'Remove from saved' : 'Save auction'} title={saved ? 'Remove from saved' : 'Save auction'} aria-pressed={Boolean(saved)} disabled={busy || rows === null}
                onClick={() => update(auctionId, !saved)} className={`auction-bookmark-tab absolute right-4 -top-px z-10 inline-flex h-10 w-9 items-start justify-center rounded-none border-0 bg-transparent p-0 shadow-none transition-[color,filter] hover:drop-shadow-sm hover:bg-transparent hover:text-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-40 sm:right-6 ${saved ? 'text-blue-600' : 'text-slate-400'}`}>
                <svg aria-hidden="true" viewBox="0 0 28 38" className="h-[38px] w-7" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"><path d="M1 .625h26V35.1a.8.8 0 0 1-1.22.68L14 28.5 2.22 35.78A.8.8 0 0 1 1 35.1Z" /></svg>
            </button>
        </> : rows === null ? <p className="text-xs text-gray-500">Loading saved auctions…</p> : rows.length ? <ul className="space-y-[5px]">{rows.slice(0, visibleLimit).map(row => {
            const end = Date.parse(row.end_time);
            const status = row.status ? getAuctionStatus({ status: row.status, endTime: end }, now) : null;
            return <li key={row.id} className="profile-saved-entry flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-48 space-y-1">
                <Link to={`/auction/${row.id}`} className="break-words text-[13px] font-semibold profile-text hover:underline">{row.auction_number && `#${row.auction_number} · `}{row.item}</Link>
                <p className="text-xs profile-muted">{auctionStatusLabels[status] || 'Unavailable'}{status === 'active' && <> · Ends in <RemainingTime endTime={end} /></>}</p>
                </div>
                <div className="min-w-0 max-w-full shrink-0">{controls(row)}</div>
            </li>;
        })}</ul> : <p className="text-sm text-gray-500">No saved auctions yet.</p>}
        {!auctionId && rows?.length > 5 && <button type="button" className="profile-show-more" aria-expanded={visibleLimit >= rows.length}
            onClick={() => setVisibleLimit(limit => limit < rows.length ? limit + 5 : 5)}>
            {visibleLimit < rows.length ? `Show ${Math.min(5, rows.length - visibleLimit)} more ↓` : 'Show less ↑'}
        </button>}
    </section>;
}
SavedAuctionPanel.propTypes = { auctionId: PropTypes.string };
