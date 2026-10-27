import { effectiveFeePercent, feeLabel } from '../lib/feeDisplay';
import { escrowFee } from '../lib/escrowFees';
import { buyFunding } from '../lib/buyOrders';
import TradeTypeBadge from '../components/TradeTypeBadge';
import { useState, useContext, useDeferredValue, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import items from '../data/items.json';
import { supabase } from '../lib/supabase';
import { createItemCatalogService, itemImageUrl, isAuctionableItem } from '../lib/itemCatalog';
import { parseAuctionAmount, parseMeatAmount, normalizeAuctionAmount } from '../lib/auctionInputs';
import useKolIdentity from '../hooks/useKolIdentity';
import EscrowProtection from '../components/EscrowProtection';
import DirectTradeHelp from '../components/DirectTradeHelp';
import { auctionNow } from '../lib/auctionClock';
import { customAuctionEnd, localDateTimeInput, formatAuctionEnd, MAX_AUCTION_DURATION_MS } from '../lib/auctionSchedule';

const catalog = createItemCatalogService(supabase, items);
const resultLimit = 100;
const fieldClass = 'mb-4 block min-h-11 w-full min-w-0 rounded border border-gray-400 bg-white p-3 text-base text-gray-900';

export default function AuctionAnItem() {
    const { addAuction } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);
    const kolIdentity = useKolIdentity();
    const navigate = useNavigate();
    const [catalogItems, setCatalogItems] = useState(items);
    useEffect(() => {
        let active = true;
        catalog.load().then(updated => { if (active) setCatalogItems(updated); });
        return () => { active = false; };
    }, []);
    const sortedItems = useMemo(() => catalogItems.filter(isAuctionableItem)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(item => ({ ...item, searchName: item.name.toLocaleLowerCase() })), [catalogItems]);
    const [itemSearch, setItemSearch] = useState('');
    const [selectedItem, setSelectedItem] = useState('');
    const [quantity, setQuantity] = useState('1');
    const [minBidMeat, setMinBidMeat] = useState('');
    const [instantPrice, setInstantPrice] = useState('');
    const [showBuyout, setShowBuyout] = useState(false);
    const buyoutInput = useRef(null);
    const [auctionTime, setAuctionTime] = useState('24');
    const [customDuration, setCustomDuration] = useState(false);
    const [customEndTime, setCustomEndTime] = useState('');
    const endingTimeInput = useRef(null);
    const [escrowMode, setEscrowMode] = useState(true);
    const [auctionKind, setAuctionKind] = useState('sell');
    const [deliveryMode, setDeliveryMode] = useState('immediate');
    const isBuy = auctionKind === 'buy';
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const previewHeading = useRef(null);
    const publishDialog = useRef(null);
    const submitting = useRef(false);
    const deferredSearch = useDeferredValue(itemSearch);
    const hasItemSearch = Boolean(itemSearch.trim());
    const matchingItems = useMemo(() => {
        const query = deferredSearch.trim().toLocaleLowerCase();
        if (!query) return [];
        return sortedItems.filter((item) => item.searchName.includes(query));
    }, [deferredSearch, sortedItems]);
    const searchResults = matchingItems.slice(0, resultLimit);
    const quantityValue = parseAuctionAmount(quantity, 5000000000);
    const minimumValue = parseMeatAmount(minBidMeat);

    function stepQuantity(change) {
        setQuantity((value) => {
            const count = value.trim() ? parseAuctionAmount(value, 5000000000) : 0;
            if (count === null) return value;
            return String(Math.min(5000000000, Math.max(1, count + change)));
        });
    }

    function showPreview(event) {
        event.preventDefault();
        const item = catalogItems.find(entry => String(entry.id) === selectedItem && isAuctionableItem(entry));
        const count = parseAuctionAmount(quantity, 5000000000);
        const minimum = parseMeatAmount(minBidMeat);
        const purchasePrice = !isBuy && instantPrice.trim() ? parseMeatAmount(instantPrice) : null;
        if (!item) { setError('Please select an item to auction.'); return; }
        if (count === null) { setError('Quantity must be a whole number between 1 and 5 billion.'); return; }
        if (minimum === null) { setError(isBuy ? 'Enter a valid positive price per item in Meat.' : 'Enter a valid positive minimum bid in Meat.'); return; }
        if (!isBuy && instantPrice.trim() && (purchasePrice === null || purchasePrice < minimum)) {
            setError('Buyout price must be a valid Meat amount at least as large as the minimum bid.'); return;
        }
        if (isBuy) { try { buyFunding(minimum, count); } catch (failure) { setError(failure.message); return; } }
        let customEndAt = null;
        if (!isBuy && customDuration) {
            try { customEndAt = customAuctionEnd(customEndTime); }
            catch (failure) { setError(failure.message); return; }
        }
        setPreview({ item: item.name, itemId: item.id, quantity: count, minBidMeat: minimum, instantPurchasePrice: purchasePrice, auctionTime, escrowMode, ...(customEndAt ? { customEndAt } : {}),
            image: itemImageUrl(item.image), ...(isBuy ? { auctionKind, deliveryMode } : {}) });
        setError('');
        requestAnimationFrame(() => previewHeading.current?.focus());
    }

    async function confirm() {
        if (submitting.current || !preview) return;
        submitting.current = true;
        setPending(true);
        setError('');
        try {
            const id = await addAuction(preview);
            publishDialog.current?.close();
            navigate(id ? `/auction/${id}` : '/auctions');
        } catch (failure) {
            setError(failure.message);
        } finally {
            submitting.current = false;
            setPending(false);
        }
    }

    if (!currentUser) return (
        <main className="site-page-background flex-1 bg-gray-50 p-4">
            <div className="mx-auto mt-12 max-w-lg space-y-4 text-center">
                <h1 className="text-2xl font-bold text-red-700">You must be logged in to create an auction.</h1>
                <Link to="/login" className="inline-flex min-h-11 items-center text-lg text-blue-700 underline">Log In</Link>
                <p>Don’t have an account? <Link to="/register" className="text-blue-700 underline">Register</Link></p>
            </div>
        </main>
    );

    return (
        <main className="site-page-background flex-1 bg-gray-50 p-4 sm:p-6">
            <h1 className="mb-6 text-center text-3xl font-bold text-blue-600 sm:text-4xl">Create Auction</h1>
            {!preview && <p className="mx-auto mb-4 max-w-lg text-sm text-gray-700">{kolIdentity && !kolIdentity.kol_player_id && <>First <Link to="/profile" className="text-blue-700 underline">link your KoL account</Link>. </>}Choose what you want to buy or sell. The mode stays fixed after publishing.</p>}
            <div className="mx-auto max-w-lg rounded-lg bg-white p-4 shadow-md sm:p-8">
                {!preview && <div role="group" aria-label="Auction type" className="mb-5 grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
                    {[['buy','Buy Items'],['sell','Sell Items']].map(([value,label]) => <button key={value} type="button" aria-pressed={auctionKind === value}
                        onClick={() => { setAuctionKind(value); if (value === 'buy') { setEscrowMode(true); setCustomDuration(false); } setError(''); }}
                        className={`min-h-11 rounded-lg border px-4 py-2 text-sm font-semibold ${auctionKind === value ? 'border-blue-200 bg-white text-blue-800 shadow-sm' : 'border-transparent bg-transparent text-slate-500'}`}>{label}</button>)}
                </div>}
                {error && <p role="alert" className="mb-4 break-words font-semibold text-red-700">{error}</p>}
                {preview ? <section aria-label="Preview auction">
                    <h2 ref={previewHeading} tabIndex={-1} className="text-xl font-bold text-gray-900">Preview Auction</h2>
                    <p className="mt-1 text-sm text-gray-500">Review your listing details before publishing.</p>
                    <div className="my-4 flex min-w-0 items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
                        {preview.image && <img src={preview.image} alt={preview.item} className="h-24 w-24 shrink-0 object-contain [image-rendering:pixelated]" />}
                        <div className="min-w-0">
                            <p className="mb-1 text-xs text-gray-500">Item</p>
                            <h3 className="break-words text-lg font-semibold leading-snug text-gray-900">{preview.item}</h3>
                        </div>
                    </div>
                    <dl className="divide-y divide-gray-100 text-sm">
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">Quantity</dt>
                            <dd className="min-w-0 break-words text-right font-medium tabular-nums text-gray-900">{preview.quantity.toLocaleString('en-US')}</dd>
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">Trading method</dt>
                            <dd className="text-right"><TradeTypeBadge escrow={preview.escrowMode} short /></dd>
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">{preview.auctionKind === 'buy' ? 'Price per item' : 'Minimum bid (whole listing)'}</dt>
                            <dd className="min-w-0 break-words text-right font-medium tabular-nums text-gray-900">{preview.minBidMeat.toLocaleString('en-US')} Meat</dd>
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">{preview.auctionKind === 'buy' ? 'Delivery' : 'Buyout price (whole listing)'}</dt>
                            <dd className="min-w-0 break-words text-right font-medium tabular-nums text-gray-900">{preview.auctionKind === 'buy' ? (preview.deliveryMode === 'immediate' ? 'As acquired' : 'When order ends') : preview.instantPurchasePrice ? `${preview.instantPurchasePrice.toLocaleString('en-US')} Meat` : 'Not offered'}</dd>
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">{preview.customEndAt ? 'Ending time' : 'Duration'}</dt>
                            <dd className="min-w-0 break-words text-right font-medium tabular-nums text-gray-900">{preview.customEndAt ? formatAuctionEnd(preview.customEndAt) : `${preview.auctionTime} hours`}</dd>
                        </div>
                        {preview.auctionKind === 'buy' && <>{[['Purchase funds',buyFunding(preview.minBidMeat, preview.quantity).purchase],[`Commission reserve (${effectiveFeePercent(buyFunding(preview.minBidMeat, preview.quantity).feeReserve, BigInt(preview.minBidMeat) * BigInt(preview.quantity))})`,buyFunding(preview.minBidMeat, preview.quantity).feeReserve],['Required deposit, including fee reserve',buyFunding(preview.minBidMeat, preview.quantity).total]].map(([label,value]) => <div key={label} className="flex justify-between gap-3 py-3"><dt>{label}</dt><dd className="text-right font-semibold">{value.toLocaleString('en-US')} Meat</dd></div>)}</>}
                        {preview.auctionKind !== 'buy' && preview.escrowMode && <div className="flex justify-between gap-3 py-3"><dt>Estimated {feeLabel(escrowFee(preview.minBidMeat), preview.minBidMeat)} at minimum bid</dt><dd className="text-right font-semibold">{escrowFee(preview.minBidMeat).toLocaleString('en-US')} Meat</dd></div>}
                    </dl>
                    {preview.auctionKind === 'buy' && <p className="text-xs text-gray-500">The reserve rounds up to whole Meat. Actual fees are rounded down per fulfillment; unused reserve is refunded.</p>}
                    <div className="mt-4 grid grid-cols-2 gap-3 border-t border-gray-100 pt-4">
                        <button type="button" onClick={() => { setPreview(null); setError(''); }} disabled={pending} className="min-h-12 rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 disabled:opacity-50">Back to Edit</button>
                        <button type="button" aria-haspopup="dialog" aria-controls="publish-auction-dialog" onClick={() => { setError(''); publishDialog.current.showModal(); }} disabled={pending} className="button-green min-h-12 rounded-lg border border-green-700 bg-green-700 px-3 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50">{pending ? 'Saving…' : 'Continue to Publish'}</button>
                    </div>
                    <dialog ref={publishDialog} id="publish-auction-dialog" aria-labelledby="publish-auction-title" aria-describedby="publish-auction-description"
                        onCancel={event => { if (submitting.current) event.preventDefault(); }}
                        className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border-0 bg-white p-6 text-gray-800 shadow-xl backdrop:bg-black/40">
                        <h2 id="publish-auction-title" className="text-xl font-bold">Please review the following before publishing your auction.</h2>
                        <div id="publish-auction-description" className="mt-4 space-y-4 text-sm leading-6">
                            {preview.auctionKind === 'buy' ? <p>Deposit the required Meat within 24 hours. Your timer starts when funding is accepted. You may cancel the unfilled portion at any time; completed purchases and their fees are final. Unused funds and fee reserve are refunded.</p> : <><p>You may cancel your auction at any time without penalty, provided no bids have been accepted.</p>
                            <p>Once an accepted bid meets or exceeds your minimum bid, <strong>you are obligated to honor the sale</strong> and can no longer cancel or withdraw from the auction.</p>
                            <p className="text-red-600">Failure to honor a completed auction is a violation of kHub policy and will result in a temporary or permanent ban. Don’t auction items you don’t own or aren’t prepared to part with.</p></>}
                        </div>
                        {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
                        <div className="mt-6 flex flex-wrap justify-end gap-3">
                            <button type="button" disabled={pending} onClick={() => publishDialog.current.close()} className="min-h-11 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 disabled:opacity-50">Cancel</button>
                            <button type="button" disabled={pending} onClick={confirm} className="button-green min-h-11 rounded-lg border border-green-700 bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending ? 'Publishing…' : 'Publish Auction'}</button>
                        </div>
                    </dialog>
                </section> : <form onSubmit={showPreview}>
                    <fieldset className="mb-3 min-w-0">
                        <legend className="mb-2 text-sm font-bold">Trading Method</legend>
                        <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
                            {[[true, 'Escrow'], [false, 'Direct']].map(([value, label]) => <button
                                key={label} type="button" disabled={isBuy && !value} aria-pressed={escrowMode === value}
                                onClick={() => { setEscrowMode(value); setError(''); }}
                                className={`min-h-11 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1 ${escrowMode === value
                                    ? 'border-blue-200 bg-white text-blue-800 shadow-sm hover:border-blue-300 hover:bg-blue-50'
                                    : 'border-transparent bg-transparent text-slate-500 hover:border-transparent hover:bg-white/70 hover:text-slate-800'}`}>
                                {label}
                            </button>)}
                        </div>
                        {isBuy && <p className="mt-2 text-xs text-gray-600">For now, creating a Buy auction is limited to Escrow</p>}
                    </fieldset>
                    <div className="mb-5">
                        {escrowMode ? <EscrowProtection forListing buy={isBuy} minimumPrice={minimumValue} /> : <DirectTradeHelp forListing />}
                        {escrowMode && !isBuy && <p className="my-4 rounded-[6px] border-l-[3px] border-[#22C55E] bg-[#F0FDF4] px-4 py-3 text-xs leading-[1.4] text-[#334155]"><strong className="font-bold text-[#15803D]">Early Access:</strong> In the unlikely event of a verified loss caused by our escrow system, we guarantee reimbursement of the actual loss, up to 1,000,000 Meat per affected user.</p>}
                        {!escrowMode && <p className="mt-2 text-xs leading-[1.4] text-red-600">Failure to honor a valid, completed auction is a violation of kHub policy and will likely get you banned. We take these very seriously.</p>}
                    </div>
                    <label htmlFor="listing-item-search" className="mb-2 block text-sm font-bold">Find an item</label>
                    <input id="listing-item-search" type="search" value={itemSearch} onChange={(event) => setItemSearch(event.target.value)} placeholder="Start typing an item name…" aria-describedby="listing-search-help" className={fieldClass} />
                    {(hasItemSearch || selectedItem) && <>
                    <label htmlFor="item" className="mb-2 block text-sm font-bold">Select an Item:</label>
                    <select id="item" required value={selectedItem} onChange={(event) => setSelectedItem(event.target.value)} aria-describedby="listing-search-help" className={fieldClass}>
                        <option value="" disabled>Select an item</option>
                        {selectedItem && !searchResults.some(item => String(item.id) === selectedItem)
                            && catalogItems.some(item => String(item.id) === selectedItem && isAuctionableItem(item))
                            && <option value={selectedItem}>{catalogItems.find(item => String(item.id) === selectedItem).name}</option>}
                        {searchResults.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                    </>}
                    <p id="listing-search-help" className="mb-4 text-sm text-gray-600">{!hasItemSearch ? 'Start typing an item name…' : itemSearch !== deferredSearch ? 'Searching items…' : matchingItems.length > resultLimit ? `Showing the first ${resultLimit} of ${matchingItems.length.toLocaleString('en-US')} matches. Keep typing to narrow the list.` : `${matchingItems.length} matching items.`}</p>
                    {hasItemSearch && itemSearch === deferredSearch && searchResults.length === 0 && <p role="status" className="mb-4 text-sm text-gray-600">No items match your search.{selectedItem ? ' Your previous selection is still selected.' : ''}</p>}
                    <label htmlFor="quantity" className="mb-2 block text-sm font-bold">Quantity:</label>
                    <div className="mb-4 flex gap-2">
                        <input id="quantity" type="text" inputMode="decimal" required autoComplete="off" value={quantity}
                            role="spinbutton" aria-valuemin={1} aria-valuemax={5000000000} aria-valuenow={quantityValue ?? undefined}
                            onChange={(event) => setQuantity(event.target.value)}
                            onBlur={() => setQuantity(value => normalizeAuctionAmount(value))}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                    event.preventDefault();
                                    stepQuantity(event.key === 'ArrowUp' ? 1 : -1);
                                }
                            }}
                            className="block min-h-11 w-full min-w-0 rounded border border-gray-400 bg-white p-3 text-base text-gray-900" />
                        <button type="button" aria-label="Increase quantity" title="Increase quantity by 1"
                            disabled={quantityValue === 5000000000 || (quantityValue === null && quantity.trim() !== '')}
                            onClick={() => stepQuantity(1)} className="min-h-11 min-w-11 shrink-0 rounded border border-gray-400 bg-white px-3 text-gray-900 disabled:opacity-40">▲</button>
                        <button type="button" aria-label="Decrease quantity" title="Decrease quantity by 1"
                            disabled={quantityValue === null || quantityValue <= 1}
                            onClick={() => stepQuantity(-1)} className="min-h-11 min-w-11 shrink-0 rounded border border-gray-400 bg-white px-3 text-gray-900 disabled:opacity-40">▼</button>
                    </div>
                    <label htmlFor="minBidMeat" className="mb-2 block text-sm font-bold">{isBuy ? 'Maximum purchase price per item (Meat):' : 'Minimum Bid (Meat, whole listing):'}</label>
                    <input id="minBidMeat" type="text" inputMode="decimal" required autoComplete="off" value={minBidMeat} onChange={(event) => setMinBidMeat(event.target.value)} onBlur={() => setMinBidMeat(value => normalizeAuctionAmount(value, { meat: true }))} placeholder="e.g. 1000, 10b, 4.53m, 50k" className={fieldClass} />
                    {!isBuy && (showBuyout ? <section id="buyout-price-fields" className="mb-4">
                        <label htmlFor="instantPurchasePrice" className="mb-2 block text-sm font-bold">Buyout Price (Meat, whole listing, optional):</label>
                        <input ref={buyoutInput} id="instantPurchasePrice" type="text" inputMode="decimal" autoComplete="off" value={instantPrice}
                            onChange={(event) => setInstantPrice(event.target.value)}
                            onBlur={() => setInstantPrice(value => normalizeAuctionAmount(value, { meat: true }))}
                            placeholder="e.g. 1000, 10b, 4.53m, 50k" aria-describedby="instant-price-help" className={fieldClass} />
                        <p id="instant-price-help" className="mb-2 text-sm text-gray-600">The total price you will accept to end bidding early for this entire listing. A bid reaching this price also ends bidding at this amount.</p>
                        <button type="button" onClick={() => { setInstantPrice(''); setShowBuyout(false); }} className="min-h-11 bg-transparent px-0 text-sm text-blue-700 underline">Remove buyout price</button>
                    </section> : <button type="button" aria-expanded={false} onClick={() => {
                        setShowBuyout(true);
                        requestAnimationFrame(() => buyoutInput.current?.focus());
                    }} className="mb-4 min-h-11 w-full rounded border border-blue-600 bg-white px-4 py-3 font-semibold text-blue-700 transition-colors hover:border-blue-700 hover:bg-blue-100 hover:text-blue-800">Set Buyout Price (optional)</button>)}
                    {isBuy && <><label htmlFor="deliveryMode" className="mb-2 block text-sm font-bold">Item delivery:</label>
                        <select id="deliveryMode" value={deliveryMode} onChange={event => setDeliveryMode(event.target.value)} className={fieldClass}><option value="immediate">Immediate Delivery — as acquired</option><option value="finished">Delivery When Finished — when the order ends</option></select>
                        <div className="mb-4 space-y-3 text-xs text-gray-600">
                            <p>You must deposit the total purchase price plus a commission reserve before your auction begins. Fees apply only to completed purchases.</p>
                            <p>You may cancel the unfilled portion of your order at any time without penalty. Unspent Meat, including unused commission reserves, is refunded when your auction ends or is canceled.</p>
                            <details>
                                <summary className="w-fit cursor-pointer font-medium">A Note for Hardcore/Ronin Players</summary>
                                <p className="mt-2">Gift packaging for Hardcore/Ronin players is covered by kHub. Immediate deliveries are combined until at least 1,000 items below 50 Meat each, 100 items at 50–999 Meat, or 10 items at 1,000–49,999 Meat have accumulated. Items priced at 50,000 Meat or more are sent immediately. Each delivery includes all accumulated items, and any remainder is delivered when your order ends.</p>
                            </details>
                        </div></>}
                    <label htmlFor="auctionTime" className="mb-2 block text-sm font-bold">Auction Duration:</label>
                    <div className="mb-4 flex min-w-0 gap-2">
                        <select id="auctionTime" value={auctionTime} disabled={customDuration} onChange={(event) => setAuctionTime(event.target.value)} className="block min-h-11 w-full min-w-0 flex-1 rounded border border-gray-400 bg-white p-3 text-base text-gray-900 disabled:bg-gray-100 disabled:text-gray-500">
                            <option value="6">6 Hours</option><option value="12">12 Hours</option>
                            <option value="24">1 Day</option><option value="72">3 Days</option>
                            <option value="168">7 Days</option><option value="336">14 Days</option>
                            <option value="720">1 Month</option>
                        </select>
                        {!isBuy && <button type="button" aria-pressed={customDuration} aria-expanded={customDuration} aria-controls="custom-auction-end-fields" onClick={() => {
                            if (!customDuration) {
                                if (!customEndTime) setCustomEndTime(localDateTimeInput(auctionNow() + Number(auctionTime) * 3600000));
                                requestAnimationFrame(() => endingTimeInput.current?.focus());
                            }
                            setCustomDuration(value => !value);
                            setError('');
                        }} className={`min-h-11 shrink-0 rounded border px-4 py-3 text-sm font-semibold transition-colors ${customDuration ? 'border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100' : 'border-gray-400 bg-white text-gray-700 hover:bg-gray-50'}`}>Custom</button>}
                    </div>
                    {customDuration && <section id="custom-auction-end-fields" className="mb-4 min-w-0">
                        <label htmlFor="customEndTime" className="mb-2 block text-sm font-bold">Ending date and time:</label>
                        <input ref={endingTimeInput} id="customEndTime" type="datetime-local" required step="60" value={customEndTime}
                            min={localDateTimeInput(auctionNow() + 60000)} max={localDateTimeInput(auctionNow() + MAX_AUCTION_DURATION_MS)}
                            onChange={event => setCustomEndTime(event.target.value)} aria-describedby="custom-ending-help"
                            className="block min-h-11 w-full min-w-0 max-w-full rounded border border-gray-400 bg-white p-3 text-base text-gray-900" />
                        <p id="custom-ending-help" className="mt-2 text-xs text-gray-500">Your timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Choose a time within 30 days.{escrowMode && ' Deposit your items before the chosen ending time.'}</p>
                    </section>}
                    {!isBuy && <p className="-mt-2 mb-4 text-xs text-gray-500">Last-minute bids reset the countdown to 1 minute.</p>}
                    <button type="submit" className="min-h-11 w-full rounded bg-blue-600 px-4 py-3 font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">Preview Auction</button>
                </form>}
            </div>
        </main>
    );
}
