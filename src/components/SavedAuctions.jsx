import { bookmarkCountOverlay } from '../lib/bookmarkCountOverlay';
import AuctionItemImage from './AuctionItemImage';
import { auctionQuantityLabel } from '../lib/bundles';
import { formatCompactMeat } from '../lib/formatMeat';
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
    const { currentUser } = useContext(UserContext);
    const sequence = useRef(0);
    const [defaultMinutes, setDefaultMinutes] = useState(null);
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
                const result = await withReadDeadline(signal => service.readState(auctionId || null, signal), { signal: controller.signal });
                if (active && version === sequence.current) { setRows(result.rows); setDefaultMinutes(result.defaultMinutes); setError(''); }
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
    async function update(id, saved, minutes = null) {
        setBusy(true); setError('');
        const wasSaved = Boolean(rows?.some(row => row.id === id));
        const startedAt = Date.now();
        try {
            await service.set(id, saved, minutes);
            bookmarkCountOverlay.changed(currentUser.id, id, wasSaved, saved, startedAt, Date.now());
            // Update locally even when a follow-up read is temporarily unavailable.
            setRows(previous => saved ? [...(previous || []).filter(row => row.id !== id),
                { ...(previous || []).find(row => row.id === id), id, reminder_minutes: minutes ?? defaultMinutes ?? 0 }] : (previous || []).filter(row => row.id !== id));
            window.dispatchEvent(new Event(changed));
        } catch { setError('Saved auction could not be updated. Please try again.'); }
        finally { setBusy(false); }
    }
    async function updateDefault(minutes, applyAll = false) {
        setBusy(true);setError('');
        try {
            await service.setDefault(minutes, applyAll);
            setDefaultMinutes(minutes);
            if (applyAll) setRows(previous => previous?.map(row => ({ ...row, reminder_minutes: minutes })) ?? null);
            window.dispatchEvent(new Event(changed));
        } catch { setError('Default reminder could not be updated. Please try again.'); }
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
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6"><path d="M6 3h12v18l-6-4-6 4zM10 8l4 4m0-4-4 4" /></svg>
        </button>
        {row.reminder_attempted && <span className="text-xs profile-muted">{row.reminder_outcome === 'sent' ? 'Reminder sent' : 'Reminder claimed; no resend'}</span>}
    </div>;
    const saved = rows?.find(row => row.id === auctionId);
    return <section aria-label={auctionId ? 'Save auction' : 'Saved Auctions'} className={auctionId ? (error ? 'mb-3 space-y-2 pr-10' : '') : 'profile-transaction-section space-y-3'}>
        {!auctionId && <div className="profile-saved-header flex min-h-[26px] items-center gap-4 overflow-x-auto border-b pb-3 profile-divider">
                <h2 className="shrink-0 whitespace-nowrap text-[17px] font-semibold profile-text">My Saved Auctions</h2>
            <div className="profile-saved-default ml-auto flex shrink-0">
                <div className="ml-auto flex w-max min-w-max items-center gap-2">
                    <label className="flex items-center gap-1.5 whitespace-nowrap text-xs profile-muted">
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5 shrink-0"><path d="M18 10a6 6 0 0 0-12 0c0 5-3 7-3 7h18s-3-2-3-7M10 21h4" /></svg>
                        <span>Default reminder</span>
                        <span className="relative ml-0.5">
                            <select aria-label="Default KMail reminder" disabled={busy || defaultMinutes === null} value={defaultMinutes ?? 0}
                                onChange={event => updateDefault(Number(event.target.value))} className="profile-saved-reminder-select profile-saved-default-select">
                                {reminderOptions.map(([minutes, label]) => <option key={minutes} value={minutes}>{label}</option>)}
                            </select>
                            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2"><path d="m5 7.5 5 5 5-5" /></svg>
                        </span>
                    </label>
                    <button type="button" disabled={busy || defaultMinutes === null || !rows?.length} onClick={() => updateDefault(defaultMinutes, true)} className="profile-saved-apply">Apply to all</button>
                </div>
            </div>
        </div>}
        {error && <p role="status" className="text-xs text-red-700">{error} <button onClick={() => setReload(value => value + 1)} className="underline">Retry</button></p>}
        {auctionId ? <>
            <button type="button" aria-label={saved ? 'Remove from saved' : 'Save auction'} title={saved ? 'Remove from saved' : 'Save auction'} aria-pressed={Boolean(saved)} disabled={busy || rows === null}
                onClick={() => update(auctionId, !saved)} className="auction-bookmark-tab absolute right-2 -top-px z-10 inline-flex h-10 w-9 items-start justify-center rounded-none border-0 bg-transparent p-0 shadow-none transition-[color,filter] hover:drop-shadow-sm hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#85172D] disabled:opacity-40 sm:right-4">
                <svg aria-hidden="true" viewBox="0 0 28 38" className="h-[38px] w-7" fill="var(--auction-bookmark-fill)" stroke="#85172D" strokeWidth="1.25" strokeLinejoin="round"><path d="M1 .625h26V35.1a.8.8 0 0 1-1.22.68L14 28.5 2.22 35.78A.8.8 0 0 1 1 35.1Z" /></svg>
            </button>
        </> : rows === null ? <p className="text-xs text-gray-500">Loading saved auctions…</p> : rows.length ? <ul className="space-y-[5px]">{rows.slice(0, visibleLimit).map(row => {
            const end = Date.parse(row.end_time);
            const status = row.status ? getAuctionStatus({ status: row.status, endTime: end }, now) : null;
            const buy = row.auction_kind === 'buy';
            const cancelled = ['cancelled', 'voided'].includes(status);
            const shade = cancelled ? 'is-cancelled' : status === 'completed' ? 'is-completed' : ['expired', 'ended_no_bids'].includes(status) ? 'is-unsold' : buy ? 'is-buy' : 'is-sell';
            return <li key={row.id} className={`profile-saved-entry profile-transaction-entry profile-history-entry ${shade}`}>
                {row.image ? <AuctionItemImage src={row.image} item={row.item} size="tiny" className="profile-entry-image" fallbackText="No image" />
                    : <span className="profile-entry-image profile-entry-image-fallback" role="img" aria-label={`${row.item} image unavailable`}>No image</span>}
                <div className="profile-saved-row-details min-w-0 space-y-0.5">
                    <div className="profile-entry-row">
                        <h3 className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px] leading-[18px]">
                            <Link to={`/auction/${row.id}`} className="break-words font-semibold profile-text hover:underline">{row.auction_number && `#${row.auction_number} · `}{row.item}</Link>
                            {row.quantity != null && <span className="text-xs font-medium profile-muted">{auctionQuantityLabel({quantity:Number(row.quantity),bundleItems:row.bundle_items})}</span>}
                        </h3>
                        {status === 'active' ? <time className="profile-entry-endtime" dateTime={row.end_time}>Ends in <RemainingTime endTime={end} /></time>
                            : <span className={`profile-entry-status${status === 'completed' ? ' is-completed' : cancelled ? ' is-cancelled' : ''}`}>{auctionStatusLabels[status] || 'Unavailable'}</span>}
                    </div>
                    <div className="profile-entry-row">
                        <p className="profile-entry-secondary">{status === 'active' && <><span className="profile-entry-active">Active</span> · </>}{typeof row.escrow_mode === 'boolean' ? row.escrow_mode ? 'Escrow' : 'Direct settlement' : 'Auction'}</p>
                        <div className="profile-entry-details">
                            {buy && row.min_bid_meat != null ? <span>{Number(row.min_bid_meat).toLocaleString('en-US')} Meat / item{row.purchased_quantity != null && <> · {Number(row.purchased_quantity).toLocaleString('en-US')} / {Number(row.quantity).toLocaleString('en-US')} purchased</>}</span>
                                : status === 'active' && row.current_bid != null ? <span>Current bid: <strong>{Number(row.current_bid) > 0 ? `${formatCompactMeat(Number(row.current_bid))} Meat` : 'No bids yet'}</strong></span>
                                    : row.final_price != null && <span>Final: <strong>{formatCompactMeat(Number(row.final_price))} Meat</strong></span>}
                        </div>
                    </div>
                </div>
                <div className="profile-saved-row-controls min-w-0 max-w-full">{controls(row)}</div>
            </li>;
        })}</ul> : <p className="py-2 text-[13px] profile-label">No saved auctions yet.</p>}
        {!auctionId && rows?.length > 5 && <button type="button" className="profile-show-more" aria-expanded={visibleLimit >= rows.length}
            onClick={() => setVisibleLimit(limit => limit < rows.length ? limit + 5 : 5)}>
            {visibleLimit < rows.length ? `Show ${Math.min(5, rows.length - visibleLimit)} more ↓` : 'Show less ↑'}
        </button>}
    </section>;
}
SavedAuctionPanel.propTypes = { auctionId: PropTypes.string };
