import AuctionEndedTime from './AuctionEndedTime';
import MarketPrice from './MarketPrice';
import { effectiveFeePercent } from '../lib/feeDisplay';
import { buyFunding, buyRefundableFeeReserve } from '../lib/buyOrders';
import {formatBuyAuditDate,describeBuyAuditEvent} from '../lib/buyAuctionAudit';
import { useContext, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { AuctionsContext } from '../context/AuctionsContext';
import { getAuctionResult } from '../lib/auctionLifecycle';
import { parseAuctionAmount } from '../lib/auctionInputs';
import { auctionEndTime, timeRemaining } from '../lib/auctionBrowsing';
import { canSendTradeQuery } from '../lib/tradeQueries';
import EscrowProtection from './EscrowProtection';
import CopyMessage from './CopyMessage';
import SellerLink from './SellerLink';
import ItemResources from './ItemResources';
import AuctionItemImage from './AuctionItemImage';

const fulfillmentColumns = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,.7fr)_minmax(0,1.1fr)] gap-x-2 sm:gap-x-3';

export default function BuyAuctionDetails({ auction, now, backLink }) {
    const { currentUser } = useContext(UserContext);
    const { cancelAuction, reserveBuyQuantity, cancelBuyReservation } = useContext(AuctionsContext);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [quantity, setQuantity] = useState('1');
    const [localReservation, setLocalReservation] = useState(null);
    const [resolvedReservation, setResolvedReservation] = useState(null);
    const [notice, setNotice] = useState('');
    const candidate = auction.myReservation && Date.parse(auction.myReservation.expires_at) > now
        ? auction.myReservation : localReservation && Date.parse(localReservation.expires_at) > now ? localReservation : null;
    const reservation = candidate?.id === resolvedReservation ? null : candidate;
    const reservationConfirmed = Boolean(currentUser && !currentUser.isBanned && reservation);
    const reservationDeadline = reservation ? Date.parse(reservation.expires_at) : null;
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
    const canViewSellers = Boolean(currentUser && !currentUser.isBanned && auction.usernamesVisible !== false);
    const canViewFees = Boolean(currentUser && !currentUser.isBanned && auction.usernamesVisible !== false && (owns || auction.buyAdmin));
    const auditEvents = canViewFees && auction.buyAdmin
        ? (auction.reservationAudit || []).filter(event=>event.kind!=='reservation_expired') : [];
    const result = getAuctionResult(auction, now);
    const funding = owns && canViewFees && result.status === 'pending_escrow'
        ? buyFunding(auction.pricePerItem, auction.quantity) : null;
    const active = result.status === 'active';
    const closed = Boolean(auction.buyClosingReason) || ['completed', 'cancelled', 'expired', 'voided', 'settling'].includes(result.status);
    const canCancel = owns && !currentUser.isBanned && !auction.buyClosingReason && ['active','pending_escrow'].includes(auction.status);
    const purchased = auction.purchasedQuantity || 0;
    const outcomeLabel = active && !closed ? 'In Progress' : result.status === 'cancelled' ? 'Canceled early' : result.label;
    const outcomeColor = active && !closed ? 'text-yellow-700 accent-yellow-500' : { completed: 'text-green-700 accent-green-700', cancelled: 'text-purple-700 accent-purple-700', expired: 'text-amber-700 accent-amber-700', voided: 'text-red-700 accent-red-700' }[result.status] || 'text-blue-700 accent-blue-700';
    const progressPercent = target ? purchased / target * 100 : 0;
    const progressLabel = progressPercent > 0 && progressPercent < 1 ? '<1%' : `${Math.floor(progressPercent)}%`;
    const badgeClass = active && !closed ? 'buy-detail-active-badge bg-[#FFF1D6] text-[#B7791F]'
        : 'bg-white/70 ' + outcomeColor;
    const ending = new Date(auction.endTime);
    const formatDate = date => date.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
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
    return <main className="site-page-background flex-1 bg-[#F1F3F5] px-4 py-6 sm:px-6">{backLink}
        <div className="buy-auction-detail mx-auto max-w-4xl space-y-5 rounded-xl border border-[#E8DDD7] bg-[#FFFAF7] p-4 shadow-sm sm:p-6">
            <header className="flex items-start gap-3 border-b border-[#E8DDD7] pb-4">
                {auction.image && <AuctionItemImage key={auction.id} src={auction.image} item={auction.item} compact />}
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                        <p className="text-xs text-[#64748B]">Buy Auction · #{auction.auctionNumber}</p>
                        <span aria-label="Auction status" className={`ml-auto max-w-full rounded-full px-2.5 py-1 text-xs font-semibold ${badgeClass}`}>{outcomeLabel}</span>
                    </div>
                    <h1 className="buy-detail-title break-words text-2xl font-bold leading-tight text-[#172554]">{auction.item}</h1>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#64748B]">
                        <p>Requested by <SellerLink auction={auction} /></p>
                        <ItemResources item={auction.item} itemId={auction.itemId} />
                    </div>
                </div>
            </header>
            <section aria-label="Buy order overview" className="space-y-3">
                <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[minmax(0,8fr)_minmax(0,5fr)_minmax(0,7fr)] sm:gap-5">
                    <div className="min-w-0 space-y-1">
                        <h2 className="text-xs font-medium text-[#64748B]">Offer Price</h2>
                        <p className="buy-detail-price break-words text-2xl font-bold leading-tight tracking-tight text-[#183153]">{auction.pricePerItem.toLocaleString('en-US')} <span className="whitespace-nowrap text-sm font-normal tracking-normal">Meat / item</span></p>
                        {((active && !closed) || result.status === 'completed') && <MarketPrice itemId={auction.itemId} auctionId={auction.id} completed={result.status === 'completed'} />}
                    </div>
                    <div className="min-w-0 space-y-1">
                        <h2 className="text-xs font-medium text-[#64748B]">Order Progress</h2>
                        <p className="break-words text-2xl font-semibold leading-tight text-gray-900">{purchased.toLocaleString('en-US')} <span className="text-base font-normal text-[#64748B]">/ {target.toLocaleString('en-US')}</span></p>
                        <p className="text-xs text-[#64748B]">{progressLabel} filled</p>
                        {target !== auction.quantity && <p className="text-xs text-[#64748B]">Originally requested: {auction.quantity.toLocaleString('en-US')}</p>}
                    </div>
                    <div className="min-w-0 space-y-1">
                        <h2 className="text-xs font-medium text-[#64748B]">{active && !closed ? 'Time Remaining' : 'Status'}</h2>
                        {active && !closed ? <>
                            <p className="text-xl font-semibold leading-tight text-gray-900">{timeRemaining(auction.endTime, now)}</p>
                            {Number.isFinite(ending.getTime()) && <p className="text-xs text-[#64748B]">Ends <time dateTime={ending.toISOString()}>{formatDate(ending)}</time></p>}
                        </> : <>
                            <p className="text-sm font-medium text-gray-800">{result.status === 'pending_escrow' ? 'Starts after funding' : outcomeLabel}</p>
                            {['completed', 'expired', 'cancelled', 'voided'].includes(result.status)
                                && Number.isFinite(auctionEndTime(auction)) && auctionEndTime(auction) <= now
                                && <AuctionEndedTime auction={auction} compact={false} />}
                        </>}
                        {owns && canViewFees && <p className={`text-xs text-[#64748B] ${result.status === 'pending_escrow' ? '!mt-[0.333rem]' : ''}`}><strong>Delivery:</strong> {auction.deliveryMode === 'finished' ? 'When the order is fully filled, expires, or is canceled.' : 'As items are acquired.'}</p>}
                    </div>
                </div>
                <progress aria-label="Order fulfillment" value={purchased} max={target || 1}
                    data-status={result.status}
                    className="buy-card-progress block h-2 w-full accent-blue-500" />
                {active && !closed && <p className="text-xs text-[#64748B]">{(available ?? 0).toLocaleString('en-US')} available · {(auction.reservedQuantity || 0).toLocaleString('en-US')} reserved</p>}
                {auction.buyClosingReason && auction.reservedQuantity > 0 && ['active', 'settling'].includes(result.status) && <p className="text-xs text-[#64748B]">Honoring existing reservations</p>}
            </section>
            {owns && canViewFees && result.status === 'pending_escrow' && <section aria-label="Fund buy auction" className="buy-detail-action rounded-lg bg-[#F0F5FF] px-4 py-3">
                <h2 className="mb-4 text-2xl font-bold leading-tight">Fund your order</h2>
                <p className="w-full text-base font-normal leading-6">Send <strong className="buy-funding-highlight font-semibold text-[#B4232D]">{auction.fundingRequired?.toLocaleString('en-US')} Meat</strong> to <strong className="buy-funding-highlight font-semibold text-[#B4232D]">kHub (#3888760)</strong> via KMail. Include the command below in the message body. Attach no items.</p>
                <CopyMessage text={`FUND ${auction.auctionNumber || auction.id}`} label="funding command" className="mt-4 mb-3 w-full lg:max-w-[60%] [&_code]:text-lg [&_code]:font-medium" />
                <p className="buy-funding-breakdown flex flex-wrap gap-x-1 gap-y-1 text-sm text-[#526279]">
                    <span className="whitespace-nowrap">Purchase funds: <strong className="font-semibold text-gray-900">{funding.purchase.toLocaleString('en-US')} Meat</strong></span>
                    <span className="whitespace-nowrap">· Fee reserve ({effectiveFeePercent(funding.feeReserve, BigInt(funding.purchase))}): <strong className="font-semibold text-gray-900">{funding.feeReserve.toLocaleString('en-US')} Meat</strong></span>
                </p>
                <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-5 text-[#64748B]">
                    <svg aria-hidden="true" className="mt-0.5 shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7h.01" /></svg>
                    <span>Deposit within 24 hours. Your auction starts once funding is accepted.</span>
                </p>
            </section>}
            {(active || reservation) && !owns && <section aria-label="Fulfill buy auction" className={`buy-detail-action rounded-lg bg-[#F0F5FF] ${reservationConfirmed ? 'space-y-2 p-3' : 'space-y-3 p-4'}`}>
                {!reservationConfirmed && <div className="space-y-1">
                    <h2 className="buy-detail-title break-words text-base font-semibold text-[#172554]">Sell {auction.item}</h2>
                    <p className="text-sm text-gray-800">Receive <strong>{auction.pricePerItem.toLocaleString('en-US')} Meat per item</strong> · Up to {(available ?? 0).toLocaleString('en-US')} available</p>
                    <p className="text-xs text-[#64748B]">You receive the full listed price. The buyer covers all escrow fees.</p>
                </div>}
                {currentUser && !currentUser.isBanned ? reservation ? <>
                    <div className="space-y-0.5">
                        <h2 className="buy-reservation-heading text-sm font-semibold text-[#27804A]">✓ Reservation confirmed</h2>
                        <p className="break-words text-sm font-semibold text-gray-900">{reservation.quantity.toLocaleString('en-US')} × {auction.item}</p>
                    </div>
                    <div className="space-y-0.5">
                        <p className={`buy-reservation-deadline text-base font-semibold ${reservationDeadline - now < 120000 ? 'text-red-700' : 'text-[#B7791F]'}`}>
                            {reservationDeadline > now ? <>Send within <time dateTime={reservation.expires_at}>{timeRemaining(reservationDeadline, now)}</time></> : 'Deadline passed'}
                        </p>
                        <p className="text-xs text-[#64748B]">Expires <time dateTime={reservation.expires_at}>{formatDate(new Date(reservation.expires_at))}</time></p>
                        {reservationDeadline <= now && <p className="text-xs text-[#64748B]">kHub is checking timely incoming mail before releasing this reservation.</p>}
                    </div>
                    <p className="text-sm text-gray-800">Send <strong className="buy-detail-title font-bold text-[#2563EB]">{reservation.quantity.toLocaleString('en-US')} × {auction.item}</strong> to <strong>kHub (#3888760)</strong> via KMail, with no Meat or other items. Include the command below:</p>
                    <CopyMessage text={`FILL ${auction.auctionNumber || auction.id} ${reservation.id}`} label="reserved fulfillment command" compact
                        className="text-xs [&_.copy-message-field]:h-auto [&_.copy-message-field]:min-h-10 [&_.copy-message-field]:py-1" />
                    <p className="text-xs text-[#64748B]">Late or incorrect deposits will be returned.</p>
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1">
                        <p className="text-xs text-[#64748B]">Only cancel if you haven’t sent the items.</p>
                        <button type="button" disabled={pending} onClick={cancelReservation}
                            className="buy-reservation-cancel min-h-9 shrink-0 rounded border border-red-300 bg-transparent px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:opacity-50">{pending ? 'Canceling…' : 'Cancel reservation'}</button>
                    </div>
                </> : available > 0 && !auction.buyClosingReason ? <form onSubmit={reserve} className="space-y-2">
                    <label htmlFor="reserve-quantity" className="block text-sm font-semibold">Quantity to sell (up to {available.toLocaleString('en-US')}):</label>
                    <div className="flex flex-wrap gap-2">
                        <div className="flex min-w-0 flex-1 basis-full gap-1 sm:basis-auto">
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
                </form> : <p className="text-sm">{auction.buyClosingReason ? 'This order is closing. Existing reservations remain protected.' : 'No quantity is currently available. Reservations or pending delivery checks may release more shortly.'}</p> : <Link to="/login" className="buy-detail-login inline-flex min-h-11 items-center justify-center rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800">Log in to sell items →</Link>}
            </section>}
            {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}

            {auction.status === 'settling' && <p>The order has closed. Payments, purchased items, and unused funds are being delivered. Settlement completes once all deliveries are confirmed.</p>}
            {owns && canViewFees && auction.status !== 'pending_escrow' && auction.balanceMeat != null && <section aria-label="Escrow Summary" className="max-w-3xl text-sm">
                <h2 className="mb-2.5 text-[17px] font-semibold text-gray-900">Escrow Summary</h2>
                <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                    {[
                        ['Available funds', auction.balanceMeat],
                        ['Refundable fee reserve', buyRefundableFeeReserve(auction)],
                        ['Spent on purchases', auction.purchaseMeat],
                        ['Commission paid', auction.buyCommissionMeat],
                    ].map(([label, value]) => <div key={label} className="min-w-0">
                        <dt className="border-b border-[#E8DDD7] pb-1.5 text-[13px] font-medium text-gray-600">{label}</dt>
                        <dd className="break-words pt-1.5 font-normal tabular-nums text-gray-900">{value == null ? '—' : `${value.toLocaleString('en-US')} Meat`}</dd>
                    </div>)}
                </dl>
                {auction.heldQuantity > 0 && <p className="mt-2 text-xs text-gray-500">{auction.heldQuantity.toLocaleString('en-US')} purchased {auction.heldQuantity === 1 ? 'item' : 'items'} held for delivery.</p>}
            </section>}
            {canCancel && <div className="pt-3"><button disabled={pending} onClick={cancel} className="button-red rounded border px-4 py-2 disabled:opacity-50">{pending ? 'Canceling…' : 'Cancel remaining order'}</button></div>}
            {error && <p role="alert" className="text-red-700">{error}</p>}
            {canSendTradeQuery(auction, currentUser) && <p><Link to={`/auction/${auction.id}/trade-query`} className="text-sm text-blue-700 underline">Contact an administrator about this order</Link></p>}
            {auditEvents.length > 0 && <details className="text-sm"><summary className="cursor-pointer font-medium">Reservation history</summary><ul>{auditEvents.map(event => <li key={event.id} className="py-1.5">
                <time dateTime={event.created_at} className="whitespace-nowrap text-xs text-[#64748B]">{formatBuyAuditDate(event.created_at)}</time>
                <span className="text-[#64748B]"> · </span>
                <span>{describeBuyAuditEvent(event)}</span>
            </li>)}</ul></details>}
            <EscrowProtection buy showFees={canViewFees} />
            <details aria-label="Fulfillment history" className="border-t border-[#E8DDD7] pt-3">
                <summary className="cursor-pointer text-sm font-semibold text-gray-800">Fulfillment History ({auction.fulfillments.length.toLocaleString('en-US')})</summary>
                {auction.fulfillments.length > 0 && <div className={`buy-fulfillment-head mt-2 pb-2 text-xs font-medium text-[#64748B] ${fulfillmentColumns}`}>
                    <p>Seller</p>
                    <p>Date</p>
                    <p className="text-right">Quantity</p>
                    <p className="text-right">Total Paid</p>
                </div>}
                {auction.fulfillments.length ? <ul aria-label="Buy auction fulfillments" className="mt-2 divide-y divide-[#E8DDD7] text-xs sm:text-sm">
                    {auction.fulfillments.map((fill,index) => <li key={fill.receipt_id || index} className="py-2">
                        <div className={`items-baseline ${fulfillmentColumns}`}>
                            <p className="min-w-0 break-words">{canViewSellers && fill.seller_id ? <Link to={`/seller/${encodeURIComponent(fill.seller_id)}`} className="font-semibold text-blue-700 underline hover:text-blue-900">{fill.seller}</Link> : canViewSellers ? fill.seller : 'Seller'}</p>
                            <time dateTime={fill.created_at} className="min-w-0 text-xs text-[#64748B]">{new Date(fill.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
                            <p className="min-w-0 break-words text-right text-gray-900">{Number(fill.quantity).toLocaleString('en-US')} items</p>
                            <p className="min-w-0 break-words text-right text-gray-900"><span className="font-semibold">{Number(fill.payment_meat).toLocaleString('en-US')} Meat</span> {fill.payment_sent ? 'paid' : 'payment queued'}</p>
                        </div>
                        {canViewFees && fill.commission_meat != null && <p className="mt-1 text-xs text-[#64748B]">Commission: {Number(fill.commission_meat).toLocaleString('en-US')} Meat</p>}
                        {fill.delivery_references && <p className="mt-1 break-words text-xs text-[#64748B]">{fill.delivery_references.map(d => `${d.reference} (${d.state})`).join(' · ')}</p>}
                    </li>)}
                </ul> : <p className="mt-2 text-sm text-[#64748B]">No purchases yet.</p>}
            </details>
        </div>
    </main>;
}
BuyAuctionDetails.propTypes = { auction: PropTypes.object.isRequired, now: PropTypes.number.isRequired, backLink: PropTypes.node };
