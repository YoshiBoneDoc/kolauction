import { useState } from 'react';
import PropTypes from 'prop-types';
import { createAccountRestrictionService } from '../lib/accountRestrictions';
import { supabase } from '../lib/supabase';

const accounts = createAccountRestrictionService(supabase);
export function RestrictionEditor({ account, onUpdated, renderSummary }) {
    const [action, setAction] = useState('');
    const [duration, setDuration] = useState('7');
    const [customExpiry, setCustomExpiry] = useState('');
    const [reason, setReason] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    async function submit(event) {
        event.preventDefault();
        if (pending) return;
        setPending(true); setError(''); setNotice('');
        try {
            if (action === 'lift') await accounts.lift(account.id, reason);
            else {
                const expiry = duration === 'permanent' ? null : duration === 'custom'
                    ? new Date(customExpiry).toISOString() : new Date(Date.now() + Number(duration) * 86400000).toISOString();
                await accounts.save(account.id, reason, expiry);
            }
            setNotice(action === 'lift' ? 'Ban lifted.' : 'Ban saved.');
            setAction(''); setReason('');
            onUpdated();
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    const status = <>
        <span data-appeal-ban-status={renderSummary ? '' : undefined} className={`${renderSummary ? 'truncate ' : 'mt-1 '}block text-sm ${account.is_banned ? 'font-medium text-red-700' : 'text-gray-500'}`}>{account.is_banned ? account.expires_at ? `Banned until ${new Date(account.expires_at).toLocaleString()}` : 'Permanently banned' : 'Not banned'}</span>
        {account.is_banned && account.reason && <span className={`mt-1 block text-xs text-gray-600 ${renderSummary ? 'truncate' : 'break-words'}`}>{account.reason}</span>}
    </>;
    return <article className={renderSummary ? 'appeal-ban-card space-y-3 rounded bg-gray-50 px-3 py-2' : 'space-y-3 rounded-md border border-gray-200 bg-white p-4'}>
        <div className={renderSummary ? 'flex flex-wrap items-start gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_184px]' : 'flex flex-wrap items-start justify-between gap-3'}>
            {renderSummary ? renderSummary(status) : <div>
                <h3 className="font-semibold text-gray-900">{account.username} {account.player_id && <span className="text-sm font-normal text-gray-500">(#{account.player_id})</span>}</h3>
                {status}
            </div>}
            {!action && <div className="ml-auto flex shrink-0 gap-3 text-xs">
                <button onClick={() => { setAction('ban'); setNotice(''); }} className="button-red rounded border px-3 py-2 font-medium">{account.is_banned ? 'Change ban' : 'Ban account'}</button>
                {account.is_banned && <button onClick={() => { setAction('lift'); setNotice(''); }} className="button-green rounded border border-green-200 bg-green-50 px-3 py-2 font-medium text-green-800">Lift ban</button>}
            </div>}
        </div>
        {action && <form onSubmit={submit} className="space-y-3 border-t border-gray-100 pt-3">
            <p className="text-sm font-semibold">{action === 'lift' ? 'Lift the ban on' : 'Ban'} {account.username}?</p>
            {action === 'ban' && <label className="block text-sm">Duration
                <select value={duration} disabled={pending} onChange={event => setDuration(event.target.value)} className="ml-3 rounded border border-gray-300 bg-white p-2">
                    <option value="1">24 hours</option><option value="7">7 days</option><option value="30">30 days</option><option value="custom">Custom expiry</option><option value="permanent">Permanent</option>
                </select>
            </label>}
            {action === 'ban' && <p className="text-xs text-gray-600">Bid-free listings close. Direct auctions with bids pause for administrator review; existing direct trades are flagged for review. Already-funded escrow obligations continue through the bot. Lifting the ban does not automatically resume held auctions.</p>}
            {action === 'ban' && duration === 'custom' && <label className="block text-sm">Ban ends (your local time)
                <input type="datetime-local" required disabled={pending} value={customExpiry} onChange={event => setCustomExpiry(event.target.value)} className="mt-1 block max-w-full rounded border border-gray-300 p-2" />
            </label>}
            <label className="block text-sm">Administrator reason
                <textarea required minLength={3} maxLength={1000} rows={2} disabled={pending} value={reason} onChange={event => setReason(event.target.value)} className="mt-1 block w-full rounded border border-gray-300 p-2" />
            </label>
            <div className="flex gap-4">
                <button disabled={pending} className={`rounded px-3 py-2 text-sm font-medium text-white disabled:opacity-50 ${action === 'lift' ? 'button-green bg-green-700' : 'button-red'}`}>{pending ? 'Saving…' : action === 'lift' ? 'Confirm lift ban' : 'Confirm ban'}</button>
                <button type="button" disabled={pending} onClick={() => { setAction(''); setError(''); }} className="border-0 bg-transparent p-0 text-sm text-gray-600 underline">Cancel</button>
            </div>
        </form>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
    </article>;
}
RestrictionEditor.propTypes = { account: PropTypes.object.isRequired, onUpdated: PropTypes.func.isRequired, renderSummary: PropTypes.func };

export default function AdminAccountControls() {
    const [query, setQuery] = useState('');
    const [result, setResult] = useState(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function search(event, term = query) {
        event?.preventDefault();
        if (pending) return;
        setPending(true); setError('');
        try { setResult({ term, accounts: await accounts.search(term) }); }
        catch (failure) { setError(failure.message); setResult(null); }
        finally { setPending(false); }
    }
    return <details className="rounded-lg border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold text-gray-800">Account bans</summary>
        <div className="mt-4 space-y-3">
            <form onSubmit={search} className="flex flex-wrap items-end gap-3">
                <label className="min-w-0 flex-1 text-sm font-medium" htmlFor="ban-account-search">Find an account
                    <input id="ban-account-search" value={query} minLength={2} maxLength={100} required onChange={event => setQuery(event.target.value)} placeholder="Username or KoL player number" className="mt-1 block w-full rounded border border-gray-300 p-2 font-normal" />
                </label>
                <button disabled={pending} className="rounded border border-gray-300 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50">{pending ? 'Searching…' : 'Search'}</button>
            </form>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            {result && !result.accounts.length && <p className="text-sm text-gray-500">No matching accounts.</p>}
            {result?.accounts.map(account => <RestrictionEditor key={account.id} account={account} onUpdated={() => search(null, result.term)} />)}
            {result?.accounts.length === 20 && <p className="text-xs text-gray-500">Showing the first 20 matches. Refine your search for more specific results.</p>}
        </div>
    </details>;
}
