import { useContext, useId, useState } from 'react';
import PropTypes from 'prop-types';
import { AuctionsContext } from '../context/AuctionsContext';
import { parseMeatAmount } from '../lib/auctionInputs';
import { mrAPaymentValue, mrABuyoutPayment, paymentLabel } from '../lib/mrAPayment';
import { minimumAuctionBid } from '../lib/bidIncrements';
import { bundleConfirmation } from '../lib/bundles';

export default function MixedBidForm({ auction }) {
    const { placeBid } = useContext(AuctionsContext);
    const [meat, setMeat] = useState('');
    const [quantity, setQuantity] = useState('0');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const id = useId();
    const minimum = minimumAuctionBid(auction);
    function enteredPayment() {
        const m = meat.trim() === '' || meat.trim() === '0' ? 0 : parseMeatAmount(meat);
        const q = quantity.trim() === '' ? 0 : /^\d+$/.test(quantity.trim()) ? Number(quantity) : NaN;
        if (m === null) throw new Error('Enter a valid Meat amount.');
        const value = mrAPaymentValue(m, q, auction.mrARate);
        return { meat: m, mrAQuantity: q, value };
    }
    function payment() {
        const { meat: m, mrAQuantity: q, value } = enteredPayment();
        const buyout = auction.instantPurchasePrice && value >= auction.instantPurchasePrice;
        if (buyout) return mrABuyoutPayment(m, q, auction.mrARate, auction.instantPurchasePrice);
        if (minimum === null || value < minimum) throw new Error(`Bid value must meet the next minimum${minimum === null ? '.' : ` of ${minimum.toLocaleString()} Meat.`}`);
        return { meat: m, mrAQuantity: q, value };
    }
    let entered = null;
    try { entered = enteredPayment(); } catch { /* Invalid/overflowing input must not show a guessed value. */ }
    let preview = null;
    try { preview = payment(); } catch { /* Show validation on explicit submission. */ }
    function stepQuantity(direction) {
        const q = quantity.trim() === '' ? 0 : /^\d+$/.test(quantity.trim()) ? Number(quantity) : NaN;
        if (!Number.isSafeInteger(q)) return;
        setQuantity(String(direction > 0 ? Math.min(Number.MAX_SAFE_INTEGER, q + 1) : Math.max(0, q - 1)));
    }
    async function submit(event) {
        event.preventDefault();
        if (pending) return;
        let offer;
        try { offer = payment(); } catch (failure) { setError(failure.message); return; }
        if (!window.confirm(`Commit to paying ${paymentLabel(offer.meat, offer.mrAQuantity, offer.value)}?${offer.value === auction.instantPurchasePrice ? ' This accepts the buyout.' : ''}${bundleConfirmation(auction)}`)) return;
        setPending(true); setError('');
        try {
            await placeBid(auction.id, offer.value, offer);
            setMeat(''); setQuantity('0');
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    return <form onSubmit={submit} className="space-y-2 text-sm" aria-label={`Bid on ${auction.item}`}>
        <p aria-live="polite">Bid value: <strong>{entered ? `${entered.value.toLocaleString('en-US')} Meat` : 'Enter valid amounts within the supported value limit.'}</strong></p>
        <div className="flex flex-wrap gap-3">
            <label htmlFor={`${id}-meat`}>Meat<input id={`${id}-meat`} type="text" inputMode="decimal" value={meat} onChange={event => setMeat(event.target.value)} placeholder={minimum === null ? 'Maximum bid reached' : minimum.toLocaleString('en-US')} disabled={pending} className="block w-40 rounded border border-gray-400 p-2" /></label>
            <div><label htmlFor={`${id}-quantity`}>Mr. A&apos;s</label><div className="relative w-28">
                <input id={`${id}-quantity`} type="text" inputMode="numeric" value={quantity} onChange={event => setQuantity(event.target.value)} disabled={pending}
                    onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); stepQuantity(event.key === 'ArrowUp' ? 1 : -1); } }}
                    className="block w-full rounded border border-gray-400 p-2 !pr-6" />
                <div className="absolute inset-y-1 right-1 flex flex-col justify-center">{[1, -1].map(direction => <button key={direction} type="button" disabled={pending}
                    aria-label={`${direction > 0 ? 'Increase' : 'Decrease'} Mr. A quantity`}
                    onClick={() => stepQuantity(direction)}
                    className="!min-h-0 !rounded-none !border-0 !bg-transparent !p-0 !text-[11px] !leading-3 !shadow-none text-gray-600">{direction > 0 ? '▲' : '▼'}</button>)}</div>
            </div></div>
            <p className="self-center pt-4 text-xs text-gray-500">Fixed rate: 1 Mr. A = {auction.mrARate.toLocaleString('en-US')} Meat.</p>
        </div>
        <p className="text-xs text-gray-600">{minimum === null ? 'The maximum supported bid has been reached.' : `Next minimum bid: ${minimum.toLocaleString('en-US')} Meat.`}</p>
        {preview && <p>Payment: {paymentLabel(preview.meat, preview.mrAQuantity, preview.value)}{preview.refundMeat > 0 ? '. Excess Meat is excluded from this Direct trade.' : ''}</p>}
        <button disabled={pending} className="min-h-10 rounded bg-blue-700 px-4 text-white">{pending ? 'Submitting…' : 'Place Bid'}</button>
        {error && <p role="alert" className="text-red-700">{error}</p>}
    </form>;
}
MixedBidForm.propTypes = { auction: PropTypes.object.isRequired };
