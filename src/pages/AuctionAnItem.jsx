import { useState, useContext, useDeferredValue, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import items from '../data/items.json';
import { parseAuctionAmount, parseMeatAmount, normalizeAuctionAmount } from '../lib/auctionInputs';
import useKolIdentity from '../hooks/useKolIdentity';
import SettlementTerms from '../components/SettlementTerms';

const sortedItems = items.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => ({ ...item, searchName: item.name.toLocaleLowerCase() }));
const resultLimit = 100;
const fieldClass = 'mb-4 block min-h-11 w-full min-w-0 rounded border border-gray-400 bg-white p-3 text-base text-gray-900';

export default function AuctionAnItem() {
    const { addAuction } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);
    const kolIdentity = useKolIdentity();
    const navigate = useNavigate();
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
    const deferredSearch = useDeferredValue(itemSearch);
    const hasItemSearch = Boolean(itemSearch.trim());
    const matchingItems = useMemo(() => {
        const query = deferredSearch.trim().toLocaleLowerCase();
        if (!query) return [];
        return sortedItems.filter((item) => item.searchName.includes(query));
    }, [deferredSearch]);
    const searchResults = matchingItems.slice(0, resultLimit);
    const quantityValue = parseAuctionAmount(quantity, 5000000000);

    function stepQuantity(change) {
        setQuantity((value) => {
            const count = value.trim() ? parseAuctionAmount(value, 5000000000) : 0;
            if (count === null) return value;
            return String(Math.min(5000000000, Math.max(1, count + change)));
        });
    }

    function showPreview(event) {
        event.preventDefault();
        const item = items.find((entry) => entry.name === selectedItem);
        const count = parseAuctionAmount(quantity, 5000000000);
        const minimum = parseMeatAmount(minBidMeat);
        const purchasePrice = instantPrice.trim() ? parseMeatAmount(instantPrice) : null;
        if (!item) { setError('Please select an item to auction.'); return; }
        if (count === null) { setError('Quantity must be a whole number between 1 and 5 billion.'); return; }
        if (minimum === null) { setError('Enter a valid positive minimum bid in Meat.'); return; }
        if (instantPrice.trim() && (purchasePrice === null || purchasePrice < minimum)) {
            setError('Buyout price must be a valid Meat amount at least as large as the minimum bid.'); return;
        }
        const gifName = item.image?.split('/').pop();
        setPreview({ item: item.name, itemId: item.id, quantity: count, minBidMeat: minimum, instantPurchasePrice: purchasePrice, auctionTime, escrowMode,
            image: gifName ? `https://images.kingdomofloathing.com/itemimages/${gifName}` : '' });
        setError('');
        requestAnimationFrame(() => previewHeading.current?.focus());
    }

    async function confirm() {
        if (pending || !preview) return;
        setPending(true);
        setError('');
        try {
            const id = await addAuction(preview);
            navigate(id ? `/auction/${id}` : '/auctions');
        } catch (failure) {
            setError(failure.message);
        } finally {
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
                    <h2 ref={previewHeading} tabIndex={-1} className="mb-4 text-center text-2xl font-bold">Preview Auction</h2>
                    <div className="space-y-3 break-words text-center">
                        {preview.image && <img src={preview.image} alt={preview.item} className="mx-auto h-32 w-32 object-contain" />}
                        <p className="font-bold">{preview.item}</p>
                        <p className="font-semibold">{preview.escrowMode ? 'Escrow' : 'Direct settlement (no escrow)'}</p>
                        <SettlementTerms escrowMode={preview.escrowMode} linkTips={false} />
                        <p>{preview.escrowMode ? 'Deposit instructions appear after saving. Bidding starts after the exact items arrive.' : 'Publishing starts bidding and the timer immediately.'}</p>
                        <p>Quantity: {preview.quantity.toLocaleString('en-US')}</p>
                        <p>Minimum bid: {preview.minBidMeat.toLocaleString('en-US')} Meat</p>
                        <p>Buyout Price: {preview.instantPurchasePrice ? `${preview.instantPurchasePrice.toLocaleString('en-US')} Meat for the entire listing` : 'Not offered'}</p>
                        <p>Duration: {preview.auctionTime} hours</p>
                    </div>
                    <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                        <button onClick={confirm} disabled={pending} className="min-h-11 flex-1 rounded bg-green-700 px-4 py-3 font-bold text-white disabled:opacity-50">{pending ? 'Saving…' : 'Confirm Auction'}</button>
                        <button onClick={() => { setPreview(null); setError(''); }} disabled={pending} className="min-h-11 flex-1 rounded border border-gray-400 bg-white px-4 py-3 text-gray-800 disabled:opacity-50">Back to edit</button>
                    </div>
                </section> : <form onSubmit={showPreview}>
                    <label htmlFor="settlement-mode" className="mb-2 block text-sm font-bold">Settlement mode</label>
                    <select id="settlement-mode" value={escrowMode ? 'escrow' : 'direct'} onChange={(event) => setEscrowMode(event.target.value === 'escrow')} className={fieldClass}>
                        <option value="escrow">Escrow — kHub holds the items and bid Meat</option>
                        <option value="direct">Direct settlement (no escrow) — trade with the buyer</option>
                    </select>
                    <div className="mb-5 text-sm text-gray-700"><SettlementTerms escrowMode={escrowMode} /></div>
                    <label htmlFor="listing-item-search" className="mb-2 block text-sm font-bold">Find an item</label>
                    <input id="listing-item-search" type="search" value={itemSearch} onChange={(event) => setItemSearch(event.target.value)} placeholder="Start typing an item name…" aria-describedby="listing-search-help" className={fieldClass} />
                    {(hasItemSearch || selectedItem) && <>
                    <label htmlFor="item" className="mb-2 block text-sm font-bold">Select an Item:</label>
                    <select id="item" required value={selectedItem} onChange={(event) => setSelectedItem(event.target.value)} aria-describedby="listing-search-help" className={fieldClass}>
                        <option value="" disabled>Select an item</option>
                        {selectedItem && !searchResults.some((item) => item.name === selectedItem) && <option value={selectedItem}>{selectedItem}</option>}
                        {searchResults.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
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
                    <input id="minBidMeat" type="text" inputMode="decimal" required autoComplete="off" value={minBidMeat} onChange={(event) => setMinBidMeat(event.target.value)} onBlur={() => setMinBidMeat(value => normalizeAuctionAmount(value, { meat: true }))} placeholder="e.g. 1000, 10b, 4.53m, 50k" className={fieldClass} />
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
                    }} className="mb-4 min-h-11 w-full rounded border border-blue-600 bg-white px-4 py-3 font-semibold text-blue-700">Set Buyout Price (optional)</button>}
                    <label htmlFor="auctionTime" className="mb-2 block text-sm font-bold">Auction Duration:</label>
                    <select id="auctionTime" value={auctionTime} onChange={(event) => setAuctionTime(event.target.value)} className={fieldClass}>
                        <option value="6">6 Hours</option><option value="12">12 Hours</option>
                        <option value="24">1 Day</option><option value="72">3 Days</option>
                        <option value="168">7 Days</option><option value="720">1 Month</option>
                    </select>
                    <button type="submit" className="min-h-11 w-full rounded bg-blue-600 px-4 py-3 font-bold text-white hover:bg-blue-700">Preview Auction</button>
                </form>}
            </div>
        </main>
    );
}
