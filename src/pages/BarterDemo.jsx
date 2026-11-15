import { useMemo, useReducer, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import PropTypes from 'prop-types';
import BarterSymbol from '../components/BarterSymbol';
import BarterOfferForm from '../components/BarterOfferForm';
import BarterOfferReview from '../components/BarterOfferReview';
import BarterOfferImages from '../components/BarterOfferImages';
import { offerDescription } from '../lib/barter';
import { barterDemoReducer, createBarterDemo, demoItems, demoListings, demoPrices, latestDemoOffer } from '../lib/barterDemo';

const noop = () => {};
const actionClass = 'min-h-10 rounded border border-gray-300 bg-white px-3 py-2 text-xs font-medium disabled:opacity-50';
const examples = [['changes_requested', 'Host requests changes'], ['accepted', 'Host accepts'], ['rejected', 'Host rejects'], ['superseded', 'Another offer replaces yours'], ['pending', 'Awaiting a response']];

function PracticeAuction({ role }) {
    const [state, dispatch] = useReducer(barterDemoReducer, role, createBarterDemo);
    const offerForm = useRef(null);
    const listing = demoListings[role];
    const leader = state.offers.find(row => row.id === state.currentOfferId);
    const mine = latestDemoOffer(state);
    const pending = mine?.status === 'pending';
    const practice = useMemo(() => ({ revision: state.formVersion, items: demoItems, prices: demoPrices(), onSubmit: offer => dispatch({ type: 'submit', ...offer }) }), [state.formVersion]);
    const active = !state.ended;
    function decide(details) { dispatch({ type: 'decision', ...details }); }
    function revise(offer) {
        dispatch({ type: 'revise', offerId: offer.id });
        requestAnimationFrame(() => { offerForm.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); offerForm.current?.querySelector('input')?.focus({ preventScroll: true }); });
    }
    const visibleOffers = role === 'host' ? state.offers : mine ? [mine] : [];
    const accepted = state.offers.filter(row => row.status === 'accepted').sort((a, b) => b.acceptedOrder - a.acceptedOrder);
    return <main className="site-page-background flex-1 bg-[#F1F3F5] px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-4xl space-y-4">
            <nav className="flex flex-wrap justify-between gap-3 text-sm"><Link to="/barter" className="text-blue-700 underline">Back to Barter Corner</Link><Link to={`/barter/demo/${role === 'host' ? 'bidder' : 'host'}`} className="text-blue-700 underline">Try the {role === 'host' ? 'bidder' : 'host'} demo →</Link></nav>
            <aside aria-label="Practice auction notice" className="rounded-lg border border-amber-300 bg-amber-50 p-4">
                <p className="text-sm font-bold text-amber-800">DEMO / FAKE — no items or Meat exchanged</p>
                <p className="mt-1 text-xs text-gray-600">All actions are practice only. Sample offers and prices are illustrative. Nothing is published, sent, or added to your account.</p>
            </aside>
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-lg sm:p-6">
                <header className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-4">
                    <h1 className="flex items-center gap-2 text-xl font-bold"><BarterSymbol size={30} />Play as the {role}</h1>
                    <div className="flex flex-wrap gap-2"><button type="button" onClick={() => dispatch({ type: 'reset' })} className={actionClass}>Reset demo</button><button type="button" disabled={!active} onClick={() => dispatch({ type: 'end' })} className={actionClass}>Preview auction ending</button></div>
                </header>
                <section aria-label="Practice listing" className="grid gap-5 sm:grid-cols-[150px_minmax(0,1fr)]">
                    <img src={listing.image} alt={listing.item} className="mx-auto h-36 w-36 rounded-lg bg-white p-4 object-contain [image-rendering:pixelated]" />
                    <div className="space-y-2"><h2 className="text-xl font-bold">{listing.item} ×1</h2><p className="text-xs text-gray-500">Direct Trade · No minimum bid · {active ? 'Practice auction open' : 'Practice auction ended'}</p>
                        <p className="text-xs text-gray-500">Current accepted bid · estimated value</p><p className="text-2xl font-extrabold">{leader ? `${leader.value.toLocaleString('en-US')} Meat` : 'No accepted offers'}</p>
                        {leader && <><p className="text-xs">{offerDescription(leader)}</p><BarterOfferImages offer={leader} /></>}
                    </div>
                </section>
                <p className="my-4 rounded border border-blue-200 bg-blue-50 p-3 text-sm" role="status" aria-live="polite">{state.notice || (role === 'host' ? 'You are the host.' : 'You are the bidder. Explore the sample outcomes below, or submit your own practice offer and choose a simulated host response.')}</p>
                {!active && <section aria-label="Practice outcome" className="my-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm">
                    <h2 className="font-bold">{leader ? `${role === 'bidder' && leader.bidderLabel === 'You' ? 'You win' : `${leader.bidderLabel} wins`} this practice auction` : 'No accepted offer — no winner'}</h2>
                    {leader && <p className="mt-1">Winning exchange: {offerDescription(leader)} for {listing.item} ×1.</p>}
                    <p className="mt-2 text-xs">The last accepted offer wins. Unaccepted offers expire. In a real barter, the host and winner arrange the exact exchange in-game; kHub holds no assets. No exchange takes place in this demo.</p>
                </section>}
                {role === 'bidder' && <div className="my-5"><label className="block text-sm font-semibold">Load a bidder example<select value={state.scenario} onChange={event => dispatch({ type: 'scenario', scenario: event.target.value })} className="mt-2 block min-h-10 w-full rounded border border-gray-300 bg-white px-3 text-sm">{examples.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><p className="mt-1 text-xs text-gray-500">Choosing an example starts a fresh practice scenario.</p></div>}
                <section aria-label={role === 'host' ? 'Practice offers to review' : 'Your practice offer and feedback'} className="mt-5 space-y-3 border-t border-gray-200 pt-4">
                    <h2 className="text-lg font-bold">{role === 'host' ? 'Review sample offers' : 'Your offer and host feedback'}</h2>
                    {visibleOffers.map(offer => <div key={offer.id} className="space-y-2">
                        <BarterOfferReview key={`${state.formVersion}:${offer.id}`} offer={offer} host={role === 'host'} active={active} current={offer.id === state.currentOfferId} onUpdated={noop} onDecision={decide} onRevise={active && !pending ? revise : undefined} />
                        {role === 'host' && active && offer.status === 'changes_requested' && !state.offers.some(row => row.bidderLabel === offer.bidderLabel && row.status === 'pending') && <button type="button" className={actionClass} onClick={() => dispatch({ type: 'revised-response', offerId: offer.id })}>Simulate revised offer from {offer.bidderLabel}</button>}
                    </div>)}
                    {role === 'bidder' && active && pending && <div className="space-y-2 rounded border border-dashed border-blue-300 p-3"><h3 className="text-sm font-semibold">Simulate the host&apos;s response</h3><p className="text-xs text-gray-500">Practice controls: in a real barter, only the host makes this decision.</p><div className="flex flex-wrap gap-2">
                        <button type="button" className={actionClass} onClick={() => decide({ offerId: mine.id, decision: 'accepted' })}>Host accepts</button>
                        <button type="button" className={actionClass} onClick={() => decide({ offerId: mine.id, decision: 'rejected' })}>Host rejects</button>
                        <button type="button" className={actionClass} onClick={() => decide({ offerId: mine.id, decision: 'changes_requested', rejectedItems: mine.items.slice(-1).map(row => row.id), raiseRequested: true })}>Host requests changes</button>
                    </div></div>}
                    {role === 'bidder' && active && mine?.status === 'accepted' && mine.id === state.currentOfferId && <button type="button" className={actionClass} onClick={() => dispatch({ type: 'replace' })}>Simulate host accepting another offer</button>}
                    {role === 'bidder' && active && pending && <p className="text-xs text-gray-500">One pending offer per bidder. Withdraw it above before submitting another.</p>}
                </section>
                {role === 'bidder' && active && !pending && <section ref={offerForm} className="mx-auto mt-5 max-w-xl rounded border border-gray-200 p-4"><BarterOfferForm key={state.formVersion} auction={{ id: 'demo-only', minimumValue: null }} initialOffer={state.draftOffer} practice={practice} onSubmitted={noop} /></section>}
            </div>
            <section aria-label="Practice accepted bid history" className="rounded-lg border border-gray-200 bg-white p-4 shadow sm:p-6">
                <h2 className="mb-3 text-lg font-bold">Accepted bid history</h2>
                <ul className="divide-y divide-gray-200">{accepted.map(offer => <li key={offer.id} className="space-y-1 py-3 text-sm"><p className="flex flex-wrap justify-between gap-2"><strong>{offer.bidderLabel} · {offer.value.toLocaleString('en-US')} Meat <span className="text-xs font-normal text-gray-500">estimated</span></strong><span className="text-xs text-gray-500">{offer.id === state.currentOfferId ? state.ended ? 'Winning offer' : 'Current accepted bid' : 'Previously accepted'}</span></p><p className="text-xs">{offerDescription(offer)}</p><BarterOfferImages offer={offer} /></li>)}</ul>
            </section>
        </div>
    </main>;
}
PracticeAuction.propTypes = { role: PropTypes.oneOf(['host', 'bidder']).isRequired };

export default function BarterDemo() {
    const { role } = useParams();
    if (!['host', 'bidder'].includes(role)) return <main className="p-6"><h1 className="text-xl font-bold">Practice auction not found</h1><Link to="/barter" className="text-blue-700 underline">Back to Barter Corner</Link></main>;
    return <PracticeAuction key={role} role={role} />;
}
