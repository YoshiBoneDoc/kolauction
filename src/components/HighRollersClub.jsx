import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import HighRollersInvitation from './HighRollersInvitation';

export default function HighRollersClub() {
    const [preview, setPreview] = useState(false);
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [player, setPlayer] = useState('');
    const [offset, setOffset] = useState(0);
    const [revision, setRevision] = useState(0);
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!open) return;
        let active = true;
        setResult(null);
        const timer = setTimeout(async () => {
            try {
                const { data, error: failure } = await supabase.rpc('read_high_rollers_members', { p_search: search, p_offset: offset });
                if (!active) return;
                if (failure) throw failure;
                setResult(data); setError('');
            } catch { if (active) setError('Club members unavailable. Apply migration 219, then refresh.'); }
        }, 200);
        return () => { active = false; clearTimeout(timer); };
    }, [open, search, offset, revision]);
    async function update(name, args) {
        setBusy(true); setError(''); setNotice('');
        try {
            const { error: failure } = await supabase.rpc(name, args);
            if (failure) throw failure;
            setNotice(name === 'add_high_rollers_member' ? 'Invitation sent.' : 'Member removed.');
            setPlayer(''); setOffset(0); setRevision(value => value + 1);
            window.dispatchEvent(new Event('khub:refresh-account'));
        } catch (failure) { setError(failure.message || 'Membership update failed.'); }
        finally { setBusy(false); }
    }
    return <details className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-xs" onToggle={event => setOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-semibold">MMG High Rollers Club</summary>
        {preview && <HighRollersInvitation preview onPreviewClose={() => setPreview(false)} />}
        {open && <div className="mt-3 space-y-3">
            <p>Members can view raffles and buy tickets. Hosting and administration remain restricted to administrators.</p>
            <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (!busy && player.trim()) update('add_high_rollers_member', { p_player: player.trim() }); }}>
                <label className="flex-1">Add by KoL username or player ID<input className="mt-1 block w-full rounded border px-2 py-2" value={player} onChange={event => setPlayer(event.target.value)} required maxLength={100} /></label>
                <div className="flex flex-col items-end gap-1">
                    <button type="button" className="text-xs text-gray-500 underline" onClick={() => setPreview(true)}>preview invite</button>
                    <button className="rounded border px-3 py-2" disabled={busy || !player.trim()}>Send invitation</button>
                </div>
            </form>
            <p className="text-gray-500">Use an exact username or ID belonging to a registered kHub account.</p>
            <label className="block">Search members by username or player ID<input type="search" className="mt-1 block w-full rounded border px-2 py-2" value={search} maxLength={100} onChange={event => { setSearch(event.target.value); setOffset(0); }} /></label>
            {error && <p role="alert" className="text-red-700">{error}</p>}
            {notice && <p role="status">{notice}</p>}
            {!result && !error && <p role="status">Loading members…</p>}
            {result && <><p>{result.total} club members</p><ul className="max-h-48 space-y-1 overflow-y-auto">{result.members.map(member => <li className="flex items-center justify-between gap-3 py-1" key={member.player_id}>
                <span>{member.username} <span className="text-gray-500">(#{member.player_id}) · {member.status}</span></span>
                <button className="text-red-700 underline" disabled={busy} aria-label={`Remove ${member.username} from club`} onClick={() => update('remove_high_rollers_member', { p_player_id: member.player_id })}>Remove</button>
            </li>)}</ul>{!result.members.length && <p>No matching members.</p>}
                {(offset > 0 || result.members.length === 50) && <div className="flex gap-4"><button disabled={!offset || busy} onClick={() => setOffset(offset - 50)}>Previous</button><span>Page {offset / 50 + 1}</span><button disabled={result.members.length < 50 || busy} onClick={() => setOffset(offset + 50)}>Next</button></div>}
            </>}
        </div>}
    </details>;
}
