import RelistButton from './RelistButton';
import AuctionEndedTime from './AuctionEndedTime';
import { useContext, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Link, useLocation } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { AuctionsContext } from '../context/AuctionsContext';
import { getAuctionResult, getAuctionDisplayStatus, auctionCardBackground } from '../lib/auctionLifecycle';
import { timeRemaining } from '../lib/auctionBrowsing';
import { formatCompactMeat } from '../lib/formatMeat';
import { normalizeAuctionAmount, parseAuctionAmount } from '../lib/auctionInputs';
import FittedPrice from './FittedPrice';
import CopyMessage from './CopyMessage';

export default function BuyAuctionCard({ auction, now, inlineReserve = false, expanded = false, onToggleReserve }) {
    const { currentUser } = useContext(UserContext);
    const { reserveBuyQuantity, cancelBuyReservation } = useContext(AuctionsContext) || {};
    const location = useLocation();
    const formId = useId();
    const [quantity, setQuantity] = useState('1');
    const [pending, setPending] = useState(false);
    const pendingRef = useRef(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [saved, setSaved] = useState(null);
    const [resolvedId, setResolvedId] = useState(null);
    const result = getAuctionResult(auction, now);
    const status = getAuctionDisplayStatus(auction, result);
    const ended = ['completed', 'awaiting_trade', 'settling', 'ended_no_bids', 'expired', 'cancelled', 'voided'].includes(result.status);
    const active = result.status === 'active' && !auction.buyClosingReason;
    const owns = currentUser?.id === auction.sellerId;
    const available = auction.availableQuantity ?? auction.remainingQuantity ?? 0;
    const purchased = auction.purchasedQuantity || 0;
    const reserved = auction.reservedQuantity || 0;
    const target = Math.max(purchased, auction.quantity - (auction.reducedQuantity || 0));
    // A later snapshot may fulfill, expire or cancel a successful local reservation.
    const candidate = auction.myReservation || (saved?.auction === auction ? saved.reservation : null);
    const reservation = candidate?.id === resolvedId ? null : candidate;
    const showForm = inlineReserve && expanded && !owns && !currentUser?.isBanned && (active || reservation);
    const count = parseAuctionAmount(quantity, available);
    const itemLabel = `${auction.item} ×${auction.quantity.toLocaleString('en-US')}`;
    const linkState = { browseFrom: `${location.pathname}${location.search}` };
    const actionClass = 'inline-flex h-8 shrink-0 items-center justify-center rounded-[2px] border border-blue-600 bg-blue-600 px-3 py-0 text-xs font-semibold text-white hover:border-blue-700 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50';

    function step(change) {
        setQuantity(value => {
            const parsed = value.trim() ? parseAuctionAmount(value, available) : 0;
            return parsed === null ? value : String(Math.min(available, Math.max(1, parsed + change)));
        });
    }
    async function reserve(event) {
        event.preventDefault();
        if (pendingRef.current || !currentUser || currentUser.isBanned || owns || !active || reservation) return;
        const amount = parseAuctionAmount(quantity, available);
        if (amount === null) { setError('Enter an available whole quantity.'); return; }
        pendingRef.current = true;setPending(true);setError('');setNotice('');
        try { setSaved({auction, reservation: await reserveBuyQuantity(auction.id, amount)}); }
        catch (failure) { setError(failure.message); }
        finally { pendingRef.current = false;setPending(false); }
    }
    async function cancel() {
        if (pendingRef.current || !reservation) return;
        pendingRef.current = true;setPending(true);setError('');setNotice('');
        try {
            const outcome = await cancelBuyReservation(reservation.id);
            setResolvedId(reservation.id);setSaved(null);
            setNotice(outcome.state === 'fulfilled' ? 'This reservation was already fulfilled.'
                : outcome.state === 'expired' ? 'This reservation has expired.' : 'Reservation canceled.');
        } catch (failure) { setError(failure.message); }
        finally { pendingRef.current = false;setPending(false); }
    }

    return <article className={`relative isolate min-h-[134px] min-w-0 self-start rounded-lg border border-gray-200 px-3 py-1.5 shadow-sm transition-shadow hover:border-gray-300 hover:shadow-md ${auctionCardBackground(result.status)} auction-card`}>
        <div className="flex h-[120px] min-w-0 flex-col">
            <header className="flex h-8 shrink-0 items-start justify-between gap-3">
                <Link to={`/auction/${auction.id}`} state={linkState} title={itemLabel}
                    className="min-w-0 flex-1 rounded text-[#14248A] after:absolute after:inset-0 after:z-0 after:cursor-pointer after:rounded-lg hover:text-[#14248A] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-blue-500">
                    <h2 className="flex min-w-0 items-start gap-1 text-base font-bold leading-4">
                        <span className="line-clamp-2 min-w-0 break-words">{auction.item}</span>
                        <span className="shrink-0 whitespace-nowrap font-semibold text-[#5365AB]">×{auction.quantity.toLocaleString('en-US')}</span>
                    </h2>
                </Link>
                <div className="flex max-w-[45%] shrink-0 flex-col items-end gap-1 text-right">
                    {active ? <p className={`text-[11px] leading-3 tabular-nums ${auction.endTime - now <= 10800000 ? 'text-red-700' : auction.endTime - now <= 86400000 ? 'text-amber-700' : 'text-gray-500'}`}>
                        <time dateTime={new Date(auction.endTime).toISOString()}>{timeRemaining(auction.endTime, now)}</time> left
                    </p> : <p title={status.label} className={`max-w-full truncate text-xs font-semibold leading-3 ${status.color}`}>{status.label}</p>}
                    <span className="inline-flex rounded border border-red-200 bg-red-100 px-1.5 py-0.5 text-[11px] font-medium leading-3 text-red-700">Buy</span>
                </div>
            </header>
            <div className="flex h-[52px] min-w-0 shrink-0 items-start gap-3">
                <Link to={`/auction/${auction.id}`} state={linkState} aria-label={`View ${itemLabel}`} className="relative z-10 flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-md bg-white/70">
                    {auction.image ? <img src={auction.image} alt="" loading="lazy" className="h-[60px] w-[60px] object-contain [image-rendering:pixelated]" /> : <span className="text-[10px] text-gray-400">No image</span>}
                </Link>
                <div className="min-w-0 flex-1">
                    {showForm ? <>
                        <FittedPrice as="p" fitKey={`${auction.pricePerItem}:${available}:reserve`} className="w-full text-center text-sm font-semibold leading-4 text-[#112D4E]">
                            {formatCompactMeat(auction.pricePerItem)} Meat / item <span className="font-normal text-gray-600">· {available.toLocaleString('en-US')} available</span>
                        </FittedPrice>
                        <section id={formId} aria-label={`Selling to ${auction.item}`} className="relative z-10 mt-1">
                            {!currentUser ? <p className="text-xs leading-4 text-red-800"><Link to="/login" className="underline">Log in</Link> or <Link to="/register" className="underline">register</Link> to reserve items.</p>
                                : reservation ? <p className="text-center text-xs text-green-700">{reservation.quantity.toLocaleString('en-US')} reserved · Instructions below</p>
                                    : available > 0 ? <form onSubmit={reserve} className="flex min-w-0 gap-1">
                                        <input id={`${formId}-quantity`} aria-label="Quantity to sell" type="text" inputMode="numeric" role="spinbutton"
                                            aria-valuemin={1} aria-valuemax={available} aria-valuenow={count ?? undefined}
                                            value={quantity} disabled={pending} onChange={event => setQuantity(event.target.value)}
                                            onBlur={() => setQuantity(value => normalizeAuctionAmount(value))}
                                            onKeyDown={event => {
                                                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault();step(event.key === 'ArrowUp' ? 1 : -1); }
                                            }} className="h-8 min-w-0 flex-1 rounded-[2px] border border-gray-400 bg-white px-2 text-sm text-gray-900" />
                                        <div className="flex h-8 w-6 shrink-0 flex-col overflow-hidden rounded-[2px] border border-gray-400 bg-white">
                                            <button type="button" aria-label="Increase quantity" disabled={pending || count === available || count === null && quantity.trim() !== ''}
                                                onClick={() => step(1)} className="flex min-h-0 flex-1 items-center justify-center border-0 bg-transparent p-0 text-[9px] leading-none text-gray-700 disabled:opacity-40">▲</button>
                                            <button type="button" aria-label="Decrease quantity" disabled={pending || count === null || count <= 1}
                                                onClick={() => step(-1)} className="flex min-h-0 flex-1 items-center justify-center border-0 border-t border-gray-300 bg-transparent p-0 text-[9px] leading-none text-gray-700 disabled:opacity-40">▼</button>
                                        </div>
                                        <button type="submit" disabled={pending} className={actionClass}>{pending ? 'Reserving…' : 'Reserve'}</button>
                                    </form> : <p className="text-center text-xs text-gray-600">No quantity available right now.</p>}
                        </section>
                    </> : <>
                        <FittedPrice as="p" fitKey={`${auction.pricePerItem}:buy`} className="w-full text-center text-[26px] font-bold leading-7 tracking-tight text-[#112D4E]">
                            {formatCompactMeat(auction.pricePerItem)} Meat <span className="text-[11px] font-normal leading-none tracking-normal text-gray-500">/ item</span>
                        </FittedPrice>
                        <p className="truncate text-center text-[11px] leading-[14px] text-gray-600">{purchased.toLocaleString('en-US')} / {target.toLocaleString('en-US')} purchased{reserved > 0 && <> · {reserved.toLocaleString('en-US')} reserved</>}</p>
                        <progress aria-label="Order fulfillment" data-status={result.status} value={purchased} max={target || 1} className="buy-card-progress mt-1 h-1.5 w-full" />
                    </>}
                </div>
            </div>
            <footer className="mt-1 flex min-h-8 shrink-0 items-end justify-end gap-2">
                {ended && !showForm ? <><AuctionEndedTime auction={auction} /><div className="relative z-10 ml-auto flex shrink-0 flex-col items-center gap-0.5">{owns && <span className="text-[10px] text-gray-500">Your Listing</span>}<RelistButton auction={auction} now={now} /></div></> : showForm ? <button type="button" onClick={onToggleReserve} disabled={pending} aria-label="Close reservation form" aria-expanded={true} aria-controls={formId} className="relative z-10 inline-flex h-8 min-w-24 shrink-0 items-center justify-center rounded-[2px] border border-gray-300 bg-white px-4 py-0 text-xs font-semibold text-gray-700 hover:border-gray-400 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-500">Close</button>
                    : owns ? <span className="rounded bg-white/70 px-2 py-1 text-[11px] font-medium text-gray-500">Your Listing</span>
                        : inlineReserve && (active || reservation) ? <button type="button" disabled={currentUser?.isBanned || !reservation && available <= 0} onClick={onToggleReserve}
                            aria-expanded={false} aria-controls={formId} className={`relative z-10 ${actionClass}`}>{reservation ? 'View reservation' : 'Sell to this order'}</button>
                            : <Link to={`/auction/${auction.id}`} state={linkState} className="relative z-10 text-xs font-semibold text-blue-700 underline">{active ? 'Sell to this order' : 'View order'}</Link>}
            </footer>
        </div>
        {showForm && currentUser && reservation && <section aria-label="Reservation instructions" className="relative z-10 mt-2 space-y-1 border-t border-gray-200 pt-2 text-xs leading-4">
            <p>Send exactly <strong>{reservation.quantity.toLocaleString('en-US')} × {auction.item}</strong> to <strong>kHub (#3888760)</strong>, without Meat or other items.</p>
            <p>Send before <time dateTime={reservation.expires_at}>{new Date(reservation.expires_at).toLocaleString()}</time>. {Date.parse(reservation.expires_at) <= now && 'Deadline passed; checking timely incoming mail before releasing this reservation.'}</p>
            <CopyMessage text={`FILL ${auction.auctionNumber || auction.id} ${reservation.id}`} label="reserved fulfillment command" inline />
            <div className="flex items-center justify-between gap-2">
                <p className="text-gray-600">Cancel only if you haven’t sent the items.</p>
                <button type="button" onClick={cancel} disabled={pending} className="button-red shrink-0 rounded border px-2 py-1 disabled:opacity-50">{pending ? 'Canceling…' : 'Cancel reservation'}</button>
            </div>
        </section>}
        {showForm && error && <p role="alert" className="relative z-10 mt-2 text-xs text-red-800">{error}</p>}
        {showForm && notice && <p role="status" className="relative z-10 mt-2 text-xs text-green-700">{notice}</p>}
    </article>;
}
BuyAuctionCard.propTypes = {
    auction: PropTypes.object.isRequired, now: PropTypes.number.isRequired,
    inlineReserve: PropTypes.bool, expanded: PropTypes.bool, onToggleReserve: PropTypes.func,
};
