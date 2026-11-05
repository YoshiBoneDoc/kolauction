import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { supabase } from '../lib/supabase';

export default function RaffleManagement({ raffleId, ownerId, onChange }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [amount, setAmount] = useState('');
    const [revision, setRevision] = useState(0);
    const storageKey = `raffle-advance:${ownerId}:${raffleId}`;
    const [request, setRequest] = useState(() => {
        try { return JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { return null; }
    });
    const acting = useRef(false);
    useEffect(() => {
        let active = true;
        supabase.rpc('read_raffle_management', { p_id: raffleId }).then(({ data: value, error: failure }) => {
            if (!active) return;
            if (failure) setError('Management data unavailable. Refresh to retry.');
            else { setData(value); setError(''); }
        }).catch(() => { if (active) setError('Management data unavailable.'); });
        return () => { active = false; };
    }, [raffleId, ownerId, revision]);
    async function act(action) {
        if (acting.current) return;
        acting.current = true;
        setBusy(true); setError('');
        try {
            let params = { p_id: raffleId };
            if (action === 'request_raffle_advance') {
                if (!request && (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > BigInt(data.available_advance))) throw new Error('Enter an amount within available proceeds.');
                // Retain identity and amount on ambiguous failures. A retry cannot send twice.
                const pending = request ?? { id: crypto.randomUUID(), amount };
                // Persist before the RPC so reloads retain the exact idempotency key.
                sessionStorage.setItem(storageKey, JSON.stringify(pending));
                setRequest(pending);
                params = { ...params, p_request_id: pending.id, p_amount: pending.amount };
            }
            const { error: failure } = await supabase.rpc(action, params);
            if (failure) throw new Error('Action not confirmed. Refresh or retry the same request safely.');
            if (action === 'request_raffle_advance') { sessionStorage.removeItem(storageKey); setRequest(null); }
            setAmount(''); setRevision(v => v + 1); onChange();
        } catch (failure) { setError(failure.message); }
        finally { acting.current = false; setBusy(false); }
    }
    const missing = data?.prize ? BigInt(data.prize.quantity) - BigInt(data.inventory.find(i => i.item_id === data.prize.item_id)?.quantity ?? '0') : 0n;
    const prizeDeliveries = data?.deliveries.filter(d => d.reference.includes(':prize:')) ?? [];
    return <section className="raffle-summary mt-4" aria-label="Raffle management">
        <h2>Manage raffle</h2>
        {error && <p role="alert">{error}</p>}
        <button disabled={busy} onClick={() => { setRevision(v => v + 1); onChange(); }}>Refresh status</button>
        {data && <>
            <p>Status: {data.state}{data.completion_reason && ` · ${data.completion_reason.replaceAll('_', ' ')}`}. Real Meat and item transfers are enabled.</p>
            {data.state === 'preview' && <button disabled={busy || !data.activation_enabled} onClick={() => act('activate_mystery_raffle')}>Activate raffle</button>}
            {['preview', 'active'].includes(data.state) && <button disabled={busy} onClick={() => act('cancel_mystery_raffle')}>Cancel raffle and refund tickets</button>}
            {data.prize && <p>Selected prize: {data.prize.quantity} × {data.prize.name} (#{data.prize.item_id}). Winner: #{data.winner_player_id}.</p>}
            {prizeDeliveries.length ? <p>Prize delivery: {prizeDeliveries.every(d => d.state === 'sent') ? 'Verified' : 'Awaiting verification'}. Never resend an uncertain transfer.</p> : data.state === 'fulfilling' && <p>Action needed: acquire and deposit {missing > 0n ? missing.toString() : '0'} missing prize items.</p>}
            {['active', 'fulfilling'].includes(data.state) && !prizeDeliveries.length && <p>KMail kHub (#3888760): <code>SUPPLY {raffleId}</code> with listed prize items attached. Partial and repeat deposits are supported. Attach prize items only, without Meat.</p>}
            <p>Ticket proceeds: {data.revenue} Meat · Advances committed: {data.advanced_meat} Meat · Still reserved: {data.held_meat} Meat.</p>
            {(BigInt(data.available_advance) > 0n || request) && <div><label>Advance from available proceeds ({data.available_advance} Meat)<input inputMode="numeric" value={request?.amount ?? amount} disabled={busy || !!request} onChange={e => setAmount(e.target.value)} /></label><button disabled={busy} onClick={() => act('request_raffle_advance')}>{request ? 'Retry same advance' : 'Request Meat advance'}</button></div>}
            <h3>Reserved items</h3><ul>{data.inventory.map(i => <li key={i.item_id}>{i.name}: {i.quantity}</li>)}</ul>
            <h3>Deposit history</h3><ul>{data.deposits.map(d => <li key={d.receipt_id}>KMail {d.receipt_id}: prize items{d.items.map(i => ` · #${i.id} × ${i.quantity}`).join('')}</li>)}</ul>
            <h3>Advances</h3><ul>{data.advances.map(a => <li key={a.request_id}>{a.amount} Meat · {new Date(a.created_at).toLocaleString()}</li>)}</ul>
            <h3>Delivery and settlement progress</h3><ul>{data.deliveries.map(d => <li key={d.reference}>{d.reference.split(':').slice(2).join(' · ')}: {d.state} · {d.meat} Meat{d.item_id ? ` · #${d.item_id} × ${d.quantity}` : ''}{['unknown', 'sending'].includes(d.state) && ' · Requires verification; do not resend.'}</li>)}</ul>
        </>}
    </section>;
}
RaffleManagement.propTypes = { raffleId: PropTypes.string.isRequired, ownerId: PropTypes.string.isRequired, onChange: PropTypes.func.isRequired };
