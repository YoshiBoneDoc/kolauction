import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { itemImageUrl } from '../lib/itemCatalog';
import CopyMessage from './CopyMessage';
import { supabase } from '../lib/supabase';

export default function RaffleManagement({ raffleId, ownerId, onChange, prizes = [] }) {
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
            <div className="raffle-management-reserves">
                <div className="flex items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2"><span>Reserved Items</span>
                        {(() => {
                            const missing = prizes.filter(prize => BigInt(data.inventory.find(item => item.item_id === prize.item_id)?.quantity ?? 0) < BigInt(prize.quantity));
                            return missing.length > 0 && <><span className="text-xs text-gray-600">· Missing:</span>{missing.map(prize => prize.image && <img key={prize.item_id} src={itemImageUrl(prize.image)} alt={prize.name} title={prize.name} className="h-8 w-8 rounded bg-white object-contain p-0.5 [image-rendering:pixelated]" />)}</>;
                        })()}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        {data.inventory.some(item => BigInt(item.quantity) > 0n) ? data.inventory.filter(item => BigInt(item.quantity) > 0n).map(item => {
                            const prize = prizes.find(prize => prize.item_id === item.item_id);
                            return <span key={item.item_id} title={`${item.name} × ${BigInt(item.quantity).toLocaleString('en-US')}`} className="inline-flex items-center gap-0.5">{prize?.image ? <img src={itemImageUrl(prize.image)} alt={item.name} className="h-8 w-8 rounded bg-white object-contain p-0.5 [image-rendering:pixelated]" /> : <span>{item.name}</span>}{BigInt(item.quantity) > 1n && <small>×{BigInt(item.quantity).toLocaleString('en-US')}</small>}</span>;
                        }) : <span>None</span>}
                    </div>
                </div>

            </div>
            {['preview', 'active'].includes(data.state) && <button type="button" className="raffle-management-cancel" disabled={busy} onClick={() => act('cancel_mystery_raffle')}>Cancel raffle and refund tickets</button>}
        </>}
    </section>;
}
RaffleManagement.propTypes = { raffleId: PropTypes.string.isRequired, ownerId: PropTypes.string.isRequired, onChange: PropTypes.func.isRequired, prizes: PropTypes.array };
