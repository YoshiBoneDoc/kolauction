import { useState, useContext, useDeferredValue, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import items from '../data/items.json';
import { parseAuctionAmount } from '../lib/auctionInputs';
import useKolIdentity from '../hooks/useKolIdentity';

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
    const [auctionTime, setAuctionTime] = useState('24');
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const previewHeading = useRef(null);
    const deferredSearch = useDeferredValue(itemSearch);
    const matchingItems = useMemo(() => {
        const query = deferredSearch.trim().toLocaleLowerCase();
        return sortedItems.filter((item) => item.searchName.includes(query));
    }, [deferredSearch]);
    const searchResults = matchingItems.slice(0, resultLimit);

    function showPreview(event) {
        event.preventDefault();
        const item = items.find((entry) => entry.name === selectedItem);
        const count = parseAuctionAmount(quantity, 5000000000);
        const minimum = parseAuctionAmount(minBidMeat, 10000000000);
        const purchasePrice = instantPrice.trim() ? parseAuctionAmount(instantPrice, 20000000000) : null;
        if (!item) { setError('Please select an item to auction.'); return; }
        if (count === null) { setError('Quantity must be a whole number between 1 and 5 billion.'); return; }
        if (minimum === null) { setError('Minimum bid must be a whole number between 1 and 10 billion Meat.'); return; }
        if (instantPrice.trim() && (purchasePrice === null || purchasePrice < minimum)) {
            setError('Instant purchase price must meet the minimum bid and be at most 20 billion Meat.'); return;
        }
        const gifName = item.image?.split('/').pop();
        setPreview({ item: item.name, itemId: item.id, quantity: count, minBidMeat: minimum, instantPurchasePrice: purchasePrice, auctionTime,
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
            <p className="mx-auto mb-4 max-w-lg text-sm text-gray-700">{kolIdentity && !kolIdentity.kol_player_id && <>First <Link to="/profile" className="text-blue-700 underline">link your KoL account</Link>. </>}Your listing activates only after kHub (#3888760) receives the exact items by KMail. Deposit instructions appear after saving.</p>
            <p className="mx-auto mb-4 max-w-lg text-sm text-gray-700">Successful sales have a 7.5% seller fee, rounded down to whole Meat and deducted from your payment. No fee is charged if there are no accepted bids.</p>
            <div className="mx-auto max-w-lg rounded-lg bg-white p-4 shadow-md sm:p-8">
                {error && <p role="alert" className="mb-4 break-words font-semibold text-red-700">{error}</p>}
                {preview ? <section aria-label="Preview auction">
                    <h2 ref={previewHeading} tabIndex={-1} className="mb-4 text-center text-2xl font-bold">Preview Auction</h2>
                    <div className="space-y-3 break-words text-center">
                        {preview.image && <img src={preview.image} alt={preview.item} className="mx-auto h-32 w-32 object-contain" />}
                        <p className="font-bold">{preview.item}</p>
                        <p>Quantity: {preview.quantity.toLocaleString('en-US')}</p>
                        <p>Minimum bid: {preview.minBidMeat.toLocaleString('en-US')} Meat</p>
                        <p>Instant purchase: {preview.instantPurchasePrice ? `${preview.instantPurchasePrice.toLocaleString('en-US')} Meat for the entire listing` : 'Not offered'}</p>
                        <p>Duration: {preview.auctionTime} hours</p>
                    </div>
                    <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                        <button onClick={confirm} disabled={pending} className="min-h-11 flex-1 rounded bg-green-700 px-4 py-3 font-bold text-white disabled:opacity-50">{pending ? 'Saving…' : 'Confirm Auction'}</button>
                        <button onClick={() => { setPreview(null); setError(''); }} disabled={pending} className="min-h-11 flex-1 rounded border border-gray-400 bg-white px-4 py-3 text-gray-800 disabled:opacity-50">Back to edit</button>
                    </div>
                </section> : <form onSubmit={showPreview}>
                    <label htmlFor="listing-item-search" className="mb-2 block text-sm font-bold">Find an item</label>
                    <input id="listing-item-search" type="search" value={itemSearch} onChange={(event) => setItemSearch(event.target.value)} placeholder="Search item names…" className={fieldClass} />
                    <label htmlFor="item" className="mb-2 block text-sm font-bold">Select an Item:</label>
                    <select id="item" required value={selectedItem} onChange={(event) => setSelectedItem(event.target.value)} aria-describedby="listing-search-help" className={fieldClass}>
                        <option value="" disabled>Select an item</option>
                        {selectedItem && !searchResults.some((item) => item.name === selectedItem) && <option value={selectedItem}>{selectedItem}</option>}
                        {searchResults.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                    </select>
                    <p id="listing-search-help" className="mb-4 text-sm text-gray-600">{matchingItems.length > resultLimit ? `Showing the first ${resultLimit} of ${matchingItems.length.toLocaleString('en-US')} matches. Keep typing to narrow the list.` : `${matchingItems.length} matching items.`}</p>
                    {searchResults.length === 0 && <p role="status" className="mb-4 text-sm text-gray-600">No items match your search.{selectedItem ? ' Your previous selection is still selected.' : ''}</p>}
                    <label htmlFor="quantity" className="mb-2 block text-sm font-bold">Quantity:</label>
                    <input id="quantity" type="text" inputMode="numeric" required autoComplete="off" value={quantity} onChange={(event) => setQuantity(event.target.value)} aria-describedby="listing-amount-help" className={fieldClass} />
                    <label htmlFor="minBidMeat" className="mb-2 block text-sm font-bold">Minimum Bid (Meat):</label>
                    <input id="minBidMeat" type="text" inputMode="numeric" required autoComplete="off" value={minBidMeat} onChange={(event) => setMinBidMeat(event.target.value)} placeholder="e.g. 1000" aria-describedby="listing-amount-help" className={fieldClass} />
                    <p id="listing-amount-help" className="mb-4 text-sm text-gray-600">Use whole numbers or k/m/b shorthand, for example 1k for 1,000. Maximum quantity: 5 billion; minimum bid: up to 10 billion Meat.</p>
                    <label htmlFor="instantPurchasePrice" className="mb-2 block text-sm font-bold">Instant Purchase Price (Meat, optional):</label>
                    <input id="instantPurchasePrice" type="text" inputMode="numeric" autoComplete="off" value={instantPrice} onChange={(event) => setInstantPrice(event.target.value)} placeholder="Leave blank for normal bidding" aria-describedby="instant-price-help" className={fieldClass} />
                    <p id="instant-price-help" className="mb-4 text-sm text-gray-600">The total price you will accept to end bidding early for this entire listing. It must meet your minimum bid and be at most 20 billion Meat. A bid reaching this price also ends bidding at this amount.</p>
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
