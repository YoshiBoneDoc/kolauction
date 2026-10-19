import { useContext, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import KmailInstructions from './KmailInstructions';

export default function InstantPurchaseAction({ auction }) {
    const { currentUser } = useContext(UserContext);
    const { purchaseAuction } = useContext(AuctionsContext);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    if (!auction.instantPurchasePrice) return null;
    const price = auction.instantPurchasePrice.toLocaleString('en-US');

    async function purchase() {
        if (pending) return;
        if (!window.confirm(`Accept ${auction.quantity.toLocaleString('en-US')} × ${auction.item} for a total of ${price} Meat? This ends bidding immediately. The in-game exchange must still be completed.`)) return;
        setPending(true);
        setError('');
        setMessage('');
        try {
            await purchaseAuction(auction.id);
            setMessage('Instant purchase accepted. Bidding is closed; the trade is awaiting exchange.');
        } catch (failure) {
            setError(failure.message);
        } finally {
            setPending(false);
        }
    }

    return (
        <section aria-label="Instant purchase" className="mb-4 w-full rounded-lg border border-green-700 bg-green-50 p-3 text-center">
            <p className="text-sm font-semibold text-green-900">Instant Purchase Price</p>
            <p className="break-words text-lg font-bold text-green-900">{price} Meat</p>
            <p className="mb-3 text-xs text-gray-700">For the entire listing. Accepting ends bidding early.</p>
            {currentUser?.id === auction.sellerId ? <p className="text-sm text-gray-700">Your optional instant purchase offer.</p> : auction.escrowMode ? <KmailInstructions auction={auction} mode="buy" /> : currentUser ? (
                <button onClick={purchase} disabled={pending} className="min-h-11 w-full rounded bg-green-700 px-3 py-3 font-semibold text-white hover:bg-green-800 disabled:opacity-50">{pending ? 'Accepting…' : `Purchase for ${price} Meat`}</button>
            ) : <Link to="/login" className="flex min-h-11 items-center justify-center rounded bg-green-700 px-3 py-3 text-white">Log in to purchase</Link>}
            {error && <p role="alert" className="mt-3 break-words text-sm text-red-700">{error}</p>}
            {message && <p role="status" className="mt-3 text-sm text-green-900">{message}</p>}
        </section>
    );
}

InstantPurchaseAction.propTypes = { auction: PropTypes.object.isRequired };
