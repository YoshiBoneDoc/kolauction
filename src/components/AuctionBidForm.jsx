import { useContext, useId, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import { parseAuctionAmount } from '../lib/auctionInputs';
import KmailInstructions from './KmailInstructions';

export default function AuctionBidForm({ auction }) {
    const { currentUser } = useContext(UserContext);
    const { placeBid, purchaseAuction } = useContext(AuctionsContext);
    const [amount, setAmount] = useState('');
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState('');
    const inputId = useId();
    const minimum = Math.max(auction.minBidMeat, (auction.currentBid || 0) + 1);

    async function submit(event) {
        event.preventDefault();
        if (pending) return;
        setMessage('');
        const bid = parseAuctionAmount(amount, 20000000000);
        if (bid === null || bid < minimum) {
            setError(`Enter a whole-number bid of at least ${minimum.toLocaleString('en-US')} Meat, up to 20 billion.`);
            return;
        }
        const instant = auction.instantPurchasePrice && bid >= auction.instantPurchasePrice;
        const prompt = instant
            ? `Accept the instant purchase price of ${auction.instantPurchasePrice.toLocaleString('en-US')} Meat for the entire listing (${auction.quantity.toLocaleString('en-US')} × ${auction.item})? Bidding ends immediately at that price. The in-game exchange must still be completed.`
            : `Submit a bid of ${bid.toLocaleString('en-US')} Meat for ${auction.item}?`;
        if (!window.confirm(prompt)) return;
        setPending(true);
        setError('');
        try {
            if (instant) await purchaseAuction(auction.id);
            else await placeBid(auction.id, bid);
            setAmount('');
            setMessage(instant ? 'Instant purchase accepted. Bidding is closed; the trade is awaiting exchange.' : 'Your bid was saved.');
        } catch (failure) {
            setError(failure.message);
        } finally {
            setPending(false);
        }
    }

    if (!currentUser) return <Link to="/login" className="flex min-h-11 items-center justify-center rounded bg-blue-600 px-4 py-3 text-white">Log in to bid</Link>;
    if (currentUser.id === auction.sellerId) return <p className="text-sm text-gray-600">This is your listing.</p>;
    if (auction.escrowMode) return <KmailInstructions auction={auction} />;
    if (currentUser.id === auction.highestBidderId) return <p className="text-sm font-semibold text-blue-700">You are the highest bidder.</p>;

    return (
        <form onSubmit={submit} className="w-full space-y-2 text-left" aria-label={`Bid on ${auction.item}`}>
            <label htmlFor={inputId} className="block text-sm font-semibold">Your bid (Meat)</label>
            <input id={inputId} type="text" inputMode="numeric" autoComplete="off"
                value={amount} onChange={(event) => { setAmount(event.target.value); setError(''); setMessage(''); }}
                placeholder={minimum.toLocaleString('en-US')} disabled={pending}
                aria-invalid={Boolean(error)} aria-describedby={`${inputId}-help${error ? ` ${inputId}-error` : ''}`}
                className="min-h-11 w-full min-w-0 rounded border border-gray-400 bg-white p-3 text-base text-gray-900" />
            <p id={`${inputId}-help`} className="text-xs text-gray-600">Minimum: {minimum.toLocaleString('en-US')} Meat. Full amounts or k/m/b shorthand.</p>
            {auction.instantPurchasePrice && <p className="text-xs text-gray-700">A bid of {auction.instantPurchasePrice.toLocaleString('en-US')} Meat or more accepts the instant purchase price and ends bidding at that price.</p>}
            <button type="submit" disabled={pending} className="min-h-11 w-full rounded bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {pending ? 'Submitting…' : 'Place Bid'}
            </button>
            {error && <p id={`${inputId}-error`} role="alert" className="break-words text-sm text-red-700">{error}</p>}
            {message && <p role="status" className="text-sm text-green-700">{message}</p>}
        </form>
    );
}

AuctionBidForm.propTypes = { auction: PropTypes.object.isRequired };
