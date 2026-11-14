import MarketPrice from './MarketPrice';
import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { supabase } from '../lib/supabase';
import { createItemCatalogService, isAuctionableItem, itemImageUrl } from '../lib/itemCatalog';
import { parseAuctionAmount, parseMeatAmount, normalizeAuctionAmount } from '../lib/auctionInputs';
import { marketPrices } from '../lib/marketPriceService';
import { offerValue, writeBarter } from '../lib/barter';

const catalog = createItemCatalogService(supabase, () => import('../data/items.json').then(module => module.default));
const field = 'min-h-10 w-full min-w-0 rounded border border-gray-400 bg-white px-3 py-2 text-sm text-gray-900';
export default function BarterOfferForm({ auction, onSubmitted, initialOffer }) {
    const [catalogItems, setCatalogItems] = useState([]);
    const [search, setSearch] = useState('');
    const [selected, setSelected] = useState('');
    const selectedItem = catalogItems.find(item => String(item.id) === selected);
    const [quantity, setQuantity] = useState('1');
    const [meat, setMeat] = useState(() => initialOffer?.meat ? initialOffer.meat.toLocaleString('en-US') : '');
    const [items, setItems] = useState(() => (initialOffer?.items || []).map(item => ({ id: item.id, name: item.name, quantity: item.quantity })));
    const [prices, setPrices] = useState(new Map());
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const lock = useRef(false);
    const token = useRef(null);
    useEffect(() => { let active = true; catalog.load().then(rows => { if (active) setCatalogItems(rows); }); return () => { active = false; }; }, []);
    const ids = items.map(item => item.id).sort((a, b) => a - b).join(',');
    useEffect(() => { let active = true; marketPrices.load(ids ? ids.split(',').map(Number) : []).then(rows => { if (active) setPrices(rows); }); return () => { active = false; }; }, [ids]);
    const meatAmount = meat.trim() ? parseMeatAmount(meat) : 0;
    const offerItems = items.map(item => ({ ...item, quantity: parseAuctionAmount(String(item.quantity), 5000000000) ?? 0 }));
    const value = meatAmount == null ? null : offerValue(meatAmount, offerItems, prices);
    const quantityValue = parseAuctionAmount(quantity, 5000000000);
    function stepQuantity(step) { const count = parseAuctionAmount(quantity, 5000000000); if (count != null) setQuantity(String(Math.max(1, Math.min(5000000000, count + step)))); }
    function changeQuantity(id, value) { setItems(rows => rows.map(row => row.id === id ? { ...row, quantity: value } : row)); token.current = null; }
    const matches = search.trim() ? catalogItems.filter(item => isAuctionableItem(item) && item.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 100) : [];
    function add() {
        const item = catalogItems.find(row => String(row.id) === selected && isAuctionableItem(row));
        const count = parseAuctionAmount(quantity, 5000000000);
        if (!item || count == null) { setError(items.length > 0 || (meatAmount != null && meatAmount > 0) ? '' : 'Select an item and a whole quantity.'); return; }
        if (items.length >= 10 || items.some(row => row.id === item.id)) { setError('Offer up to 10 distinct item types; adjust its quantity below.'); return; }
        setItems(previous => [...previous, { id: item.id, name: item.name, quantity: count }]);
        setError(''); setSearch(''); setSelected(''); setQuantity('1'); token.current = null;
    }
    async function submit(event) {
        event.preventDefault();
        if (lock.current) return;
        if (value == null || value <= 0) { setError('Add Meat or items with available market prices. The total cannot exceed 20b Meat.'); return; }
        if (auction.minimumValue != null && value <= auction.minimumValue) { setError('Your offer must exceed the minimum bid market value.'); return; }
        if (!globalThis.confirm(`Submit this Direct barter offer with estimated value ${value.toLocaleString('en-US')} Meat? The host may accept it before the deadline.`)) return;
        lock.current = true; setPending(true); setError('');
        token.current ||= crypto.randomUUID();
        try {
            await writeBarter('submit_barter_offer', { p_auction: auction.id, p_meat: meatAmount, p_items: offerItems.map(({ id, quantity }) => ({ id, quantity })), p_request: token.current });
            setItems([]); setMeat(''); token.current = null; onSubmitted(true);
        } catch (failure) { setError(`${failure.message} Check your offers below before submitting again.`); onSubmitted(false); }
        finally { lock.current = false; setPending(false); }
    }
    return <form onSubmit={submit} className="space-y-3">
        <h2 className="text-lg font-bold">Make a barter offer</h2>
        <p aria-live="polite" className="text-sm font-bold">Bid value: {value == null ? 'Market value unavailable' : `${value.toLocaleString('en-US')} Meat`}</p>
        <p className="text-xs text-gray-500">Estimates use current market prices. You only need to exceed the optional minimum; the host chooses which offer to accept.</p>
        <fieldset disabled={pending} className="space-y-2">
            <label className="block text-sm">Meat (optional)<input className={field} value={meat} inputMode="decimal" placeholder="e.g. 1m" onChange={event => { setMeat(event.target.value); token.current = null; }} onBlur={() => setMeat(value => normalizeAuctionAmount(value, { meat: true }))} /></label>
            <div className="auction-create-form barter-offer-item-editor">
                <div className="auction-item-quantity-grid">
                    <div className="auction-item-search-field">
                        <label htmlFor="barter-item-search" className="mb-2 block text-sm font-bold">Item</label>
                        <input id="barter-item-search" type="search" value={search} onChange={event => setSearch(event.target.value)} className={field} placeholder="Start typing an item name…" />
                    </div>
                    <div className="auction-quantity-row">
                        <label htmlFor="barter-item-quantity" className="text-sm font-bold">Quantity</label>
                        <div className="auction-quantity-stepper">
                            <button type="button" aria-label="Decrease quantity" disabled={quantityValue == null || quantityValue <= 1} onClick={() => stepQuantity(-1)}>−</button>
                            <input id="barter-item-quantity" className="barter-item-quantity" type="text" inputMode="decimal" value={quantity} role="spinbutton" aria-valuemin={1} aria-valuemax={5000000000} aria-valuenow={quantityValue ?? undefined}
                                onChange={event => setQuantity(event.target.value)} onBlur={() => setQuantity(value => normalizeAuctionAmount(value))}
                                onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); stepQuantity(event.key === 'ArrowUp' ? 1 : -1); } }} />
                            <button type="button" aria-label="Increase quantity" disabled={quantityValue == null || quantityValue >= 5000000000} onClick={() => stepQuantity(1)}>+</button>
                        </div>
                    </div>
                </div>
                {(search.trim() || selected) && <>
                    <label htmlFor="barter-selected-item" className="mb-2 block text-sm font-bold">Select an Item:</label>
                    <div className="mb-4 flex min-w-0 items-center gap-2">
                        <select id="barter-selected-item" className="block w-full min-w-0 flex-1 border border-gray-400 text-gray-900" value={selected} onChange={event => setSelected(event.target.value)}>
                            <option value="" disabled>Select an item</option>
                            {selectedItem && !matches.some(item => String(item.id) === selected) && <option value={selected}>{selectedItem.name}</option>}
                            {matches.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                        {selectedItem?.image && <img key={selectedItem.id} src={itemImageUrl(selectedItem.image)} alt={selectedItem.name} width="36" height="36" className="h-9 w-9 shrink-0 rounded-md bg-white object-contain p-0.5 [image-rendering:pixelated]" />}
                    </div>
                    {selectedItem && <div className="-mt-2 mb-4" aria-live="polite"><MarketPrice itemId={selectedItem.id} quantity={quantityValue || 1} /></div>}
                </>}
                {search.trim() && <p className="-mt-3 mb-3 text-xs text-gray-600">{matches.length === 100 ? 'Showing the first 100 matches. Keep typing to narrow the list.' : `${matches.length} matching items.`}</p>}
                <section aria-label="Build your offer" className="bundle-builder-panel mb-5 rounded-xl border border-[#EADBD3] bg-[#FFFAF7] p-3 sm:p-4">
                    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                        <div><h3 className="text-sm font-semibold text-gray-900">Offer contents</h3><p className="mt-1 text-xs leading-relaxed text-gray-700">Choose up to 10 different items to include in your offer.</p></div>
                        <span className="bundle-count-badge rounded-full bg-[#FFF0E6] px-2.5 py-1 text-xs font-semibold tabular-nums text-[#593D31]">{items.length} / 10</span>
                    </div>
                    <button type="button" onClick={add} disabled={items.length >= 10} className="bundle-add-button min-h-10 w-full rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-900 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-90">{selected ? 'Add selected item' : 'Select an item above to add'}</button>
                    {items.length ? <ul className="mt-3 space-y-2">{items.map(item => {
                        const catalogItem = catalogItems.find(row => row.id === item.id);
                        return <li key={item.id} className="barter-offer-item bundle-builder-item flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-[#EEE1DA] bg-white px-2.5 py-2">
                            {catalogItem?.image && <img src={itemImageUrl(catalogItem.image)} alt="" className="h-8 w-8 shrink-0 object-contain [image-rendering:pixelated]" />}
                            <span className="min-w-0 flex-1 break-words text-sm font-medium leading-snug text-gray-900">{item.name}</span>
                            <label className="flex shrink-0 items-center gap-1.5 text-xs text-gray-700">Qty:
                                <input aria-label={`Quantity of ${item.name}`} inputMode="decimal" value={item.quantity} onChange={event => changeQuantity(item.id, event.target.value)}
                                    className="bundle-quantity-input w-[4.5rem] rounded-md border border-gray-300 bg-[#FFFCFA] px-2 py-1.5 text-sm tabular-nums text-gray-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-200" />
                            </label>
                            <span className="flex flex-col">{[1, -1].map(step => <button key={step} type="button" aria-label={`${step > 0 ? 'Increase' : 'Decrease'} quantity of ${item.name}`} className="barter-item-step rounded text-[10px] text-gray-700 hover:bg-blue-50" onClick={() => {
                                const count = parseAuctionAmount(String(item.quantity), 5000000000);
                                if (count != null) changeQuantity(item.id, String(Math.max(1, Math.min(5000000000, count + step))));
                            }}>{step > 0 ? '▲' : '▼'}</button>)}</span>
                            <button type="button" aria-label={`Remove ${item.name}`} onClick={() => { setItems(rows => rows.filter(row => row.id !== item.id)); token.current = null; }} title={`Remove ${item.name}`} className="barter-remove-item bg-transparent"><span aria-hidden="true">×</span></button>
                        </li>;
                    })}</ul> : <p className="bundle-empty-state mt-3 rounded-lg border border-dashed border-[#EADBD3] px-3 py-3 text-center text-xs text-gray-700">Your offer is empty. Search for an item above and add it here.</p>}
                </section>
            </div>
            <button type="submit" disabled={value == null || value <= 0} className="min-h-11 rounded bg-blue-600 px-4 py-2 font-bold text-white disabled:opacity-50">{pending ? 'Submitting…' : 'Submit offer'}</button>
        </fieldset>
        {error && !(error === 'Select an item and a whole quantity.' && (items.length > 0 || (meatAmount != null && meatAmount > 0))) && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </form>;
}
BarterOfferForm.propTypes = { auction: PropTypes.object.isRequired, onSubmitted: PropTypes.func.isRequired, initialOffer: PropTypes.object };
