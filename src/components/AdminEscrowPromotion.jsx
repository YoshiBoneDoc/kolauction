import { escrowPromotion } from '../lib/escrowPromotionService';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export default function AdminEscrowPromotion() {
    const [enabled, setEnabled] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let active = true;
        async function load() {
            try {
                if (!supabase) throw new Error('Promotion controls are unavailable.');
                const { data, error: failure } = await supabase.rpc('admin_escrow_promotion');
                if (failure) throw failure;
                if (active) { setEnabled(data.enabled); setError(''); }
            } catch (failure) {
                if (active) setError(failure.message || 'Unable to load promotion status.');
            }
        }
        load();
        return () => { active = false; };
    }, [attempt]);
    async function toggle() {
        setBusy(true); setError(''); setNotice('');
        try {
            const { data, error: failure } = await supabase.rpc('admin_escrow_promotion', { p_enabled: !enabled });
            if (failure) throw failure;
            escrowPromotion.invalidate();
            setEnabled(data.enabled);
            setNotice(`Promotion ${data.enabled ? 'enabled' : 'disabled'}. Future settlements use the updated fees.`);
        } catch (failure) {
            // A lost response may follow a committed change. Require a fresh read.
            setEnabled(null);
            setError(failure.message || 'Unable to update the promotion. Refresh its status before trying again.');
        } finally { setBusy(false); }
    }
    return <section aria-labelledby="promotion-title" className="space-y-4 rounded-lg border border-gray-200 bg-white p-5">
        <h2 id="promotion-title" className="text-xl font-semibold">Escrow fee promotion</h2>
        <p role="status">{enabled === null ? 'Status unavailable' : `Promotion is ${enabled ? 'enabled' : 'disabled'}.`}</p>
        <p className="text-sm text-gray-600">When enabled, users share a 20m Meat introductory allowance across Buy and Sell transactions. A transaction is entirely free if below that allowance before settlement; afterward, fees are 2% on the first 1b and 1% above. Buy orders already partially fulfilled at activation have free remaining promotional fills.</p>
        <p className="text-sm text-gray-600">Disabling restores original fees for future settlements, including active auctions. Completed fees and accumulated promotional volume remain unchanged. Buy reserves stay held until the normal refund process. There is no automatic expiration.</p>
        <button type="button" disabled={busy || enabled === null} onClick={toggle} className="min-h-11 rounded bg-blue-700 px-4 py-2 font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : enabled ? 'Disable promotion' : 'Enable promotion'}</button>
        {notice && <p role="status" className="text-green-800">{notice}</p>}
        {error && <div className="space-y-2"><p role="alert" className="text-red-700">{error}</p><button type="button" disabled={busy} onClick={() => { setEnabled(null); setAttempt(value => value + 1); }} className="min-h-11 text-blue-700 underline">Refresh status</button></div>}
    </section>;
}
