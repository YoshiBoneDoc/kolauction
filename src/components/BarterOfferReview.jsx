import useAdministrator from '../hooks/useAdministrator';
import BarterOfferImages from './BarterOfferImages';
import { useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { offerDescription, writeBarter } from '../lib/barter';

export default function BarterOfferReview({ offer, host, active, current, onUpdated, onRevise }) {
    const administrator = useAdministrator();
    const [editing, setEditing] = useState(false);
    const [rejected, setRejected] = useState([]);
    const [raiseOffer, setRaiseOffer] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const lock = useRef(false);
    async function act(decision) {
        if (lock.current) return;
        if (decision === 'accepted' && !globalThis.confirm('Accept this exact offer as the new highest bid? It replaces the current accepted bid even if its estimated value is lower.')) return;
        lock.current = true; setPending(true); setError('');
        try {
            await writeBarter(host ? 'review_barter_offer_changes' : 'withdraw_barter_offer', host ? { p_offer: offer.id, p_decision: decision, p_raise: decision === 'changes_requested' && raiseOffer, p_rejected: decision === 'changes_requested' ? rejected : [] } : { p_offer: offer.id });
            setEditing(false); onUpdated();
        } catch (failure) { setError(failure.message); onUpdated(); }
        finally { lock.current = false; setPending(false); }
    }
    if (!host && offer.status === 'accepted' && !current) return <p role="status" className="text-sm">The host has accepted another offer.</p>;
    if (!host && ['accepted', 'rejected'].includes(offer.status)) return <p role="status" className="text-sm">Your previous bid was <span className={offer.status === 'accepted' ? 'text-green-600' : 'text-red-600'}>{offer.status}</span> by the host.</p>;
    return <article className={`relative rounded border border-gray-200 px-3 pt-3 text-sm ${offer.status === 'changes_requested' ? 'pb-1' : 'pb-3'}`}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1"><div className="flex flex-wrap items-baseline gap-x-2"><strong className="text-base">{offer.value.toLocaleString('en-US')} Meat</strong><span aria-hidden="true" className="text-xs text-gray-500">·</span><span className="text-[11px] text-gray-500">estimated value</span></div><div className="col-start-2 row-start-1 row-span-4 flex flex-col items-end gap-2"><span className="text-xs text-gray-500">{current ? 'Current accepted bid' : offer.status === 'changes_requested' ? 'Changes requested' : offer.status.replaceAll('_', ' ')}</span>{!host && offer.status === 'changes_requested' && onRevise && <button type="button" onClick={() => onRevise(offer)} disabled={pending} className="barter-revise-action inline-flex items-center gap-1 bg-transparent text-xs font-semibold"><svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" /></svg>Revise Offer</button>}</div>
        {host && <p className="col-start-1 text-xs text-gray-500">{administrator && offer.bidder ? `Bidder: ${offer.bidder} (#${offer.bidderKolId})` : offer.bidderLabel || 'Bidder'}</p>}
        <p className="col-start-1 text-xs">{offerDescription(offer)}</p>
        <div className="col-start-1"><BarterOfferImages offer={offer} feedback={offer.status === 'changes_requested'} /></div>
        </div>
        {offer.status === 'changes_requested' && offer.raiseRequested && <p className="mt-2 text-xs text-gray-500"><span className="text-green-600">↑</span> The host would like you to raise the offer.</p>}
        {offer.status === 'changes_requested' && <div className="mt-8 pl-1 pr-24"><p className="barter-revision-instruction text-xs">Host requested changes. Submit a revised offer.</p><p className="text-[11px] text-gray-500">You can copy this offer by clicking the Revise Offer button on the right.</p></div>}
        {!host && active && offer.status === 'changes_requested' && <button type="button" disabled={pending} onClick={() => act('withdrawn')} className="barter-decline-action absolute bottom-3 right-4 inline-flex items-center gap-1 bg-transparent text-xs"><span aria-hidden="true">✕</span>Decline</button>}
        {active && offer.status === 'pending' && <fieldset disabled={pending} className="mt-3 flex flex-wrap gap-2">
            {host ? <><button onClick={() => act('accepted')} className="barter-review-accept rounded bg-green-700 px-3 py-2 text-xs text-white">Accept</button><button onClick={() => act('rejected')} className="barter-review-reject rounded border border-red-300 px-3 py-2 text-xs text-red-700">Reject</button><button onClick={() => setEditing(value => !value)} className="barter-review-changes rounded border border-gray-300 px-3 py-2 text-xs">Request Changes</button></> : <button onClick={() => act('withdrawn')} className="barter-withdraw-action rounded border border-gray-300 px-3 py-2 text-xs">Withdraw pending offer</button>}
            {host && <p className="w-full text-[11px] text-gray-500">Accepting will make this offer the current highest bid</p>}
            {editing && <div className="w-full space-y-2 rounded border border-gray-200 p-3"><p className="text-xs">Mark unwanted items with an X. All other items receive a checkmark.</p>{offer.items.map(item => <button type="button" key={item.id} aria-pressed={rejected.includes(item.id)} aria-label={`Do not accept ${item.name}`} onClick={() => setRejected(rows => rows.includes(item.id) ? rows.filter(id => id !== item.id) : [...rows, item.id])} className="flex w-full items-center gap-2 bg-transparent text-left text-xs"><span className={rejected.includes(item.id) ? 'text-red-700' : 'text-green-700'}>{rejected.includes(item.id) ? '✕' : '✓'}</span>{item.name}</button>)}<button type="button" aria-pressed={raiseOffer} onClick={() => setRaiseOffer(value => !value)} className={`barter-raise-option flex w-full items-center gap-2 bg-transparent text-left text-xs ${raiseOffer ? 'is-selected' : ''}`}><span aria-hidden="true" className="text-base font-bold text-green-600">↑</span><span>I&apos;de like them to raise the offer.</span></button><button type="button" disabled={!rejected.length && !raiseOffer} onClick={() => act('changes_requested')} className="rounded bg-blue-600 px-3 py-2 text-xs text-white disabled:opacity-50">Send requested changes</button></div>}
        </fieldset>}

        {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    </article>;
}
BarterOfferReview.propTypes = { offer: PropTypes.object.isRequired, host: PropTypes.bool, active: PropTypes.bool, current: PropTypes.bool, onUpdated: PropTypes.func.isRequired, onRevise: PropTypes.func };
