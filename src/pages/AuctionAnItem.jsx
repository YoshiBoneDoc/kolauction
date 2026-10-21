import { useState, useContext, useDeferredValue, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import items from '../data/items.json';
import { supabase } from '../lib/supabase';
import { createItemCatalogService, itemImageUrl } from '../lib/itemCatalog';
import { parseAuctionAmount, parseMeatAmount, normalizeAuctionAmount } from '../lib/auctionInputs';
import useKolIdentity from '../hooks/useKolIdentity';
import EscrowProtection from '../components/EscrowProtection';
import DirectTradeHelp from '../components/DirectTradeHelp';
import { ESCROW_MIN_BID_LIMIT, ESCROW_MIN_BID_ERROR } from '../lib/escrowPolicy';

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
    const sortedItems = useMemo(() => catalogItems.filter(item => item.tradeable === true)
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
    const [escrowMode, setEscrowMode] = useState(true);
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
    const escrowLimitExceeded = escrowMode && minimumValue !== null && minimumValue > ESCROW_MIN_BID_LIMIT;

    function stepQuantity(change) {
        setQuantity((value) => {
            const count = value.trim() ? parseAuctionAmount(value, 5000000000) : 0;
            if (count === null) return value;
            return String(Math.min(5000000000, Math.max(1, count + change)));
        });
    }

    function showPreview(event) {
        event.preventDefault();
        const item = catalogItems.find(entry => String(entry.id) === selectedItem && entry.tradeable === true);
        const count = parseAuctionAmount(quantity, 5000000000);
        const minimum = parseMeatAmount(minBidMeat);
        const purchasePrice = instantPrice.trim() ? parseMeatAmount(instantPrice) : null;
        if (!item) { setError('Please select an item to auction.'); return; }
        if (count === null) { setError('Quantity must be a whole number between 1 and 5 billion.'); return; }
        if (minimum === null) { setError('Enter a valid positive minimum bid in Meat.'); return; }
        if (escrowMode && minimum > ESCROW_MIN_BID_LIMIT) { setError(ESCROW_MIN_BID_ERROR); return; }
        if (instantPrice.trim() && (purchasePrice === null || purchasePrice < minimum)) {
            setError('Buyout price must be a valid Meat amount at least as large as the minimum bid.'); return;
        }
        setPreview({ item: item.name, itemId: item.id, quantity: count, minBidMeat: minimum, instantPurchasePrice: purchasePrice, auctionTime, escrowMode,
            image: itemImageUrl(item.image) });
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
        <main className="min-h-screen bg-gray-50 p-4">
            <Link to="/" className="inline-flex min-h-11 items-center text-blue-700 underline">Home</Link>
            <div className="mx-auto mt-12 max-w-lg space-y-4 text-center">
                <h1 className="text-2xl font-bold text-red-700">You must be logged in to auction an item.</h1>
                <Link to="/login" className="inline-flex min-h-11 items-center text-lg text-blue-700 underline">Log In</Link>
                <p>Don’t have an account? <Link to="/register" className="text-blue-700 underline">Register</Link></p>
            </div>
        </main>
    );

    return (
        <main className="min-h-screen bg-gray-50 p-4 sm:p-6">
            <Link to="/" className="mb-4 inline-flex min-h-11 items-center text-sm text-blue-700 underline">Home</Link>
            <h1 className="mb-6 text-center text-3xl font-bold text-blue-600 sm:text-4xl">Auction an Item</h1>
            {!preview && <p className="mx-auto mb-4 max-w-lg text-sm text-gray-700">{kolIdentity && !kolIdentity.kol_player_id && <>First <Link to="/profile" className="text-blue-700 underline">link your KoL account</Link>. </>}Choose how your sale will settle. The mode stays fixed after publishing.</p>}
            <div className="mx-auto max-w-lg rounded-lg bg-white p-4 shadow-md sm:p-8">
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
                            <dd className="text-right"><span className={`inline-flex rounded border px-2 py-0.5 text-xs font-medium ${preview.escrowMode ? 'border-blue-200 bg-blue-50 text-blue-800' : 'border-slate-200 bg-slate-100 text-slate-700'}`}>{preview.escrowMode ? 'Escrow' : 'Direct'}</span></dd>
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">Minimum bid</dt>
                            <dd className="min-w-0 break-words text-right font-medium tabular-nums text-gray-900">{preview.minBidMeat.toLocaleString('en-US')} Meat</dd>
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">Buyout price</dt>
                            <dd className="min-w-0 break-words text-right font-medium tabular-nums text-gray-900">{preview.instantPurchasePrice ? `${preview.instantPurchasePrice.toLocaleString('en-US')} Meat` : 'Not offered'}</dd>
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">Duration</dt>
                            <dd className="min-w-0 break-words text-right font-medium tabular-nums text-gray-900">{preview.auctionTime} hours</dd>
                        </div>
                    </dl>
                    <div className="mt-4 grid grid-cols-2 gap-3 border-t border-gray-100 pt-4">
                        <button type="button" onClick={() => { setPreview(null); setError(''); }} disabled={pending} className="min-h-12 rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 disabled:opacity-50">Back to Edit</button>
                        <button type="button" aria-haspopup="dialog" aria-controls="publish-auction-dialog" onClick={() => { setError(''); publishDialog.current.showModal(); }} disabled={pending} className="button-green min-h-12 rounded-lg border border-green-700 bg-green-700 px-3 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50">{pending ? 'Saving…' : 'Continue to Publish'}</button>
                    </div>
                    <dialog ref={publishDialog} id="publish-auction-dialog" aria-labelledby="publish-auction-title" aria-describedby="publish-auction-description"
                        onCancel={event => { if (submitting.current) event.preventDefault(); }}
                        className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border-0 bg-white p-6 text-gray-800 shadow-xl backdrop:bg-black/40">
                        <h2 id="publish-auction-title" className="text-xl font-bold">Please review the following before publishing your auction.</h2>
                        <div id="publish-auction-description" className="mt-4 space-y-4 text-sm leading-6">
                            <p>You may cancel your auction at any time without penalty, provided no bids have been accepted.</p>
                            <p>Once an accepted bid meets or exceeds your minimum bid, <strong>you are obligated to honor the sale</strong> and can no longer cancel or withdraw from the auction.</p>
                            <p className="text-red-600">Failure to honor a completed auction is a violation of kHub policy and will result in a temporary or permanent ban. Don’t auction items you don’t own or aren’t prepared to part with.</p>
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
                                key={label} type="button" aria-pressed={escrowMode === value}
                                onClick={() => { setEscrowMode(value); setError(''); }}
                                className={`min-h-11 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1 ${escrowMode === value
                                    ? 'border-blue-200 bg-white text-blue-800 shadow-sm hover:border-blue-300 hover:bg-blue-50'
                                    : 'border-transparent bg-transparent text-slate-500 hover:border-transparent hover:bg-white/70 hover:text-slate-800'}`}>
                                {label}
                            </button>)}
                        </div>
                    </fieldset>
                    <div className="mb-5">
                        {escrowMode ? <EscrowProtection forListing /> : <DirectTradeHelp forListing />}
                        {escrowMode && <p className="my-4 rounded-[6px] border-l-[3px] border-[#22C55E] bg-[#F0FDF4] px-4 py-3 text-xs leading-[1.4] text-[#334155]"><strong className="font-bold text-[#15803D]">Early Access:</strong> While kHub is in its early stages, escrow is available only for auctions with a minimum bid of 1,000,000 Meat or less. In the unlikely event of a verified loss caused by our escrow system, we guarantee reimbursement of the actual loss, up to 1,000,000 Meat per affected user.</p>}
                        {!escrowMode && <p className="mt-2 text-xs leading-[1.4] text-red-600">Failure to honor a valid, completed auction is a violation of kHub policy and will likely get you banned. We take these very seriously.</p>}
                    </div>
                    <label htmlFor="listing-item-search" className="mb-2 block text-sm font-bold">Find an item</label>
                    <input id="listing-item-search" type="search" value={itemSearch} onChange={(event) => setItemSearch(event.target.value)} placeholder="Start typing an item name…" aria-describedby="listing-search-help" className={fieldClass} />
                    {(hasItemSearch || selectedItem) && <>
                    <label htmlFor="item" className="mb-2 block text-sm font-bold">Select an Item:</label>
                    <select id="item" required value={selectedItem} onChange={(event) => setSelectedItem(event.target.value)} aria-describedby="listing-search-help" className={fieldClass}>
                        <option value="" disabled>Select an item</option>
                        {selectedItem && !searchResults.some(item => String(item.id) === selectedItem)
                            && catalogItems.some(item => String(item.id) === selectedItem && item.tradeable === true)
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
                    <label htmlFor="minBidMeat" className="mb-2 block text-sm font-bold">Minimum Bid (Meat):</label>
                    <input id="minBidMeat" aria-invalid={escrowLimitExceeded} aria-describedby={escrowLimitExceeded ? 'escrow-minimum-error' : undefined} type="text" inputMode="decimal" required autoComplete="off" value={minBidMeat} onChange={(event) => setMinBidMeat(event.target.value)} onBlur={() => setMinBidMeat(value => normalizeAuctionAmount(value, { meat: true }))} placeholder="e.g. 1000, 10b, 4.53m, 50k" className={fieldClass} />
                    {escrowLimitExceeded && <p id="escrow-minimum-error" role="alert" className="mb-4 text-sm text-red-700">{ESCROW_MIN_BID_ERROR}</p>}
                    {showBuyout ? <section id="buyout-price-fields" className="mb-4">
                        <label htmlFor="instantPurchasePrice" className="mb-2 block text-sm font-bold">Buyout Price (Meat, optional):</label>
                        <input ref={buyoutInput} id="instantPurchasePrice" type="text" inputMode="decimal" autoComplete="off" value={instantPrice}
                            onChange={(event) => setInstantPrice(event.target.value)}
                            onBlur={() => setInstantPrice(value => normalizeAuctionAmount(value, { meat: true }))}
                            placeholder="e.g. 1000, 10b, 4.53m, 50k" aria-describedby="instant-price-help" className={fieldClass} />
                        <p id="instant-price-help" className="mb-2 text-sm text-gray-600">The total price you will accept to end bidding early for this entire listing. A bid reaching this price also ends bidding at this amount.</p>
                        <button type="button" onClick={() => { setInstantPrice(''); setShowBuyout(false); }} className="min-h-11 bg-transparent px-0 text-sm text-blue-700 underline">Remove buyout price</button>
                    </section> : <button type="button" aria-expanded={false} onClick={() => {
                        setShowBuyout(true);
                        requestAnimationFrame(() => buyoutInput.current?.focus());
                    }} className="mb-4 min-h-11 w-full rounded border border-blue-600 bg-white px-4 py-3 font-semibold text-blue-700 transition-colors hover:border-blue-700 hover:bg-blue-100 hover:text-blue-800">Set Buyout Price (optional)</button>}
                    <label htmlFor="auctionTime" className="mb-2 block text-sm font-bold">Auction Duration:</label>
                    <select id="auctionTime" value={auctionTime} onChange={(event) => setAuctionTime(event.target.value)} className={fieldClass}>
                        <option value="6">6 Hours</option><option value="12">12 Hours</option>
                        <option value="24">1 Day</option><option value="72">3 Days</option>
                        <option value="168">7 Days</option><option value="720">1 Month</option>
                    </select>
                    <button type="submit" disabled={escrowLimitExceeded} className="min-h-11 w-full rounded bg-blue-600 px-4 py-3 font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">Preview Auction</button>
                </form>}
            </div>
        </main>
    );
}
