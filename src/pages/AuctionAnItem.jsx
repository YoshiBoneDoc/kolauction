import ListingPriceInputs from '../components/ListingPriceInputs';
import useListingPrice from '../hooks/useListingPrice';
import { canRelist, relistDraft } from '../lib/relistAuction';
import { createMarketPriceService } from '../lib/marketPrices';
import BundleContents from '../components/BundleContents';
import { prepareBundle, bundleCover, bundleTitle, normalizeBundleTitle, MAX_BUNDLE_ITEMS, MAX_BUNDLE_TITLE_LENGTH } from '../lib/bundles';
import { effectiveFeePercent, feeLabel } from '../lib/feeDisplay';
import { escrowFee } from '../lib/escrowFees';
import { buyFunding } from '../lib/buyOrders';
import TradeTypeBadge from '../components/TradeTypeBadge';
import { useState, useContext, useDeferredValue, useEffect, useMemo, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
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
const coverPrices = createMarketPriceService(supabase);
const fieldClass = 'mb-4 block min-h-11 w-full min-w-0 rounded border border-gray-400 bg-white p-3 text-base text-gray-900';

export default function AuctionAnItem() {
    const { addAuction } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);
    const kolIdentity = useKolIdentity();
    const navigate = useNavigate();
    const { hash, state, key: locationKey } = useLocation();
    const relistHandled = useRef(null);
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
    const [showBuyout, setShowBuyout] = useState(false);
    const buyoutInput = useRef(null);
    const [auctionTime, setAuctionTime] = useState('24');
    const [customDuration, setCustomDuration] = useState(false);
    const durationInput = useRef(null);
    const [customEndTime, setCustomEndTime] = useState('');
    const endingTimeInput = useRef(null);
    const [escrowMode, setEscrowMode] = useState(true);
    const [auctionKind, setAuctionKind] = useState('sell');
    const [deliveryMode, setDeliveryMode] = useState('immediate');
    const isBuy = auctionKind === 'buy';
    const isBundle = auctionKind === 'bundle';
    const minimumPricing = useListingPrice(isBundle ? '1' : quantity, isBuy ? 'item' : 'whole');
    const buyoutPricing = useListingPrice(isBundle ? '1' : quantity, 'whole');
    const { canonical: minBidMeat, setCanonical: setMinBidMeat } = minimumPricing;
    const { canonical: instantPrice, setCanonical: setInstantPrice } = buyoutPricing;
    const [bundleEntries, setBundleEntries] = useState([]);
    const [bundleImageItemId, setBundleImageItemId] = useState(null);
    const [bundleTitleText, setBundleTitleText] = useState('');
    const [bundlePrices, setBundlePrices] = useState(new Map());
    const bundlePriceIds = bundleEntries.map(entry => Number(entry.id)).sort((a, b) => a - b).join(',');
    useEffect(() => {
        let active = true;
        if (bundlePriceIds) coverPrices.load(bundlePriceIds.split(',').map(Number)).then(prices => { if (active) setBundlePrices(prices); });
        return () => { active = false; };
    }, [bundlePriceIds]);
    const [bundleTitleConflict, setBundleTitleConflict] = useState(false);
    const bundleTitleInput = useRef(null);
    const [preview, setPreview] = useState(null);
    const [giveaway, setGiveaway] = useState(false);
    const [giveawayCondition, setGiveawayCondition] = useState('last_bid');
    const [giveawayTitle, setGiveawayTitle] = useState('Meat Stack Mania');
    useEffect(() => {
        const select = durationInput.current;
        if (!select) return;
        let lastStep = -Infinity;
        function scrollDuration(event) {
            if (customDuration || !event.deltaY || event.ctrlKey) return;
            event.preventDefault();
            if (performance.now() - lastStep < 160) return;
            lastStep = performance.now();
            const options = ['6', '12', '24', '72', '168', '336', '720'];
            setAuctionTime(current => options[Math.max(0, Math.min(options.length - 1, options.indexOf(current) + (event.deltaY > 0 ? 1 : -1)))]);
        }
        select.addEventListener('wheel', scrollDuration, { passive: false });
        return () => select.removeEventListener('wheel', scrollDuration);
    }, [customDuration, preview]);
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const previewHeading = useRef(null);
    const publishDialog = useRef(null);
    const submitting = useRef(false);
    const protectionSection = useRef(null);
    const protectionLinkHandled = useRef(null);
    const protectionLink = hash === '#escrow-protection';
    useEffect(() => {
        if (!protectionLink) { protectionLinkHandled.current = null; return; }
        const viewer = currentUser?.id || 'guest';
        if (protectionLinkHandled.current === viewer) return;
        if (isBuy || !escrowMode || preview) {
            setAuctionKind('sell');
            setEscrowMode(true);
            setPreview(null);
            return;
        }
        const section = protectionSection.current;
        if (!section) return;
        const details = section.querySelector('details');
        if (details) details.open = true;
        section.scrollIntoView({ block: 'start' });
        protectionLinkHandled.current = viewer;
    }, [protectionLink, isBuy, escrowMode, preview, currentUser?.id]);
    useEffect(() => {
        if (relistHandled.current === locationKey || !canRelist(state?.relist || {}, currentUser)) return;
        relistHandled.current = locationKey;
        const draft = relistDraft(state.relist);
        setAuctionKind(draft.kind);
        setSelectedItem(draft.itemId); setItemSearch(draft.kind === 'bundle' ? '' : draft.itemSearch);
        setQuantity(draft.quantity); setMinBidMeat(draft.minimum);
        setInstantPrice(draft.buyout); setShowBuyout(Boolean(draft.buyout));
        setEscrowMode(draft.escrow); setDeliveryMode(draft.delivery);
        const preset = [6, 12, 24, 72, 168, 336, 720].includes(draft.hours);
        setAuctionTime(String(preset ? draft.hours : 24));
        setCustomDuration(!preset);
        setCustomEndTime(preset ? '' : localDateTimeInput(auctionNow() + draft.hours * 3600000));
        setBundleEntries(draft.entries); setBundleTitleText(draft.title); setBundleImageItemId(draft.cover);
        setPreview(null); setError(''); setBundleTitleConflict(false);
    }, [locationKey, state, currentUser, setMinBidMeat, setInstantPrice]);
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
        if (!isBundle && ((minimumPricing.message && !minBidMeat) || (buyoutPricing.message && !instantPrice && !isBuy))) { setError(minimumPricing.message || buyoutPricing.message); return; }
        const item = catalogItems.find(entry => String(entry.id) === selectedItem && isAuctionableItem(entry));
        const count = parseAuctionAmount(quantity, 5000000000);
        const minimum = parseMeatAmount(minBidMeat);
        const purchasePrice = !isBuy && instantPrice.trim() ? parseMeatAmount(instantPrice) : null;
        if (!isBundle && !isBuy && (buyoutPricing.whole.trim() || buyoutPricing.item.trim()) && !instantPrice.trim()) { setError(buyoutPricing.message || 'Enter a valid positive buyout price in Meat.'); return; }
        let contents = null;
        let customTitle = '';
        if (isBundle) {
            try { contents = prepareBundle(bundleEntries, catalogItems); customTitle = normalizeBundleTitle(bundleTitleText); }
            catch (failure) { setError(failure.message); return; }
        }
        if (!isBundle && !item) { setError('Please select an item to auction.'); return; }
        if (!isBundle && count === null) { setError('Quantity must be a whole number between 1 and 5 billion.'); return; }
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
        if (giveaway && (isBuy || isBundle)) { setError('Giveaways use a single sell item.'); return; }
        if (giveaway && giveawayCondition !== 'last_bid' && !escrowMode) { setError('This win condition requires Escrow delivery.'); return; }
        if (giveaway && !giveawayTitle.trim()) { setError('Enter a giveaway title.'); return; }
        setPreview({ ...(giveaway ? { giveawayTitle: giveawayTitle.trim(), giveawayWinCondition: giveawayCondition } : {}), item: contents ? bundleTitle(contents, customTitle) : item.name, itemId: contents ? contents[0].id : item.id, quantity: contents ? 1 : count, ...(contents ? { bundleItems: contents, bundleTitle: customTitle || null, bundleImageItemId: contents.some(entry => entry.id === bundleImageItemId) ? bundleImageItemId : null } : {}), minBidMeat: minimum, instantPurchasePrice: purchasePrice, auctionTime, escrowMode, ...(customEndAt ? { customEndAt } : {}),
            image: contents ? bundleCover(contents, bundleImageItemId, bundlePrices).image : itemImageUrl(item.image), ...(isBuy ? { auctionKind, deliveryMode } : {}) });
        setError('');
        setBundleTitleConflict(false);
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
            if (failure.code === 'PBT01') {
                publishDialog.current?.close();
                setPreview(null);
                setBundleTitleConflict(true);
                requestAnimationFrame(() => bundleTitleInput.current?.focus());
            }
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
                {protectionLink && <section id="escrow-protection" ref={protectionSection} className="scroll-mt-4 text-left">
                    <EscrowProtection />
                </section>}
            </div>
        </main>
    );

    return (
        <main className="site-page-background flex-1 bg-gray-50 p-4 sm:p-6">
            <h1 className="mb-6 text-center text-3xl font-bold text-blue-600 sm:text-4xl">Create Auction</h1>
            {!preview && <p className="mx-auto mb-4 max-w-lg text-sm text-gray-700">{kolIdentity && !kolIdentity.kol_player_id && <>First <Link to="/profile" className="text-blue-700 underline">link your KoL account</Link>. </>}Choose what you want to buy or sell. The mode stays fixed after publishing.</p>}
            <div className="mx-auto max-w-lg rounded-lg bg-white p-4 shadow-md sm:p-8">
                {!preview && <div className="mb-5">
                    <div role="group" aria-label="Auction type" className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
                        {[['buy','Buy Items'],['sell','Sell Items']].map(([value,label]) => {
                            const selected = value === 'buy' ? isBuy : !isBuy;
                            return <button key={value} type="button" aria-pressed={selected}
                                onClick={() => { if (value === 'buy') { setAuctionKind('buy'); setGiveaway(false); setEscrowMode(true); setCustomDuration(false); } else if (isBuy) setAuctionKind('sell'); setError(''); }}
                                className={`min-h-11 rounded-lg border px-4 py-2 text-sm font-semibold ${selected ? 'border-blue-200 bg-white text-blue-800 shadow-sm' : 'border-transparent bg-transparent text-slate-500'}`}>{label}</button>;
                        })}
                    </div>
                    {!isBuy && <fieldset aria-label="Sale type" className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm">
                        <legend className="sr-only">Sale type</legend>
                        <span aria-hidden="true" className="font-semibold text-gray-700">Sale type:</span>
                        <div className="listing-shape-control inline-flex w-44 max-w-full shrink-0 rounded-lg border border-[#EADBD3] bg-[#FFFAF7] p-0.5">
                            {[['sell', 'Single item'], ['bundle', 'Bundle']].map(([value, label]) => <label key={value} className="inline-flex min-w-0 flex-1 cursor-pointer">
                                <input type="radio" name="sell-auction-type" value={value} checked={auctionKind === value}
                                    onChange={() => { setAuctionKind(value); if (value === 'bundle') { setGiveaway(false); } setError(''); }} className="peer sr-only" />
                                <span data-selected={auctionKind === value} className={`listing-shape-option w-full rounded-md px-2 py-1 text-center text-xs font-semibold transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-600 ${auctionKind === value ? 'bg-[#E8EEFF] text-[#2454D8]' : 'text-[#647084] hover:bg-[#FFF0E8]'}`}>{label}</span>
                            </label>)}
                        </div>
                    </fieldset>}
                </div>}
                {error && <p id="listing-error" role="alert" className="mb-4 break-words font-semibold text-red-700">{error}</p>}
                {preview ? <section aria-label="Preview auction">
                    <h2 ref={previewHeading} tabIndex={-1} className="text-xl font-bold text-gray-900">Preview Auction</h2>
                    <p className="mt-1 text-sm text-gray-500">Review your listing details before publishing.</p>
                    {preview.bundleItems ? <>
                        <div className="bundle-preview-summary my-4 rounded-xl border border-[#EADBD3] bg-[#FFF7F2] p-4">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#647084]">Bundle auction</p>
                                    <h3 className="mt-1 break-words text-lg font-semibold leading-snug text-gray-900">{(preview.bundleTitle ? preview.item : null) || `One listing · ${preview.bundleItems.length} item types`}</h3>
                                    {preview.bundleTitle && <p className="mt-1 text-xs text-gray-600">One listing · {preview.bundleItems.length} item types</p>}
                                </div>
                                <span className="bundle-preview-badge rounded-full border border-[#E9BFA9] bg-[#FFFAF7] px-3 py-1 text-xs font-semibold text-[#7C5140]">Sold together</span>
                            </div>
                        </div>
                        <BundleContents items={preview.bundleItems} variant="preview" />
                        <p className="-mt-2 mb-3 text-xs leading-relaxed text-gray-600">Minimum bid and buyout apply to the full bundle.</p>
                    </> : <div className="my-4 flex min-w-0 items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800">
                        {preview.image && <img src={preview.image} alt={preview.item} className="h-24 w-24 shrink-0 object-contain [image-rendering:pixelated]" />}
                        <div className="min-w-0">
                            <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Item</p>
                            <h3 className="break-words text-lg font-semibold leading-snug text-gray-900 dark:text-gray-100">{preview.item}</h3>
                        </div>
                    </div>}
                    {preview.giveawayTitle && <p className="mb-3 font-bold text-red-700">Giveaway: {preview.giveawayTitle}</p>}
                    <dl className="divide-y divide-gray-100 text-sm">
                        {!preview.bundleItems && <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">Quantity</dt>
                            <dd className="min-w-0 break-words text-right font-medium tabular-nums text-gray-900">{preview.quantity.toLocaleString('en-US')}</dd>
                        </div>}
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">Trading method</dt>
                            <dd className="text-right"><TradeTypeBadge escrow={preview.escrowMode} short /></dd>
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">{preview.auctionKind === 'buy' ? 'Price per item' : `Minimum bid${preview.bundleItems ? '' : ' (whole listing)'}`}</dt>
                            <dd className="min-w-0 break-words text-right font-medium tabular-nums text-gray-900">{preview.minBidMeat.toLocaleString('en-US')} Meat</dd>
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">{preview.auctionKind === 'buy' ? 'Delivery' : `Buyout price${preview.bundleItems ? '' : ' (whole listing)'}`}</dt>
                            <dd className="min-w-0 break-words text-right font-medium tabular-nums text-gray-900">{preview.auctionKind === 'buy' ? (preview.deliveryMode === 'immediate' ? 'As acquired' : 'When order ends') : preview.instantPurchasePrice ? `${preview.instantPurchasePrice.toLocaleString('en-US')} Meat` : 'Not offered'}</dd>
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-baseline gap-3 py-2.5">
                            <dt className="text-gray-500">{preview.customEndAt ? 'Ending time' : 'Duration'}</dt>
                            <dd className="min-w-0 break-words text-right font-medium tabular-nums text-gray-900">{preview.customEndAt ? formatAuctionEnd(preview.customEndAt) : `${preview.auctionTime} hours`}</dd>
                        </div>
                        {preview.auctionKind === 'buy' && <>{[['Purchase funds',buyFunding(preview.minBidMeat, preview.quantity).purchase],[`Commission reserve (${effectiveFeePercent(buyFunding(preview.minBidMeat, preview.quantity).feeReserve, BigInt(preview.minBidMeat) * BigInt(preview.quantity))})`,buyFunding(preview.minBidMeat, preview.quantity).feeReserve],['Required deposit, including fee reserve',buyFunding(preview.minBidMeat, preview.quantity).total]].map(([label,value]) => <div key={label} className="flex justify-between gap-3 py-3"><dt>{label}</dt><dd className="text-right font-semibold">{value.toLocaleString('en-US')} Meat</dd></div>)}</>}
                    {preview.auctionKind !== 'buy' && preview.escrowMode && <div className={`${preview.bundleItems ? 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3' : 'flex justify-between gap-3'} py-3`}><dt>{preview.bundleItems ? <>Estimated fee <span className="block text-xs font-normal text-gray-500">At minimum bid · {effectiveFeePercent(escrowFee(preview.minBidMeat), preview.minBidMeat)}</span></> : `Estimated ${feeLabel(escrowFee(preview.minBidMeat), preview.minBidMeat)} at minimum bid`}</dt><dd className="shrink-0 text-right font-semibold tabular-nums">{escrowFee(preview.minBidMeat).toLocaleString('en-US')} Meat</dd></div>}
                    </dl>
                    {preview.auctionKind === 'buy' && <p className="text-xs text-gray-500">The reserve rounds up to whole Meat. Actual fees are rounded down per fulfillment; unused reserve is refunded.</p>}
                    <div className={preview.bundleItems
                        ? 'bundle-preview-footer -mx-4 -mb-4 mt-5 grid grid-cols-1 gap-2 rounded-b-lg border-t border-[#EADBD3] bg-[#FFF7F2] p-4 dark:border-gray-700 dark:bg-gray-800/60 sm:-mx-8 sm:-mb-8 sm:grid-cols-[0.85fr_1.15fr] sm:gap-3 sm:p-5'
                        : 'mt-4 grid grid-cols-2 gap-3 border-t border-gray-100 pt-4'}>
                        <button type="button" onClick={() => { setPreview(null); setError(''); }} disabled={pending} className={preview.bundleItems
                            ? 'bundle-preview-back min-h-12 rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800'
                            : 'min-h-12 rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 disabled:opacity-50'}>Back to Edit</button>
                        <button type="button" aria-haspopup="dialog" aria-controls="publish-auction-dialog" onClick={() => { setError(''); publishDialog.current.showModal(); }} disabled={pending} className={preview.bundleItems
                            ? 'button-green min-h-12 rounded-lg border border-green-700 bg-green-700 px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:border-green-800 hover:bg-green-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 disabled:opacity-50'
                            : 'button-green min-h-12 rounded-lg border border-green-700 bg-green-700 px-3 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50'}>{pending ? 'Saving…' : 'Continue to Publish'}</button>
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
                    <div id="escrow-protection" ref={protectionSection} className={`${escrowMode && !isBuy ? 'mb-2' : 'mb-5'} scroll-mt-4`}>
                        {escrowMode ? <EscrowProtection forListing buy={isBuy} minimumPrice={minimumValue} /> : <DirectTradeHelp forListing />}
                        {!escrowMode && <p className="mt-2 text-xs leading-[1.4] text-red-600">Failure to honor a valid, completed auction is a violation of kHub policy and will likely get you banned. We take these very seriously.</p>}
                    </div>
                    {isBundle && <>
                        <label htmlFor="bundleTitle" className="mb-2 block text-sm font-bold">Bundle title <span className="font-normal text-gray-600">(optional)</span></label>
                        <input ref={bundleTitleInput} id="bundleTitle" type="text" value={bundleTitleText} maxLength={MAX_BUNDLE_TITLE_LENGTH} autoComplete="off"
                            onChange={event => { setBundleTitleText(event.target.value); if (bundleTitleConflict) { setBundleTitleConflict(false); setError(''); } }} onBlur={() => setBundleTitleText(value => value.trim())}
                            placeholder="e.g. The Mime Science Collection" aria-invalid={bundleTitleConflict || undefined}
                            aria-describedby={`bundle-title-help${bundleTitleConflict ? ' listing-error' : ''}`} className={fieldClass} />
                        <p id="bundle-title-help" className="-mt-2 mb-4 text-xs text-gray-600">Leave blank for an automatic title. Up to {MAX_BUNDLE_TITLE_LENGTH} characters.</p>
                    </>}
                    <label htmlFor="listing-item-search" className="mb-2 block text-sm font-bold">Find an item</label>
                    <input id="listing-item-search" type="search" value={itemSearch} onChange={(event) => setItemSearch(event.target.value)} placeholder="Start typing an item name…" aria-describedby={hasItemSearch ? 'listing-search-help' : undefined} className={fieldClass} />
                    {(hasItemSearch || selectedItem) && <>
                    <label htmlFor="item" className="mb-2 block text-sm font-bold">Select an Item:</label>
                    <select id="item" required={!isBundle} value={selectedItem} onChange={(event) => setSelectedItem(event.target.value)} aria-describedby={hasItemSearch ? 'listing-search-help' : undefined} className={fieldClass}>
                        <option value="" disabled>Select an item</option>
                        {selectedItem && !searchResults.some(item => String(item.id) === selectedItem)
                            && catalogItems.some(item => String(item.id) === selectedItem && isAuctionableItem(item))
                            && <option value={selectedItem}>{catalogItems.find(item => String(item.id) === selectedItem).name}</option>}
                        {searchResults.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                    </>}
                    {hasItemSearch && <p id="listing-search-help" className="-mt-3 mb-3 text-xs text-gray-600">{itemSearch !== deferredSearch ? 'Searching items…' : matchingItems.length > resultLimit ? `Showing the first ${resultLimit} of ${matchingItems.length.toLocaleString('en-US')} matches. Keep typing to narrow the list.` : `${matchingItems.length} matching items.`}</p>}
                    {hasItemSearch && itemSearch === deferredSearch && searchResults.length === 0 && <p role="status" className="mb-4 text-sm text-gray-600">No items match your search.{selectedItem ? ' Your previous selection is still selected.' : ''}</p>}
                    <label htmlFor="quantity" className="mb-2 block text-sm font-bold">Quantity:</label>
                    <div className="mb-4 flex gap-2">
                        <input id="quantity" type="text" inputMode="decimal" required={!isBundle} autoComplete="off" value={quantity}
                            role="spinbutton" aria-valuemin={1} aria-valuemax={5000000000} aria-valuenow={quantityValue ?? undefined}
                            onChange={(event) => setQuantity(event.target.value)}
                            onBlur={() => setQuantity(value => normalizeAuctionAmount(value))}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                    event.preventDefault();
                                    stepQuantity(event.key === 'ArrowUp' ? 1 : -1);
                                }
                            }}
                            className={`block w-full min-w-0 rounded border border-gray-400 bg-white text-base text-gray-900 h-9 px-3 py-1.5 leading-5`} />
                        <button type="button" aria-label="Increase quantity" title="Increase quantity by 1"
                            disabled={quantityValue === 5000000000 || (quantityValue === null && quantity.trim() !== '')}
                            onClick={() => stepQuantity(1)} className={`h-9 min-w-11 shrink-0 rounded border border-gray-400 bg-white px-3 text-gray-900 disabled:opacity-40`}>▲</button>
                        <button type="button" aria-label="Decrease quantity" title="Decrease quantity by 1"
                            disabled={quantityValue === null || quantityValue <= 1}
                            onClick={() => stepQuantity(-1)} className={`h-9 min-w-11 shrink-0 rounded border border-gray-400 bg-white px-3 text-gray-900 disabled:opacity-40`}>▼</button>
                    </div>
                    {isBundle && <section aria-label="Build your bundle" className="bundle-builder-panel mb-5 rounded-xl border border-[#EADBD3] bg-[#FFFAF7] p-3 sm:p-4">
                        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                            <div>
                                <h2 className="text-sm font-semibold text-gray-900">Bundle contents</h2>
                                <p className="mt-1 text-xs leading-relaxed text-gray-700">Choose 2–{MAX_BUNDLE_ITEMS} different items. Buyers bid on the complete lot.</p>
                            </div>
                            <span className="bundle-count-badge rounded-full bg-[#FFF0E6] px-2.5 py-1 text-xs font-semibold tabular-nums text-[#593D31]">{bundleEntries.length} / {MAX_BUNDLE_ITEMS}</span>
                        </div>
                        <button type="button" disabled={bundleEntries.length >= MAX_BUNDLE_ITEMS} onClick={() => {
                            const item = catalogItems.find(entry => String(entry.id) === selectedItem && isAuctionableItem(entry));
                            const count = parseAuctionAmount(quantity, 5000000000);
                            if (!item || count === null) { setError('Select an item and enter a valid quantity before adding it.'); return; }
                            if (bundleEntries.some(entry => entry.id === item.id)) { setError('That item is already in your bundle. Adjust its quantity below.'); return; }
                            setBundleEntries(entries => [...entries, { id: item.id, quantity: String(count) }]);
                            setSelectedItem(''); setItemSearch(''); setQuantity('1'); setError('');
                        }} className="bundle-add-button min-h-10 w-full rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-900 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-90">{selectedItem ? 'Add selected item' : 'Select an item above to add'}</button>
                        {bundleEntries.length > 0 ? <ul className="mt-3 space-y-2">
                            {bundleEntries.map(entry => {
                                const item = catalogItems.find(candidate => candidate.id === entry.id);
                                return <li key={entry.id} className="bundle-builder-item flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-[#EEE1DA] bg-white px-2.5 py-2">
                                    {item?.image && <img src={itemImageUrl(item.image)} alt="" className="h-8 w-8 shrink-0 object-contain [image-rendering:pixelated]" />}
                                    <span className="min-w-0 flex-1 break-words text-sm font-medium leading-snug text-gray-900">{item?.name || `Item #${entry.id}`}</span>
                                    <button type="button" aria-label={`Use ${item?.name || entry.id} as bundle image`} aria-pressed={bundleImageItemId === entry.id}
                                        onClick={() => setBundleImageItemId(entry.id)} className="bundle-image-choice rounded border border-gray-300 px-1.5 py-1 text-[11px] text-gray-700 hover:bg-blue-50" title="Use this item as the bundle image">{bundleImageItemId === entry.id ? '✓ Selected' : 'Use img'}</button>
                                    <label className="flex shrink-0 items-center gap-1.5 text-xs text-gray-700">
                                        Qty:
                                        <input aria-label={`Quantity of ${item?.name || entry.id}`} inputMode="decimal" value={entry.quantity}
                                        onChange={event => setBundleEntries(entries => entries.map(row => row.id === entry.id ? { ...row, quantity: event.target.value } : row))}
                                        className="bundle-quantity-input w-[4.5rem] rounded-md border border-gray-300 bg-[#FFFCFA] px-2 py-1.5 text-sm tabular-nums text-gray-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-200" />
                                    </label>
                                    <span className="flex flex-col">
                                        {[1, -1].map(step => <button key={step} type="button" aria-label={`${step > 0 ? 'Increase' : 'Decrease'} quantity of ${item?.name || entry.id}`} className="rounded px-1.5 text-[10px] leading-4 text-gray-700 hover:bg-blue-50"
                                            onClick={() => setBundleEntries(entries => entries.map(row => {
                                                if (row.id !== entry.id) return row;
                                                const current = parseAuctionAmount(row.quantity, 5000000000);
                                                return current === null ? row : { ...row, quantity: String(Math.max(1, Math.min(5000000000, current + step))) };
                                            }))}>{step > 0 ? '▲' : '▼'}</button>)}
                                    </span>
                                    <button type="button" aria-label={`Remove ${item?.name || entry.id}`} onClick={() => setBundleEntries(entries => entries.filter(row => row.id !== entry.id))}
                                        className="bundle-remove-button min-h-9 rounded-md px-2 text-xs font-medium text-red-800 transition-colors hover:bg-red-50">Remove</button>
                                </li>;
                            })}
                        </ul> : <p className="bundle-empty-state mt-3 rounded-lg border border-dashed border-[#EADBD3] px-3 py-3 text-center text-xs text-gray-700">Your bundle is empty. Search for an item above and add it here.</p>}
                    </section>}
                    {isBundle ? <>
                    <label htmlFor="minBidMeat" className="mb-2 block text-sm font-bold">{isBuy ? 'Maximum purchase price per item (Meat):' : 'Minimum Bid (Meat, whole listing):'}</label>
                    <input id="minBidMeat" type="text" inputMode="decimal" required autoComplete="off" value={minBidMeat} onChange={(event) => setMinBidMeat(event.target.value)} onBlur={() => setMinBidMeat(value => normalizeAuctionAmount(value, { meat: true }))} placeholder="e.g. 1000, 10b, 4.53m, 50k" className={fieldClass} />
                    </> : <ListingPriceInputs id="minimum-price" label={isBuy ? 'Maximum purchase price (Meat):' : 'Minimum Bid (Meat):'} pricing={minimumPricing} required />}
                    {!isBuy && (showBuyout ? <section id="buyout-price-fields" className="mb-4">
                        {isBundle ? <>
                        <label htmlFor="instantPurchasePrice" className="mb-2 block text-sm font-bold">Buyout Price (Meat, whole listing, optional):</label>
                        <input ref={buyoutInput} id="instantPurchasePrice" type="text" inputMode="decimal" autoComplete="off" value={instantPrice}
                            onChange={(event) => setInstantPrice(event.target.value)}
                            onBlur={() => setInstantPrice(value => normalizeAuctionAmount(value, { meat: true }))}
                            placeholder="e.g. 1000, 10b, 4.53m, 50k" aria-describedby="instant-price-help" className={fieldClass} />
                        </> : <ListingPriceInputs id="buyout-price" label="Buyout Price (Meat, optional):" pricing={buyoutPricing} inputRef={buyoutInput} />}
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
                    <label htmlFor="auctionTime" className="mb-2 block text-sm font-bold">Duration:</label>
                    <div className="mb-4 flex min-w-0 gap-2">
                        <select ref={durationInput} title="Scroll to adjust the duration, or click to choose." id="auctionTime" value={auctionTime} disabled={customDuration} onChange={(event) => setAuctionTime(event.target.value)} className="block min-h-11 w-full min-w-0 flex-1 rounded border border-gray-400 bg-white p-3 text-base text-gray-900 disabled:bg-gray-100 disabled:text-gray-500">
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
                    {!isBuy && !giveaway && <p className="-mt-2 mb-4 text-xs text-gray-500">Last-minute bids reset the countdown to 1 minute.</p>}
                    {currentUser?.isAdmin && <div className="mb-4"><button type="button" aria-pressed={giveaway} onClick={() => { const next = !giveaway; setGiveaway(next); if (next) { const meat = catalogItems.find(item => item.name === 'dense meat stack'); setAuctionKind('sell'); setEscrowMode(true); setSelectedItem(String(meat?.id || '')); setItemSearch('dense meat stack'); setQuantity('1000'); setMinBidMeat('1'); setShowBuyout(false); setInstantPrice(''); } }} className="min-h-11 w-full rounded border border-red-700 bg-red-700 px-4 font-bold text-white">Giveaway</button>{giveaway && <fieldset className="mt-2 flex flex-wrap gap-3 text-xs"><legend className="sr-only">Win Condition</legend>{[['last_bid', 'Last Bid'], ['random_draw', 'Random Draw'], ['split', 'Split'], ['surprise', 'Surprise Me']].map(([value, label]) => <label key={value} className="flex items-center gap-1"><input type="radio" name="giveaway-condition" checked={giveawayCondition === value} onChange={() => { setGiveawayCondition(value); if (value !== 'last_bid') setEscrowMode(true); }} />{label}</label>)}</fieldset>}{giveaway && <label className="mt-3 block text-sm font-bold">Title<input value={giveawayTitle} maxLength={80} onChange={event => setGiveawayTitle(event.target.value)} className={fieldClass} /></label>}</div>}
                    <button type="submit" className="min-h-11 w-full rounded bg-blue-600 px-4 py-3 font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">Preview Auction</button>
                </form>}
            </div>
        </main>
    );
}
