import { useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

export default function IgnoreList() {
    const dialog = useRef(null);
    const [rows, setRows] = useState([]);
    const [playerId, setPlayerId] = useState('');
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    async function load() {
        const { data, error } = await supabase.rpc('read_player_ignores');
        if (error) throw error;
        setRows(data);
    }
    async function open() {
        dialog.current.showModal();
        setPending(true); setError('');
        try { await load(); } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    async function change(id, ignored) {
        if (pending) return;
        if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) {
            setError('Enter a positive whole KoL player ID.'); return;
        }
        setPending(true); setError('');
        try {
            const { error } = await supabase.rpc('set_player_ignored', { p_player_id: Number(id), p_ignored: ignored });
            if (error) throw error;
            window.dispatchEvent(new Event('khub:ignore-list-changed'));
            if (ignored) setPlayerId('');
            await load();
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    return <>
        <button type="button" onClick={open} disabled={!supabase} className="ml-auto text-[13px] underline whitespace-nowrap">Ignore list</button>
        <dialog ref={dialog} aria-labelledby="ignore-list-title" className="profile-panel profile-text w-[min(440px,90vw)] max-h-[80vh] overflow-auto backdrop:bg-black/60">
            <div className="flex items-center justify-between gap-4">
                <h2 id="ignore-list-title" className="font-semibold">Your ignore list</h2>
                <button type="button" onClick={() => dialog.current.close()} aria-label="Close ignore list">×</button>
            </div>
            <p className="my-3 text-sm profile-muted">Direct auctions are hidden between you and these players. Escrow auctions remain available.</p>
            {pending && <p role="status">Loading…</p>}
            {!pending && rows.length === 0 && <p className="text-sm">Your ignore list is empty.</p>}
            <ul className="my-3 space-y-2">{rows.map(row => <li key={row.id} className="flex items-center justify-between gap-3 text-sm">
                <span>{row.name ? `${row.name} (#${row.id})` : `#${row.id}`}</span>
                <button type="button" disabled={pending} onClick={() => change(row.id, false)} aria-label={`Un-ignore player ${row.id}`}>×</button>
            </li>)}</ul>
            <form onSubmit={event => { event.preventDefault(); void change(playerId.trim(), true); }} className="flex items-end gap-2">
                <label className="flex-1 text-sm">KoL player ID<input value={playerId} onChange={event => setPlayerId(event.target.value)} inputMode="numeric" required className="mt-1 block w-full rounded border bg-transparent p-2" /></label>
                <button type="submit" disabled={pending} className="profile-verification-button">Add</button>
            </form>
            {error && <p role="alert" className="mt-3 profile-warning-text">{error}</p>}
        </dialog>
    </>;
}
