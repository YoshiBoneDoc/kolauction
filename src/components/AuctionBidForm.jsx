import { bundleConfirmation } from '../lib/bundles';
import { useContext, useId, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import { parseMeatAmount, normalizeAuctionAmount } from '../lib/auctionInputs';
import KmailInstructions from './KmailInstructions';
import SettlementTerms from './SettlementTerms';
import CopyMessage from './CopyMessage';
import { minimumAuctionBid } from '../lib/bidIncrements';

export default function AuctionBidForm({ auction, showTerms = true, showHeading = true, compact = false, inline = false, onClose }) {
    const { currentUser } = useContext(UserContext);
    const { placeBid, purchaseAuction } = useContext(AuctionsContext);
    const [amount, setAmount] = useState('');
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState('');
    const inputId = useId();
    const minimum = minimumAuctionBid(auction);
    const minimumText = minimum === null ? 'Maximum bid reached' : minimum.toLocaleString('en-US');

    async function submit(event, buyout = false) {
        event.preventDefault();
        if (pending) return;
        setMessage('');
        const bid = buyout ? auction.instantPurchasePrice : parseMeatAmount(amount);
        const instant = auction.instantPurchasePrice && bid !== null && bid >= auction.instantPurchasePrice;
        if (bid === null || (!instant && (minimum === null || bid < minimum))) {
            setError(minimum === null ? 'The maximum supported bid has been reached.' : `Enter a bid of at least ${minimumText} Meat.`);
            return;
        }
        const prompt = instant
            ? `Accept the buyout price of ${auction.instantPurchasePrice.toLocaleString('en-US')} Meat for the entire listing (${auction.quantity.toLocaleString('en-US')} × ${auction.item})? Bidding ends immediately at that price. The in-game exchange must still be completed.`
            : `Submit a bid of ${bid.toLocaleString('en-US')} Meat for ${auction.item}?`;
        if (!window.confirm(prompt + bundleConfirmation(auction))) return;
        setPending(true);
        setError('');
        try {
            if (instant) await purchaseAuction(auction.id);
            else await placeBid(auction.id, bid);
            setAmount('');
            setMessage(instant ? 'Buyout accepted. Bidding is closed; the trade is awaiting exchange.' : 'Your bid was saved.');
        } catch (failure) {
            setError(failure.message);
        } finally {
            setPending(false);
        }
    }

    if (!currentUser) return <Link to="/login" className="flex min-h-11 items-center justify-center rounded bg-blue-600 px-4 py-3 text-white">Log in to bid</Link>;
    if (currentUser.isBanned) return <p className="text-sm text-gray-600">Bidding is unavailable for this account.</p>;
    if (currentUser.id === auction.sellerId) return <p className="text-sm text-gray-600">This is your listing.</p>;
    if (inline && currentUser.id === auction.highestBidderId) return <div className="grid h-full min-w-0 grid-cols-[minmax(0,1fr)_80px] grid-rows-[20px_24px] items-end">
        <input type="text" disabled value="You are the highest bidder" title="You are the highest bidder" aria-label="Your bid status"
            className="col-start-1 row-start-2 h-6 w-full min-w-0 rounded-none rounded-l-[2px] border border-r-0 border-gray-300 bg-gray-100 px-2 text-[11px] text-gray-500" />
        <button type="button" onClick={onClose} aria-label="Close Bid Form"
            className="col-start-2 row-start-2 inline-flex h-6 w-20 items-center justify-center rounded-none rounded-r-[2px] border border-gray-300 bg-white p-0 text-xs font-semibold text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-500">Close</button>
    </div>;
    if (inline && auction.escrowMode) return <div className="grid h-full min-w-0 grid-cols-[minmax(0,1fr)_80px] grid-rows-[20px_24px] items-end">
        <label htmlFor={inputId} title={`${minimum === null ? 'The maximum supported bid has been reached.' : `Attach at least ${minimumText} Meat, with no items.`}${auction.instantPurchasePrice ? ` Attach ${auction.instantPurchasePrice.toLocaleString('en-US')} Meat to accept the buyout.` : ''} Bids must be processed before the auction deadline.`}
            className="col-span-2 row-start-1 self-end text-xs font-medium leading-4 text-gray-600">KMail with attached bid meat.</label>
        <CopyMessage text={`BID ${auction.auctionNumber || auction.id}`} label="BID command" recipient="kHub (#3888760)" inputId={inputId} inline className="col-start-1 row-start-2 min-w-0" />
        <button type="button" onClick={onClose} aria-label="Close Bid Form"
            className="col-start-2 row-start-2 inline-flex h-6 w-20 items-center justify-center rounded-none rounded-r-[2px] border border-gray-300 bg-white p-0 text-xs font-semibold text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-500">Close</button>
    </div>;
    if (auction.escrowMode) return <KmailInstructions auction={auction} showHeading={showHeading} />;
    if (currentUser.id === auction.highestBidderId) return <p className="text-sm font-semibold text-blue-700">You are the highest bidder.</p>;

    if (inline) return <form onSubmit={submit} aria-label={`Bid on ${auction.item}`} className="grid h-full min-h-0 w-full min-w-0 grid-cols-[minmax(0,1fr)_clamp(104px,50%,160px)] grid-rows-[18px_24px] gap-y-0.5 text-left">
        <label htmlFor={inputId} className={error || message ? 'sr-only' : 'col-start-1 row-start-1 self-end text-[10px] font-medium leading-3 text-gray-600'}>Your Bid (Meat)</label>
        {auction.instantPurchasePrice > 0 && <button type="button" disabled={pending} onClick={event => submit(event, true)} title={`Buyout: ${auction.instantPurchasePrice.toLocaleString('en-US')} Meat`}
            className="button-green col-start-2 row-start-1 inline-flex h-[18px] items-center justify-center rounded-[2px] border border-green-800 bg-green-800 p-0 text-[11px] font-semibold text-green-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-green-700 disabled:cursor-not-allowed disabled:border-gray-300 disabled:bg-gray-100 disabled:text-gray-500">Buy Now</button>}
        <input id={inputId} type="text" inputMode="decimal" autoComplete="off" autoFocus
            value={amount} onChange={(event) => { setAmount(event.target.value); setError(''); setMessage(''); }}
            onBlur={() => setAmount(value => normalizeAuctionAmount(value, { meat: true }))}
            placeholder={minimum === null ? minimumText : `Min: ${minimumText} · k/m/b`} disabled={pending || minimum === null}
            title={minimum === null ? minimumText : `Next minimum bid: ${minimumText} Meat. Full amounts or k/m/b shorthand.`}
            aria-invalid={Boolean(error)} aria-describedby={`${inputId}-help${error ? ` ${inputId}-error` : ''}`}
            className="col-start-1 row-start-2 h-6 w-full min-w-0 rounded-none rounded-l-[2px] border border-r-0 border-gray-400 bg-white px-2 text-xs text-gray-900 placeholder:text-[11px] placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500" />
        <div className={`col-start-2 row-start-2 grid h-6 grid-cols-2 overflow-hidden ${auction.instantPurchasePrice ? 'rounded-br-[2px]' : 'rounded-r-[2px]'}`}>
            <button type="submit" disabled={pending || minimum === null} className="h-full min-h-0 min-w-0 rounded-none border border-blue-700 bg-blue-700 p-0 text-xs font-semibold text-white hover:border-blue-700 hover:bg-blue-100 hover:text-blue-800 disabled:border-gray-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-800 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500">{pending ? '…' : 'Bid'}</button>
            <button type="button" onClick={onClose} disabled={pending} aria-label="Close Bid Form"
                className="h-full min-h-0 min-w-0 rounded-none border border-l-0 border-gray-300 bg-white p-0 text-xs font-semibold text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500">Close</button>
        </div>
        <p id={`${inputId}-help`} className="sr-only">{minimum === null ? minimumText : `Next minimum bid: ${minimumText} Meat. Full amounts or k/m/b shorthand.`}</p>
        {(error || message) && <div className="col-start-1 row-start-1 min-h-0 overflow-y-auto bg-[#F8F6F4] text-[10px] leading-3">
            {error && <p id={`${inputId}-error`} role="alert" className="break-words text-red-700">{error}</p>}
            {message && <p role="status" className="text-green-700">{message}</p>}
        </div>}
    </form>;

    return (
        <form onSubmit={submit} className="w-full space-y-1.5 text-left" aria-label={`Bid on ${auction.item}`}>
            {showTerms && <div className={`text-xs ${compact ? 'leading-4 text-gray-500' : 'text-gray-700'}`}><SettlementTerms escrowMode={false} /></div>}
            <label htmlFor={inputId} className="block text-sm font-semibold">Your bid (Meat)</label>
            <input id={inputId} type="text" inputMode="decimal" autoComplete="off"
                value={amount} onChange={(event) => { setAmount(event.target.value); setError(''); setMessage(''); }}
                onBlur={() => setAmount(value => normalizeAuctionAmount(value, { meat: true }))}
                placeholder={minimum === null ? minimumText : `${minimumText} · Full amounts or k/m/b shorthand.`} disabled={pending || minimum === null}
                aria-invalid={Boolean(error)} aria-describedby={`${inputId}-help${error ? ` ${inputId}-error` : ''}`}
                className={`w-full min-w-0 rounded border border-gray-400 bg-white text-gray-900 ${compact ? 'min-h-10 px-3 py-2 text-sm' : 'min-h-11 p-3 text-base'}`} />
            <p id={`${inputId}-help`} className="pb-4 text-xs text-gray-600">{minimum === null ? minimumText : `Next minimum bid: ${minimumText} Meat.`}</p>
            <button type="submit" disabled={pending || minimum === null} className={`w-full rounded bg-blue-600 px-4 font-semibold text-white hover:bg-blue-700 disabled:opacity-50 ${compact ? 'min-h-9 py-2 text-sm' : 'min-h-11 py-3'}`}>
                {pending ? 'Submitting…' : 'Place Bid'}
            </button>
            {error && <p id={`${inputId}-error`} role="alert" className="break-words text-sm text-red-700">{error}</p>}
            {message && <p role="status" className="text-sm text-green-700">{message}</p>}
        </form>
    );
}

AuctionBidForm.propTypes = { auction: PropTypes.object.isRequired, showTerms: PropTypes.bool, showHeading: PropTypes.bool, compact: PropTypes.bool, inline: PropTypes.bool, onClose: PropTypes.func };
