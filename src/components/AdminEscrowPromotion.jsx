import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { escrowPromotion } from '../lib/escrowPromotionService';

const tiers = ['Base', 'Silver', 'Gold', 'Platinum', 'Diamond'];
const initial = () => ({ name: '', description: '', mode: 'lower', tiers: [0, 1, 2, 3, 4], allowance: '0', donor_waiver: true,
    sell: [{ from: 0, bps: 200 }], buy: [{ from: 0, bps: 200 }], info_message: '', form_message: '' });
// Reject sub-basis-point input rather than silently rounding to a waiver.
const percentBps = value => /^\d+(?:\.\d{0,2})?$/.test(String(value))
    ? Number(String(value).split('.')[0]) * 100 + Number((String(value).split('.')[1] || '').padEnd(2, '0')) : 'invalid';
const inputClass = 'w-full rounded border border-gray-300 bg-white p-2 text-sm text-gray-900';
const buttonClass = 'min-h-10 rounded border border-gray-300 px-3 py-2 text-sm disabled:opacity-50';
const date = value => value ? new Date(value).toLocaleString() : 'Until manually ended';
const localDate = value => value ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';

export default function AdminEscrowPromotion() {
    const [data, setData] = useState(null);
    const [config, setConfig] = useState(initial);
    const [draft, setDraft] = useState(null);
    const [start, setStart] = useState('');
    const [end, setEnd] = useState('');
    const [preview, setPreview] = useState(null);
    const [confirmation, setConfirmation] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    async function rpc(args = {}) {
        if (!supabase) throw new Error('Promotion controls are unavailable.');
        const { data: result, error: failure } = await supabase.rpc('admin_escrow_promotions', args);
        if (failure) throw failure;
        return result;
    }
    async function refresh() { const result = await rpc(); setData(result); }
    useEffect(() => {
        let active = true;
        rpc().then(result => { if (active) setData(result); }).catch(failure => { if (active) setError(failure.message); });
        return () => { active = false; };
    }, []);
    function change(key, value) { setConfig(previous => ({ ...previous, [key]: value })); setPreview(null); setConfirmation(null); }
    function edit(p = null) {
        setDraft(p); setConfig(p?.config || initial()); setStart(localDate(p?.starts_at)); setEnd(localDate(p?.ends_at)); setPreview(null); setConfirmation(null); setError('');
    }
    async function run(action) {
        setBusy(true); setError(''); setNotice('');
        try { await action(); }
        catch (failure) {
            setPreview(null); setConfirmation(null);
            setError(`${failure.message || 'Unable to update promotion.'} Refresh status before retrying an uncertain change.`);
            try { await refresh(); } catch { /* Keep the original error visible. */ }
        } finally { setBusy(false); }
    }
    async function save(showPreview) {
        await run(async () => {
            const saved = await rpc({ p_action: 'save', p_id: draft?.id ?? null, p_revision: draft?.revision ?? null,
                p_config: { ...config, ...Object.fromEntries(['sell', 'buy'].map(kind => [kind, config[kind].map(b => ({ from: b.from, bps: percentBps(b.percent ?? b.bps / 100) }))])) }, p_start: start ? new Date(start).toISOString() : null, p_end: end ? new Date(end).toISOString() : null, p_request: crypto.randomUUID() });
            setDraft(saved); setPreview(null); await refresh();
            if (showPreview) setPreview(await rpc({ p_action: 'preview', p_id: saved.id }));
            else setNotice('Draft saved. Live fees and promotional balances are unchanged.');
        });
    }
    async function publish() {
        await run(async () => {
            await rpc({ p_action: 'publish', p_id: preview.id, p_revision: preview.revision, p_confirmation: preview.confirmation, p_request: crypto.randomUUID() });
            setPreview(null); setConfirmation(null); edit(); escrowPromotion.invalidate(); await refresh(); setNotice('Promotion published.');
        });
    }
    async function finish(p, action) {
        await run(async () => {
            await rpc({ p_action: action, p_id: p.id, p_revision: p.revision, p_confirmation: 'CONFIRM', p_request: crypto.randomUUID() });
            setConfirmation(null); escrowPromotion.invalidate(); await refresh(); setNotice(action === 'end' ? 'Promotion ended for new trades. Retained terms remain honored; November keeps its legacy settlement rules.' : 'Promotion cancelled. Retained trade terms remain honored.');
        });
    }
    const rows = data?.promotions || [];
    const live = rows.find(p => p.id === data?.live_id);
    const scheduled = rows.filter(p => p.state === 'published' && Date.parse(p.starts_at) > Date.now());
    const drafts = rows.filter(p => p.state === 'draft');
    const history = rows.filter(p => ['ended', 'cancelled'].includes(p.state) || (p.ends_at && Date.parse(p.ends_at) <= Date.now()));
    const rates = p => <div className="space-y-1 text-sm"><p>Eligible tiers: {p.config.tiers.map(t => tiers[t]).join(', ')}. {p.config.mode === 'lower' ? 'Uses the lower eligible fee.' : 'Replaces normal fees.'} {p.config.donor_waiver ? 'Top-donor waiver preserved.' : 'Replacement can override donor waiver.'}</p>{['sell', 'buy'].map(kind => <p key={kind}><strong>{kind === 'sell' ? 'Sell' : 'Buy'}:</strong> {p.config[kind].map(b => `${Number(b.from).toLocaleString()}+ Meat: ${b.bps / 100}%`).join(' · ')}{p.legacy ? ' (progressive portions)' : ' (whole transaction)'}</p>)}<p>Introductory allowance: {Number(p.config.allowance).toLocaleString()} Meat, shared across Buy/Sell. The whole transaction is free when prior promotional volume is below this amount.</p></div>;
    return <div className="space-y-5">
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {notice && <p role="status" className="text-sm text-green-800">{notice}</p>}
        <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-5" aria-labelledby="live-promotion-title">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="live-promotion-title" className="text-xl font-semibold">Current Live Promotion</h2><button className={buttonClass} disabled={busy} onClick={() => run(refresh)}>Refresh status</button></div>
            {!data ? <p>Status unavailable.</p> : !live ? <p>No active promotion.</p> : <>
                <h3 className="font-semibold">{live.config.name} · Active</h3><p className="text-sm">{live.config.description}</p>
                <p className="text-sm">Started {date(live.starts_at)} · {date(live.ends_at)}</p>{rates(live)}
                {live.legacy && <p className="text-sm text-gray-600">November retains its original settlement-time allowance and end rules, progressive rates, and grandfathered free Buy fills. Cheaper locked normal benefits apply after owner activation.</p>}
                <div className="whitespace-pre-line text-sm text-green-800">{live.messages.info}</div><div className="whitespace-pre-line text-xs text-blue-700">{live.messages.form}</div>
                <button className={`${buttonClass} text-red-700`} disabled={busy} onClick={() => setConfirmation({ promotion: live, action: 'end' })}>End promotion…</button>
            </>}
        </section>
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-5" aria-labelledby="configure-promotion-title">
            <div className="flex items-center justify-between gap-2"><h2 id="configure-promotion-title" className="text-xl font-semibold">Create / Configure Promotion</h2><button className={buttonClass} disabled={busy} onClick={() => edit()}>New draft</button></div>
            <p className="text-xs text-gray-600">Drafts and previews do not change live fees or allowances. Times use your local timezone. Future promotion terms stay with trades created during the promotion, including all Buy fulfillments. Allowance eligibility is checked separately at each settlement.</p>
            <fieldset disabled={busy} className="space-y-3">
                <label className="block text-sm">Name<input className={inputClass} maxLength={100} value={config.name} onChange={e => change('name', e.target.value)} /></label>
                <label className="block text-sm">Description<textarea className={inputClass} maxLength={1000} value={config.description} onChange={e => change('description', e.target.value)} /></label>
                <div className="grid gap-4 sm:grid-cols-2">{['sell', 'buy'].map(kind => <fieldset key={kind} className="space-y-2 rounded border p-3"><legend className="text-sm font-semibold">{kind === 'sell' ? 'Sell commission' : 'Buy fee'} brackets</legend>{config[kind].map((band, i) => <div key={i} className="flex items-end gap-2"><label className="min-w-0 flex-1 text-xs">From Meat<input className={inputClass} type="number" min="0" step="1" disabled={i === 0} value={band.from} onChange={e => change(kind, config[kind].map((b, n) => n === i ? { ...b, from: e.target.value } : b))} /></label><label className="min-w-0 flex-1 text-xs">Fee %<input className={inputClass} type="number" min="0" max="100" step="0.01" value={band.percent ?? band.bps / 100} onChange={e => change(kind, config[kind].map((b, n) => n === i ? { ...b, percent: e.target.value, bps: percentBps(e.target.value) } : b))} /></label>{i > 0 && <button className={buttonClass} onClick={() => change(kind, config[kind].filter((_, n) => n !== i))} aria-label={`Remove ${kind} bracket ${i + 1}`}>×</button>}</div>)}<button className={buttonClass} disabled={config[kind].length >= 12} onClick={() => change(kind, [...config[kind], { from: Number(config[kind].at(-1).from) + 10000000, bps: config[kind].at(-1).bps }])}>Add bracket</button></fieldset>)}</div>
                <fieldset><legend className="text-sm">Eligible loyalty tiers</legend><div className="flex flex-wrap gap-3">{tiers.map((name, i) => <label className="text-sm" key={name}><input type="checkbox" checked={config.tiers.includes(i)} onChange={e => change('tiers', e.target.checked ? [...config.tiers, i].sort() : config.tiers.filter(t => t !== i))} /> {name}</label>)}</div></fieldset>
                <label className="block text-sm">Interaction with normal fees<select className={inputClass} value={config.mode} onChange={e => { change('mode', e.target.value); if (e.target.value === 'lower') change('donor_waiver', true); }}><option value="lower">Apply only when lower (preserve all cheaper benefits)</option><option value="replace">Replace normal fees for eligible tiers</option></select></label>
                <label className="block text-sm"><input type="checkbox" checked={config.donor_waiver} disabled={config.mode === 'lower'} onChange={e => change('donor_waiver', e.target.checked)} /> Preserve the locked top-donor 0% waiver</label>
                <label className="block text-sm">Shared introductory allowance (Meat; 0 for none)<input className={inputClass} type="number" min="0" step="1" value={config.allowance} onChange={e => change('allowance', e.target.value)} /></label>
                <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Start (blank = immediately when published)<input className={inputClass} type="datetime-local" value={start} onChange={e => { setStart(e.target.value); setPreview(null); }} /></label><label className="text-sm">Expiration (blank = until manually ended)<input className={inputClass} type="datetime-local" value={end} onChange={e => { setEnd(e.target.value); setPreview(null); }} /></label></div>
                <label className="block text-sm">Green Info page announcement (optional)<textarea className={inputClass} maxLength={2000} value={config.info_message} onChange={e => change('info_message', e.target.value)} /></label>
                <label className="block text-sm">Blue auction form explanation (optional)<textarea className={inputClass} maxLength={2000} value={config.form_message} onChange={e => change('form_message', e.target.value)} /></label>
                <div className="flex gap-2"><button className={buttonClass} onClick={() => save(false)}>Save draft</button><button className={`${buttonClass} bg-blue-700 text-white`} onClick={() => save(true)}>Save and preview</button></div>
            </fieldset>
            {preview && <section className="space-y-3 border-t pt-4" aria-label="Promotion preview">
                <h3 className="font-semibold">Preview: {preview.config.name}</h3>{rates({ config: preview.config })}<p className="text-sm">Start: {preview.starts_at ? date(preview.starts_at) : 'Immediately on confirmation'} · Expiration: {date(preview.ends_at)}</p>
                <p className="whitespace-pre-line text-sm text-green-800">{preview.messages.info}</p><p className="whitespace-pre-line text-xs text-blue-700">{preview.messages.form}</p>
                {preview.conflicts.length > 0 && <p role="alert" className="text-sm text-red-700">Conflicts with: {preview.conflicts.map(p => p.name).join(', ')}. End or reschedule conflicting promotions before publishing.</p>}
                <details><summary className="cursor-pointer text-sm">Example fee calculations</summary><div className="max-h-72 overflow-auto"><table className="w-full text-left text-xs"><thead><tr>{['Amount', 'Tier', 'Privilege', 'Side', 'Prior promo volume', 'Normal fee', 'Promo fee'].map(h => <th className="p-1" key={h}>{h}</th>)}</tr></thead><tbody>{preview.examples.map((r, i) => <tr key={i}>{[r.amount, r.tier, r.privilege, r.kind, r.prior_volume, r.normal_fee, r.fee].map((v, j) => <td className="p-1" key={j}>{v}</td>)}</tr>)}</tbody></table></div></details>
                {!data?.engine_enabled && <p className="text-sm text-gray-600">Publication is disabled until the owner explicitly activates the fee engine.</p>}
                <button className={`${buttonClass} bg-blue-700 text-white`} disabled={busy || preview.conflicts.length > 0 || !data?.engine_enabled} onClick={() => setConfirmation({ action: 'publish' })}>Publish / schedule…</button>
            </section>}
            {drafts.length > 0 && <details><summary className="cursor-pointer text-sm">Saved drafts ({drafts.length})</summary><ul className="space-y-2 pt-2">{drafts.map(p => <li key={p.id} className="flex justify-between gap-2 text-sm"><span>{p.config.name}</span><span className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => edit(p)}>Edit</button><button className={buttonClass} disabled={busy} onClick={() => setConfirmation({ promotion: p, action: 'cancel' })}>Discard…</button></span></li>)}</ul></details>}
        </section>
        {scheduled.length > 0 && <section className="space-y-2 rounded-lg border bg-white p-5"><h2 className="font-semibold">Scheduled promotions</h2>{scheduled.map(p => <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{p.config.name} · {date(p.starts_at)} → {date(p.ends_at)}</span><button className={buttonClass} disabled={busy} onClick={() => setConfirmation({ promotion: p, action: 'cancel' })}>Cancel…</button></div>)}</section>}
        <details className="rounded-lg border bg-white p-5"><summary className="cursor-pointer font-semibold">Promotion History</summary><ul className="mt-2 space-y-1 text-sm">{history.length ? history.map(p => <li key={p.id}>{p.config.name} · {date(p.starts_at)} → {date(p.ended_at || p.ends_at)} · {p.state === 'published' ? 'expired' : p.state}</li>) : <li>No previous promotions.</li>}</ul></details>
        {confirmation && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={event => { event.preventDefault(); if (!busy) setConfirmation(null); }} aria-labelledby="promotion-confirm-title" className="rounded-lg p-0 backdrop:bg-black/40"><div className="max-w-lg space-y-4 rounded-lg bg-white p-5"><h3 id="promotion-confirm-title" className="font-semibold">{confirmation.action === 'publish' ? 'Confirm promotion publication' : `Confirm ${confirmation.action === 'end' ? 'ending' : 'cancelling'} ${confirmation.promotion.config.name}`}</h3><p className="text-sm">{confirmation.action === 'publish' ? 'Publish exactly the configuration and dates shown in the preview?' : confirmation.promotion.legacy ? 'November will stop applying at future settlements, preserving its legacy behavior. Completed fees and accumulated volume remain unchanged.' : 'New trades will no longer receive this promotion. Trades already created under it retain its terms.'}</p><div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => setConfirmation(null)}>Go back</button><button className={`${buttonClass} bg-blue-700 text-white`} disabled={busy} onClick={() => confirmation.action === 'publish' ? publish() : finish(confirmation.promotion, confirmation.action)}>Confirm</button></div></div></dialog>}
    </div>;
}
