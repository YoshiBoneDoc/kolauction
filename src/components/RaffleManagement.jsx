import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import CopyMessage from './CopyMessage';
import { supabase } from '../lib/supabase';

export default function RaffleManagement({ raffleId, ownerId, onChange }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [revision, setRevision] = useState(0);
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
            const params = { p_id: raffleId };
            const { error: failure } = await supabase.rpc(action, params);
            if (failure) throw new Error('Action not confirmed. Refresh or retry the same request safely.');
            setRevision(v => v + 1); onChange();
        } catch (failure) { setError(failure.message); }
        finally { acting.current = false; setBusy(false); }
    }
    return <section className="raffle-summary raffle-management mt-4" aria-label="Raffle management">
        <header className="raffle-management-header">
            <h2>Manage Raffle{data?.raffle_number && ` #${data.raffle_number}`}</h2>
            {data && <span className={`raffle-management-status ${data.state === 'active' ? 'is-active' : ''}`}>{data.state.replaceAll('_', ' ')}</span>}
            <button type="button" className="raffle-management-refresh" aria-label="Refresh raffle management" title="Refresh" disabled={busy} onClick={() => { setRevision(v => v + 1); onChange(); }}>
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20 4v6h-6M4 20v-6h6"/><path d="M4.8 9a7.5 7.5 0 0 1 12.4-4.3L20 10M4 14l2.8 5.3A7.5 7.5 0 0 0 19.2 15"/></svg>
            </button>
        </header>
        {error && <p role="alert">{error}</p>}
        {!data && !error && <p role="status">Loading management…</p>}
        {data && <>
            <div className="raffle-management-deposit"><span>Deposit prize items:</span><CopyMessage text={`SUPPLY ${data.raffle_number}`} label="prize deposit command" inline /></div>
            <p className="raffle-management-note">Partial and repeat deposits supported.</p>
            <p className="raffle-management-proceeds">Ticket Sales: <strong>{BigInt(data.revenue).toLocaleString('en-US')} Meat</strong> <small className="raffle-management-ticket-total">({BigInt(data.ticket_count ?? 0).toLocaleString('en-US')} tickets)</small></p>
            <details className="raffle-management-reserves">
                <summary><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 3 5 5-5 5"/></svg><span>Reserved Items</span><span className="raffle-management-inventory">{data.inventory.filter(i => BigInt(i.quantity) > 0n).map(i => `${i.name} × ${BigInt(i.quantity).toLocaleString('en-US')}`).join(' · ') || 'None'}</span></summary>
                <div className="raffle-management-history"><h3>Deposit History</h3>{data.deposits.length ? <ul>{data.deposits.map(d => <li key={d.receipt_id}><time dateTime={d.received_at}>{new Date(d.received_at).toLocaleString()}</time><span>{d.items.map(i => `${data.inventory.find(item => item.item_id === i.id)?.name ?? i.name ?? `Item #${i.id}`} × ${BigInt(i.quantity).toLocaleString('en-US')}`).join(' · ')}</span><span className="raffle-management-deposit-status">Received</span></li>)}</ul> : <p>No deposits yet.</p>}</div>
            </details>
            {['preview', 'active'].includes(data.state) && <button type="button" className="raffle-management-cancel" disabled={busy} onClick={() => act('cancel_mystery_raffle')}>Cancel raffle and refund tickets</button>}
        </>}
    </section>;
}
RaffleManagement.propTypes = { raffleId: PropTypes.string.isRequired, ownerId: PropTypes.string.isRequired, onChange: PropTypes.func.isRequired };
