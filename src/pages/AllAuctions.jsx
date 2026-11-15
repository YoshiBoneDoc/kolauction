import TradeTypeBadge from '../components/TradeTypeBadge';
import AuctionSortMenu from '../components/AuctionSortMenu';
import AuctionPagination from '../components/AuctionPagination';
import RaffleAuctionCard from '../components/RaffleAuctionCard';
import useHomeRaffles from '../hooks/useHomeRaffles';
import { matchesRaffleBrowse } from '../lib/raffles';
import AuctionFilters, { AuctionFiltersButton, AUCTION_PRICE_RANGE_ENABLED } from '../components/AuctionFilters';
import { parsePrice } from '../lib/auctionPriceRange';
import { useContext, useEffect, useId, useState } from 'react';
import useAuctionBrowseSession from '../hooks/useAuctionBrowseSession';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import { auctionFilters, resolveBrowseSort } from '../lib/auctionBrowsing';
import { useAuctionBoundaryNow as useNow } from '../hooks/useAuctionBoundaryNow';
import useAdminAuctionBookmarkers from '../hooks/useAdminAuctionBookmarkers';
import useMySavedAuctionIds from '../hooks/useMySavedAuctionIds';
import useAuctionBookmarkCounts from '../hooks/useAuctionBookmarkCounts';
import './AuctionBookmarkRibbon.css';
import CompactAuctionCard from '../components/CompactAuctionCard';
import GiveawayCard from '../components/GiveawayCard';
import useFeaturedGiveaway from '../hooks/useFeaturedGiveaway';
import PendingTrades from '../components/PendingTrades';
import useAuctionSearch from '../hooks/useAuctionSearch';

