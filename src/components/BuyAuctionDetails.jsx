import { feeLabel, effectiveFeePercent } from '../lib/feeDisplay';
import { buyFunding, buyFee } from '../lib/buyOrders';
import { useContext, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { AuctionsContext } from '../context/AuctionsContext';
import { getAuctionResult } from '../lib/auctionLifecycle';
import { parseAuctionAmount } from '../lib/auctionInputs';
import { timeRemaining } from '../lib/auctionBrowsing';
import EscrowProtection from './EscrowProtection';
import CopyMessage from './CopyMessage';
import SellerLink from './SellerLink';

export default function BuyAuctionDetails({ auction, now, backLink }) {
    const { currentUser } = useContext(UserContext);
    const { cancelAuction, reserveBuyQuantity, cancelBuyReservation } = useContext(AuctionsContext);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [quantity, setQuantity] = useState('1');
    const [localReservation, setLocalReservation] = useState(null);
    const [resolvedReservation, setResolvedReservation] = useState(null);
    const [notice, setNotice] = useState('');
    const candidate = auction.myReservation || (localReservation && Date.parse(localReservation.expires_at) > now ? localReservation : null);
    const reservation = candidate?.id === resolvedReservation ? null : candidate;
    const available = auction.availableQuantity ?? auction.remainingQuantity;
    const quantityValue = parseAuctionAmount(quantity, available);
    function stepQuantity(change) {
        setQuantity(value => {
            const count = value.trim() ? parseAuctionAmount(value, available) : 0;
            return count === null ? value : String(Math.min(available, Math.max(1, count + change)));
        });
    }
    const target = Math.max(auction.purchasedQuantity || 0, auction.quantity - (auction.reducedQuantity || 0));
    const owns = currentUser?.id === auction.sellerId;
    const result = getAuctionResult(auction, now);
    const active = result.status === 'active';
    const canCancel = owns && !currentUser.isBanned && !auction.buyClosingReason && ['active','pending_escrow'].includes(auction.status);
    const purchased = auction.purchasedQuantity || 0;
    async function reserve(event) {
        event.preventDefault();
        if (pending) return;
        const count = parseAuctionAmount(quantity, available);
        if (count === null) { setError('Enter an available whole quantity.'); return; }
        setPending(true);setError('');setNotice('');
        try { setLocalReservation(await reserveBuyQuantity(auction.id, count)); } catch (failure) { setError(failure.message); } finally { setPending(false); }
    }
    async function cancelReservation() {
        if (pending || !reservation) return;
        setPending(true);setError('');setNotice('');
        try {
            const result = await cancelBuyReservation(reservation.id);
            setResolvedReservation(reservation.id);setLocalReservation(null);
            setNotice(result.state === 'fulfilled' ? 'This reservation has already been fulfilled. Completed purchases cannot be canceled.'
                : result.state === 'expired' ? 'This reservation has already expired.' : 'Reservation canceled. The reserved quantity has been released.');
        } catch (failure) { setError(failure.message); } finally { setPending(false); }
    }
    async function cancel() {
        if (pending) return;
        setPending(true);setError('');
        try { await cancelAuction(auction.id); } catch (failure) { setError(failure.message); } finally { setPending(false); }
    }
    return <main className="flex-1 bg-[#F1F3F5] px-4 py-6 sm:px-6">{backLink}
        <div className="mx-auto max-w-4xl space-y-5 rounded-lg border border-gray-200 bg-white p-4 shadow sm:p-6">
            <header className="flex items-center gap-4">{auction.image && <img src={auction.image} alt="" className="h-20 w-20 shrink-0 object-contain" />}<div className="min-w-0"><p className="text-sm font-semibold text-blue-700">Buy Auction · Escrow · #{auction.auctionNumber}</p><h1 className="break-words text-3xl font-bold text-blue-600">{auction.item}</h1><p className="text-sm">Requested by <SellerLink auction={auction} /></p></div></header>
            <section aria-label="Buy order overview" className="space-y-2">
                <p className="text-3xl font-bold">{auction.pricePerItem.toLocaleString('en-US')} Meat <span className="text-sm font-normal">per item</span></p>
                <p>Originally requested: <strong>{auction.quantity.toLocaleString('en-US')}</strong> · Purchased: <strong>{purchased.toLocaleString('en-US')}</strong> · Still requested: <strong>{auction.remainingQuantity.toLocaleString('en-US')}</strong></p>
                <p className="text-sm">Available to reserve: <strong>{available.toLocaleString('en-US')}</strong> · Reserved: <strong>{(auction.reservedQuantity || 0).toLocaleString('en-US')}</strong> · Reduced for delivery expenses: <strong>{(auction.reducedQuantity || 0).toLocaleString('en-US')}</strong></p>
                <progress aria-label="Order fulfillment" value={purchased} max={target || 1} className="h-3 w-full accent-blue-600" />
                <p className="text-sm">{target ? Math.floor(purchased / target * 100) : 0}% filled · {auction.buyClosingReason ? 'Closing — honoring existing reservations' : result.label}{active && <> · Ends in {timeRemaining(auction.endTime, now)}</>}</p>
                <p className="text-sm text-gray-600">The price applies to each item. Sellers receive the full price; the buyer pays commission separately.</p>
                <p className="text-sm">Delivery: {auction.deliveryMode === 'finished' ? 'When the order is fully filled, expires, or is canceled.' : 'As items are acquired.'}</p>
            </section>
            {owns && result.status === 'pending_escrow' && <section aria-label="Fund buy auction" className="space-y-2 rounded border border-blue-200 bg-blue-50 p-4">
                <h2 className="font-semibold">Fund your order</h2><p>Send <strong>{auction.fundingRequired?.toLocaleString('en-US')} Meat</strong> (purchase funds plus fee reserve) to <strong>kHub (#3888760)</strong>, with no items.</p>
                <p className="text-sm">Purchase funds: {buyFunding(auction.pricePerItem, auction.quantity).purchase.toLocaleString('en-US')} Meat · Estimated {feeLabel(buyFee(auction.pricePerItem, auction.quantity), BigInt(auction.pricePerItem) * BigInt(auction.quantity))}: {buyFee(auction.pricePerItem, auction.quantity).toLocaleString('en-US')} Meat · Commission reserve ({effectiveFeePercent(buyFunding(auction.pricePerItem, auction.quantity).feeReserve, BigInt(auction.pricePerItem) * BigInt(auction.quantity))}): {buyFunding(auction.pricePerItem, auction.quantity).feeReserve.toLocaleString('en-US')} Meat</p>
                <CopyMessage text={`FUND ${auction.auctionNumber || auction.id}`} label="funding command" />
                <p className="text-sm">The bot must accept your deposit within 24 hours of creating this listing. Your full auction timer starts when funding is accepted.</p>
            </section>}
            {(active || reservation) && !owns && <section aria-label="Fulfill buy auction" className="space-y-2 rounded border border-blue-200 bg-blue-50 p-4">
                <h2 className="font-semibold">Sell items to this order</h2>
                {currentUser && !currentUser.isBanned ? reservation ? <>
                    <p>Reserved: <strong>{reservation.quantity.toLocaleString('en-US')} × {auction.item}</strong></p>
                    <p className="text-sm">Send before <time dateTime={reservation.expires_at}>{new Date(reservation.expires_at).toLocaleString()}</time>{Date.parse(reservation.expires_at) > now ? ` (${timeRemaining(Date.parse(reservation.expires_at), now)} left)` : '. Deadline passed; kHub is checking timely incoming mail before releasing this reservation.'}</p>
                    <p className="text-sm">Send exactly the reserved quantity to <strong>kHub (#3888760)</strong>, without Meat or other items. Copy the entire command:</p>
                    <CopyMessage text={`FILL ${auction.auctionNumber || auction.id} ${reservation.id}`} label="reserved fulfillment command" />
                    <p className="text-xs text-gray-600">The KoL received timestamp determines whether your deposit is on time. Incorrect quantities or item types are safely returned.</p>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-xs text-gray-600">Cancel only if you have not sent the items. Items arriving after cancellation are returned.</p>
                        <button type="button" disabled={pending} onClick={cancelReservation} className="button-red ml-auto min-h-11 rounded border px-3 py-2 text-sm disabled:opacity-50">{pending ? 'Canceling…' : 'Cancel reservation'}</button>
                    </div>
                </> : available > 0 && !auction.buyClosingReason ? <form onSubmit={reserve} className="space-y-2">
                    <label htmlFor="reserve-quantity" className="block text-sm font-semibold">Quantity to sell (up to {available.toLocaleString('en-US')}):</label>
                    <div className="flex flex-wrap gap-2">
                        <div className="flex min-w-[180px] flex-1 gap-1">
                            <input id="reserve-quantity" type="text" inputMode="numeric" value={quantity} disabled={pending}
                                role="spinbutton" aria-valuemin={1} aria-valuemax={available} aria-valuenow={quantityValue ?? undefined}
                                onChange={event => setQuantity(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                        event.preventDefault();
                                        stepQuantity(event.key === 'ArrowUp' ? 1 : -1);
                                    }
                                }}
                                className="min-h-11 min-w-0 flex-1 rounded border border-gray-400 bg-white px-3 text-gray-900" />
                            <button type="button" aria-label="Increase quantity" title="Increase quantity by 1"
                                disabled={pending || quantityValue === available || (quantityValue === null && quantity.trim() !== '')}
                                onClick={() => stepQuantity(1)} className="min-h-11 min-w-11 shrink-0 rounded border border-gray-400 bg-white px-3 text-gray-900 disabled:opacity-40">▲</button>
                            <button type="button" aria-label="Decrease quantity" title="Decrease quantity by 1"
                                disabled={pending || quantityValue === null || quantityValue <= 1}
                                onClick={() => stepQuantity(-1)} className="min-h-11 min-w-11 shrink-0 rounded border border-gray-400 bg-white px-3 text-gray-900 disabled:opacity-40">▼</button>
                        </div>
                        <button disabled={pending} type="submit" className="min-h-11 rounded bg-blue-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending ? 'Reserving…' : 'Reserve for 10 minutes'}</button>
                    </div>
                    <p className="text-xs text-gray-600">Reserve first, then send your items using the provided command. Occasional expired reservations carry no penalty. Deliberately blocking sellers with repeated unfulfilled reservations may lead to warnings or administrative action. Maximum 3 active reservations and 12 new reservations per hour.</p>
                </form> : <p className="text-sm">{auction.buyClosingReason ? 'This order is closing. Existing reservations remain protected.' : 'No quantity is currently available. Reservations or pending delivery checks may release more shortly.'}</p> : <p><Link to="/login" className="text-blue-700 underline">Log in</Link> with your linked account to reserve a quantity.</p>}
            </section>}
            {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
            {owns && auction.giftFundingNeeded && <section aria-label="Gift delivery funding" className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"><p>Purchased items are safely held. A required gift package needs 50 Meat of uncommitted funds; funds reserved for sellers cannot be used. Add Meat to resume delivery:</p><CopyMessage text={`FUND ${auction.auctionNumber || auction.id}`} label="gift funding command" /></section>}
            {auction.status === 'settling' && <p>The order has closed. Payments, purchased items, and unused funds are being delivered. Settlement completes once all deliveries are confirmed.</p>}
            {(owns || auction.buyAdmin) && auction.balanceMeat != null && <section aria-label="Your buy escrow" className="text-sm"><p>Remaining escrow: {auction.balanceMeat.toLocaleString('en-US')} Meat · Purchased: {auction.purchaseMeat.toLocaleString('en-US')} Meat · {feeLabel(auction.buyCommissionMeat, auction.purchaseMeat)}: {auction.buyCommissionMeat.toLocaleString('en-US')} Meat · Gift expenses: {(auction.giftMeat || 0).toLocaleString('en-US')} Meat · Refund queued/returned: {auction.refundedMeat.toLocaleString('en-US')} Meat</p><p>Purchased items still held before delivery: {auction.heldQuantity.toLocaleString('en-US')}. Queued deliveries are tracked separately.</p></section>}
            {canCancel && <button disabled={pending} onClick={cancel} className="button-red rounded border px-4 py-2 disabled:opacity-50">{pending ? 'Canceling…' : 'Cancel remaining order'}</button>}
            {error && <p role="alert" className="text-red-700">{error}</p>}
            {(owns || auction.fulfilledByMe) && currentUser && !currentUser.isBanned && <p><Link to={`/auction/${auction.id}/trade-query`} className="text-sm text-blue-700 underline">Contact an administrator about this order</Link></p>}
            <EscrowProtection buy />
            {auction.buyAdmin && auction.reservationAudit?.length > 0 && <details className="text-xs"><summary className="cursor-pointer">Reservation and gift audit</summary><ul>{auction.reservationAudit.map(event => <li key={event.id} className="py-1">{new Date(event.created_at).toLocaleString()} · {event.kind} · {JSON.stringify(event.details)}</li>)}</ul></details>}
            <section aria-label="Fulfillment history" className="space-y-2"><h2 className="text-xl font-bold">Fulfillment history</h2><p className="text-xs text-gray-500">Latest 100 accepted fulfillments. Completed purchases cannot be reversed.</p>
                {auction.fulfillments.length ? <ul className="divide-y">{auction.fulfillments.map((fill,index) => <li key={fill.receipt_id || index} className="py-3 text-sm"><p>{fill.seller} · {Number(fill.quantity).toLocaleString('en-US')} items × {Number(fill.price_per_item).toLocaleString('en-US')} Meat / item · {Number(fill.payment_meat).toLocaleString('en-US')} Meat {fill.payment_sent ? 'paid' : 'payment queued'}</p>{fill.commission_meat != null && <p>{feeLabel(fill.commission_meat, fill.payment_meat)}: {Number(fill.commission_meat).toLocaleString('en-US')} Meat</p>}<time dateTime={fill.created_at} className="text-xs text-gray-500">{new Date(fill.created_at).toLocaleString()}</time>{fill.delivery_references && <p className="text-xs text-gray-500">{fill.delivery_references.map(d => `${d.reference} (${d.state})`).join(' · ')}</p>}</li>)}</ul> : <p className="text-sm text-gray-600">No purchases yet.</p>}
            </section>
        </div>
    </main>;
}
BuyAuctionDetails.propTypes = { auction: PropTypes.object.isRequired, now: PropTypes.number.isRequired, backLink: PropTypes.node };
