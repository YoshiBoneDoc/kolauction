import SellPrice from './SellPrice';
import { useContext, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import SettlementTerms from './SettlementTerms';
import { formatCompactMeat } from '../lib/formatMeat';

export default function InstantPurchaseAction({ auction, compact = false, showTerms = true, dense = false }) {
    const { currentUser } = useContext(UserContext);
    const { purchaseAuction } = useContext(AuctionsContext);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    if (!auction.instantPurchasePrice) return null;
    const price = auction.instantPurchasePrice.toLocaleString('en-US');
    const displayedPrice = compact ? formatCompactMeat(auction.instantPurchasePrice) : price;
    const isSeller = currentUser?.id === auction.sellerId;

    async function purchase() {
        if (pending) return;
        if (!window.confirm(`Accept ${auction.quantity.toLocaleString('en-US')} × ${auction.item} for a total of ${price} Meat? This ends bidding immediately. The in-game exchange must still be completed.`)) return;
        setPending(true);
        setError('');
        setMessage('');
        try {
            await purchaseAuction(auction.id);
            setMessage('Buyout accepted. Bidding is closed; the trade is awaiting exchange.');
        } catch (failure) {
            setError(failure.message);
        } finally {
            setPending(false);
        }
    }

    const buttonClass = dense
        ? 'button-green inline-flex h-8 shrink-0 items-center justify-center rounded-[2px] border border-green-800 bg-green-800 px-3 text-xs font-semibold text-green-100 disabled:border-gray-300 disabled:bg-gray-100 disabled:text-gray-500'
        : 'button-green inline-flex min-h-8 shrink-0 items-center justify-center rounded-md border border-green-800 bg-green-800 px-4 py-1 text-sm font-semibold text-green-100 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700 disabled:opacity-50';

    return (
        <section aria-label="Buyout" className={`w-full text-left ${dense ? 'mb-3 border-b border-gray-200 pb-2' : 'mb-4 border-y border-gray-200 py-3'}`}>
            <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${isSeller ? 'justify-center text-center' : 'justify-between'}`}>
                <div className="min-w-0">
                    {compact ? <p title={`${price} Meat`} className="break-words text-sm font-medium text-green-800">Buyout Price: {displayedPrice}</p> : <>
                        <p className="text-xs font-medium text-green-800">Buyout Price</p>
                        <p className={`break-words font-semibold text-green-800 ${dense ? 'text-sm' : 'text-lg'}`}><SellPrice amount={auction.instantPurchasePrice} quantity={auction.quantity} compact={false} /></p>
                    </>}
                </div>
                {currentUser?.isBanned || currentUser?.id === auction.sellerId ? null : auction.escrowMode ? (compact && <Link to={`/auction/${auction.id}`} title="View KMail buyout instructions" className={buttonClass}>Buy Now</Link>) : currentUser ? (
                    <button onClick={purchase} disabled={pending} title={`Buyout price: ${price} Meat`} className={buttonClass}>{pending ? 'Accepting…' : 'Buy Now'}</button>
                ) : compact ? <Link to="/login" className={buttonClass}>Buy Now</Link> : null}
            </div>
            {!compact && <div className="mt-2 space-y-2 text-xs text-gray-600">
                <p>For the entire listing. A bid reaching this amount ends bidding early at this price.</p>
                {showTerms && !auction.escrowMode && <SettlementTerms escrowMode={false} />}
                {auction.escrowMode && <p>Use the same BID command. Any excess Meat is returned.</p>}
                {currentUser?.id === auction.sellerId && <p>Your optional buyout offer.</p>}
            </div>}
            {error && <p role="alert" className="mt-3 break-words text-sm text-red-700">{error}</p>}
            {message && <p role="status" className="mt-3 text-sm text-green-900">{message}</p>}
        </section>
    );
}

InstantPurchaseAction.propTypes = { auction: PropTypes.object.isRequired, compact: PropTypes.bool, showTerms: PropTypes.bool, dense: PropTypes.bool };