export default function AllAuctions() {
    const { auctions, total, listingOrderDelayed = false, priceBounds, isLoading, error, hasLoaded = !isLoading && !error, refreshAuctions } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);
    const { params, setParams, rememberSearch, resetSession, navigationType, locationKey } = useAuctionBrowseSession({ priceBounds: AUCTION_PRICE_RANGE_ENABLED ? priceBounds : null, isLoading, error });
    const [searchInput, setSearchInput] = useAuctionSearch(setParams);
    const now = useNow(auctions);
    const featuredGiveaway = useFeaturedGiveaway();
    const raffles = useHomeRaffles(true);
    const [openBid, setOpenBid] = useState(null);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const filtersId = useId();
    useEffect(() => {
        if (navigationType !== 'REPLACE') setOpenBid(null);
    }, [navigationType, locationKey]);
    const browseKey = params.toString();
    const mineOnly = Boolean(currentUser && params.get('mine') === '1');
    const othersOnly = Boolean(currentUser && params.get('mine') === 'others');
    const ownershipFiltered = mineOnly || othersOnly;
    const status = auctionFilters.some(([value]) => value === params.get('status')) ? params.get('status') : 'active';
    const sort = resolveBrowseSort(status, params.get('sort'));
    const deadlineSort = ['ended', 'completed', 'cancelled', 'expired'].includes(status)
        ? ['ended-desc', 'Recently Ended'] : ['ending', 'Ending Soon'];
    const kind = ['buy', 'sell'].includes(params.get('kind')) ? params.get('kind') : 'all';
    const kindLabel = kind === 'all' ? 'Buy & Sell' : kind === 'sell' ? 'Sell' : 'Buy';
    const kindColors = {
        all: 'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100',
        sell: 'border-[#22C55E] bg-green-100 text-green-800 hover:bg-green-200',
        buy: 'border-red-300 bg-red-100 text-red-800 hover:bg-red-200',
    }[kind];
    const cycleIcon = <span aria-hidden="true" className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-base leading-none opacity-70">↺</span>;
    const buyout = ['with', 'without'].includes(params.get('buyout')) ? params.get('buyout') : 'any';
    const bundle = ['with', 'without'].includes(params.get('bundle')) ? params.get('bundle') : 'any';
    const trade = ['escrow', 'direct', 'none'].includes(params.get('trade')) ? params.get('trade') : 'all';
    const minPrice = AUCTION_PRICE_RANGE_ENABLED ? parsePrice(params.get('minPrice')) : null;
    const maxPrice = AUCTION_PRICE_RANGE_ENABLED ? parsePrice(params.get('maxPrice')) : null;
    const activeFilterSummary = [
        trade !== 'all' && (trade === 'none' ? 'No trading methods' : trade === 'escrow' ? 'Escrow' : 'Direct'),
        buyout !== 'any' && `Buyout: ${buyout === 'with' ? 'Yes' : 'No'}`,
        bundle !== 'any' && `Bundle: ${bundle === 'with' ? 'Yes' : 'No'}`,
        ownershipFiltered && (mineOnly ? 'Mine' : 'Others'),
        (minPrice != null || maxPrice != null) && `Price: ${minPrice == null ? '0' : minPrice.toLocaleString('en-US')}–${maxPrice == null ? 'Any' : maxPrice.toLocaleString('en-US')} Meat`,
    ].filter(Boolean);
    const visibleRaffles = raffles.filter(raffle => matchesRaffleBrowse(raffle, { query: params.get('q') || '', status, kind, trade, buyout, bundle, ownershipFiltered, minPrice, maxPrice }));
    const requestedPage = Math.min(1000000, Math.max(1, Number.parseInt(params.get('page'), 10) || 1));
    // The reader filters and sorts the complete matching set BEFORE pagination.
    const found = total;
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(found / 24)));
    const pageRows = auctions;
    const hasFeaturedGiveaway = Boolean(featuredGiveaway && featuredGiveaway.endTime > now);
    const ordinaryCards = pageRows.filter(auction => !(hasFeaturedGiveaway && auction.id === featuredGiveaway.id));
    // Raffle previews share the 24-card grid; trim only the displayed auction tail.
    const visibleAuctionCards = visibleRaffles.length
        ? ordinaryCards.slice(0, Math.max(0, 24 - visibleRaffles.length - Number(hasFeaturedGiveaway)))
        : ordinaryCards;
    const bookmarkCounts = useAuctionBookmarkCounts(pageRows);
    const mySavedAuctionIds = useMySavedAuctionIds();
    const [showBookmarkers, setShowBookmarkers] = useState(false);
    const bookmarkers = useAdminAuctionBookmarkers(pageRows, showBookmarkers);
    useEffect(() => {
        if (hasLoaded && requestedPage !== page) setParams(previous => {
            const next = new URLSearchParams(previous);
            if (page === 1) next.delete('page'); else next.set('page', String(page));
            return next;
        }, { replace: true });
    }, [hasLoaded, requestedPage, page, setParams]);

    function update(name, value) {
        setOpenBid(null);
        setParams((previous) => {
            const next = new URLSearchParams(previous);
            if (name !== 'page') next.delete('page');
            if (name === 'status') next.delete('sort');
            if (value) next.set(name, value);
            else next.delete(name);
            return next;
        }, { replace: true });
    }

    function updatePriceRange(range) {
        if (!priceBounds) return;
        setOpenBid(null);
        setParams(previous => {
            const next = new URLSearchParams(previous);
            next.delete('page');
            if (range.min > priceBounds.min) next.set('minPrice', String(range.min)); else next.delete('minPrice');
            if (range.max < priceBounds.max) next.set('maxPrice', String(range.max)); else next.delete('maxPrice');
            return next;
        }, { replace: true });
    }

    function clearAdvancedFilters() {
        setOpenBid(null);
        setSearchInput('');
        resetSession();
    }

    return (
        <div className="site-page-background flex-1 bg-[#F9F9F9] px-4 pb-8 sm:px-6">

            <main className="mx-auto max-w-7xl">
                <h1 className="auction-page-title my-4 text-center font-bold text-[#7695FF]">All Auctions</h1>
                <PendingTrades />

                {!isLoading && hasLoaded && <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                        {hasLoaded && <p role="status">{listingOrderDelayed ? 'Results may be out of date. Count and ordering are being refreshed.' : `${found} ${found === 1 ? 'auction' : 'auctions'} found${visibleRaffles.length ? ` · ${visibleRaffles.length} raffle ${visibleRaffles.length === 1 ? 'preview' : 'previews'}` : ''}`}</p>}
                </div>}
                <section aria-label="Find auctions" className={`browse-toolbar mb-3 rounded-xl border border-gray-200 bg-white px-3 pt-3 ${filtersOpen ? 'pb-1' : 'pb-3'}`}>
                    <div className="browse-controls flex flex-wrap items-end gap-3">
                        <label htmlFor="auction-search" className="auction-search-field flex w-80 max-w-full items-center gap-2.5 text-gray-500">
                            <span className="sr-only">Search item names or auction number</span>
                            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" className="shrink-0"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
                            <input id="auction-search" type="search" value={searchInput} onChange={event => { rememberSearch(event.target.value); setSearchInput(event.target.value); }}
                                placeholder="Find an item or auction #…" className="w-full min-w-0 rounded-full border-0 bg-gray-100 px-4 py-2.5 text-xs text-gray-900 dark:text-gray-100" />
                        </label>
                        <div className="browse-status-control ml-auto"><AuctionSortMenu title="Status" ariaLabel="Auction status" value={status} options={[["all", "All Auctions"], ...auctionFilters.filter(([value]) => value !== 'all')]} onChange={value => update('status', value)} /></div>
                        <AuctionSortMenu value={sort} onChange={value => update('sort', value)} options={[deadlineSort, ['newest', 'Newest'], ['activity', 'Recent Activity'], ['recommended', 'Discover'], ['bids-desc', 'Bids ↑'], ['bids-asc', 'Bids ↓'], ['price-desc', 'Price: High to Low'], ['price-asc', 'Price: Low to High']]} />
                        <button type="button" aria-label={`Auction type: ${kindLabel}`} data-kind={kind} aria-pressed={kind !== 'all'}
                            onClick={() => update('kind', kind === 'all' ? 'sell' : kind === 'sell' ? 'buy' : '')}
                            title={`Showing ${kindLabel}. Click to show ${kind === 'all' ? 'Sell' : kind === 'sell' ? 'Buy' : 'Buy & Sell'} auctions.`}
                            className={`inline-flex h-9 w-32 shrink-0 items-center gap-2 whitespace-nowrap rounded border px-3 text-sm font-semibold transition-colors ${kindColors}`}>
                            <span className="flex-1 text-center">{kindLabel}</span>{cycleIcon}
                        </button>
                        <AuctionFiltersButton open={filtersOpen} controls={filtersId}
                            count={Number(status !== 'active') + Number(trade !== 'all') + Number(minPrice != null || maxPrice != null) + Number(ownershipFiltered) + Number(buyout !== 'any') + Number(bundle !== 'any')}
                            onToggle={() => setFiltersOpen(previous => !previous)} />
                        <button type="button" onClick={clearAdvancedFilters} className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-gray-200 px-3 text-sm text-gray-600 hover:bg-gray-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700">Reset <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" /></svg></button>

                    </div>
                    {!filtersOpen && activeFilterSummary.length > 0 && <div aria-label="Active filters" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-slate-400">
                        {activeFilterSummary.map(text => text === 'Direct' || text === 'Escrow' ? <TradeTypeBadge key={text} escrow={text === 'Escrow'} short compact pill /> : <span key={text} className={text === 'Buyout: Yes' ? 'text-green-800' : undefined}>{text}</span>)}
                        <button type="button" onClick={clearAdvancedFilters} className="auction-clear-text border-0 bg-transparent p-0 text-xs text-[#C18462] no-underline underline-offset-2 hover:underline hover:text-[#DCA58D]">Clear filters</button>
                    </div>}
                    {filtersOpen && <AuctionFilters id={filtersId} status={status} trade={trade} buyout={buyout} bundle={bundle} bounds={priceBounds} minPrice={minPrice} maxPrice={maxPrice}
                        ownership={currentUser ? mineOnly ? '1' : othersOnly ? 'others' : 'all' : null}
                        onUpdate={update} onRangeChange={updatePriceRange} onClear={clearAdvancedFilters} />}
                </section>
                {error && <p role="alert" className="my-3 text-red-700">
                    {hasLoaded ? 'Refresh delayed. Showing previously loaded auctions.' : 'Auctions could not be loaded. Please try again.'}{' '}
                    <button onClick={refreshAuctions} className="underline">Retry</button>
                </p>}
                {isLoading ? <p role="status">Loading auctions…</p> : <>
                    {!error && pageRows.length === 0 && visibleRaffles.length === 0 && <p className="rounded-lg border bg-white p-6">{trade === 'none' ? 'Select Escrow or Direct to show auctions.' : mineOnly ? 'No auctions of yours match these filters.' : 'No auctions match your search and filters. Try another item name or status.'}</p>}
                    <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {featuredGiveaway && featuredGiveaway.endTime > now && <GiveawayCard compact auction={featuredGiveaway} now={now} />}
                        {visibleRaffles.map(raffle => <RaffleAuctionCard key={`raffle-${raffle.id}`} raffle={raffle} />)}
                        {visibleAuctionCards.map((auction) => <div key={auction.id} className={`auction-bookmark-card relative min-w-0 ${bookmarkCounts[auction.id] > 0 && !auction.liveUnavailable ? 'has-bookmark-ribbon' : ''}`}>
                            {bookmarkCounts[auction.id] > 0 && !auction.liveUnavailable && <span className={`auction-bookmark-ribbon${mySavedAuctionIds.has(auction.id) ? ' is-saved' : ''}`}
                                onMouseEnter={() => setShowBookmarkers(true)} onFocus={() => setShowBookmarkers(true)}
                                tabIndex={bookmarkers.admin ? 0 : undefined}
                                role="img" aria-label={`${bookmarkCounts[auction.id]} players have bookmarked this auction${mySavedAuctionIds.has(auction.id) ? '; saved by you' : ''}`}
                                title={`${bookmarkCounts[auction.id]} ${bookmarkCounts[auction.id] === 1 ? 'player has' : 'players have'} bookmarked this auction${mySavedAuctionIds.has(auction.id) ? ' · Saved by you' : ''}${bookmarkers.admin ? bookmarkers.loaded ? bookmarkers.error ? '\nBookmarker names unavailable' : `\nBookmarked by: ${(bookmarkers.names[auction.id] || []).join(', ') || 'No current bookmarks'}` : '\nLoading bookmarkers…' : ''}`}>
                                {!mySavedAuctionIds.has(auction.id) && <svg aria-hidden="true" className="auction-bookmark-outline" viewBox="0 0 24 32" preserveAspectRatio="none">
                                    <path d="M.5.5h23v30.65L12 25.36.5 31.15Z" />
                                </svg>}
                                {bookmarkCounts[auction.id] > 999 ? '999+' : bookmarkCounts[auction.id]}
                            </span>}
                            <CompactAuctionCard auction={auction} now={now}
                            expanded={openBid?.id === auction.id && openBid?.browseKey === browseKey}
                            onToggleBid={() => setOpenBid(previous => previous?.id === auction.id && previous?.browseKey === browseKey ? null : { id: auction.id, browseKey })} /></div>)}
                    </div>
                    {(found > 24 || page > 1) && <AuctionPagination page={page}
                        totalPages={listingOrderDelayed ? undefined : Math.max(1, Math.ceil(found / 24))}
                        hasNext={page * 24 < found} onPage={next => update('page', String(next))} />}
                </>}
            </main>
        </div>
    );
}
