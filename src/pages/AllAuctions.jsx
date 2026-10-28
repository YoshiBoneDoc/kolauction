import AuctionFilters, { AuctionFiltersButton, AUCTION_PRICE_RANGE_ENABLED } from '../components/AuctionFilters';
import { parsePrice } from '../lib/auctionPriceRange';
import { useContext, useEffect, useId, useMemo, useState } from 'react';
import useAuctionBrowseSession from '../hooks/useAuctionBrowseSession';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import { auctionFilters, resolveAuctionSort, browseAuctions } from '../lib/auctionBrowsing';
import { useNow } from '../hooks/useNow';
import CompactAuctionCard from '../components/CompactAuctionCard';
import PendingTrades from '../components/PendingTrades';
import useAuctionSearch from '../hooks/useAuctionSearch';

export default function AllAuctions() {
    const { auctions, priceBounds, isLoading, error, hasLoaded = !isLoading && !error, refreshAuctions } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);
    const { params, setParams, rememberSearch, resetSession, navigationType, locationKey } = useAuctionBrowseSession({ priceBounds: AUCTION_PRICE_RANGE_ENABLED ? priceBounds : null, isLoading, error });
    const [searchInput, setSearchInput] = useAuctionSearch(setParams, { immediate: true });
    const now = useNow();
    const [openBid, setOpenBid] = useState(null);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const filtersId = useId();
    useEffect(() => {
        if (navigationType !== 'REPLACE') { setFiltersOpen(false); setOpenBid(null); }
    }, [navigationType, locationKey]);
    const browseKey = params.toString();
    const search = searchInput;
    const mineOnly = Boolean(currentUser && params.get('mine') === '1');
    const othersOnly = Boolean(currentUser && params.get('mine') === 'others');
    const ownershipFiltered = mineOnly || othersOnly;
    const status = auctionFilters.some(([value]) => value === params.get('status')) ? params.get('status') : 'active';
    const sort = resolveAuctionSort(status, params.get('sort'));
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
    const trade = ['escrow', 'direct', 'none'].includes(params.get('trade')) ? params.get('trade') : 'all';
    const minPrice = AUCTION_PRICE_RANGE_ENABLED ? parsePrice(params.get('minPrice')) : null;
    const maxPrice = AUCTION_PRICE_RANGE_ENABLED ? parsePrice(params.get('maxPrice')) : null;
    const requestedPage = Math.min(1000000, Math.max(1, Number.parseInt(params.get('page'), 10) || 1));
    const visible = useMemo(() => browseAuctions(ownershipFiltered ? auctions.filter(auction => mineOnly ? auction.sellerId === currentUser.id : auction.sellerId !== currentUser.id) : auctions, { search, status, sort, trade, kind, minPrice, maxPrice, now }), [auctions, mineOnly, ownershipFiltered, currentUser?.id, search, status, sort, trade, kind, minPrice, maxPrice, now]);
    const found = visible.length;
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(found / 24)));
    const pageRows = visible.slice((page - 1) * 24, page * 24);
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
                <h1 className="my-4 text-center text-3xl font-bold text-[#7695FF] sm:text-4xl">All Auctions</h1>
                <PendingTrades />
                <section aria-label="Find auctions" className={`mb-1 rounded-lg border border-gray-200 bg-white px-3 pt-3 ${filtersOpen ? 'pb-1' : 'pb-3'}`}>
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="min-w-32 flex-1">
                            <label htmlFor="auction-search" className="sr-only">Search item names</label>
                            <input id="auction-search" type="search" value={searchInput} onChange={event => { rememberSearch(event.target.value); setSearchInput(event.target.value); }}
                                placeholder="Search for an item…" className="h-9 w-full rounded border border-gray-400 bg-white px-3 text-sm text-gray-900" />
                        </div>
                        <div role="group" aria-label="Sort auctions" className="flex flex-wrap items-center gap-2">
                            {[
                                [deadlineSort, ['newest', 'Newest'], ['activity', 'Recent Activity']],
                                [
                                    [sort === 'bids-desc' ? 'bids-asc' : 'bids-desc', `Most Bids ${sort === 'bids-desc' ? '▴' : sort === 'bids-asc' ? '▾' : '▴▾'}`],
                                    [sort === 'price-desc' ? 'price-asc' : 'price-desc', `Price ${sort === 'price-desc' ? '▴' : sort === 'price-asc' ? '▾' : '▴▾'}`],
                                ],
                            ].map((options, group) => <div key={group} className={group === 0 ? 'flex h-9 overflow-hidden rounded border border-gray-200 bg-white' : 'flex gap-1'}>
                                {options.map(([value, label]) => {
                                    const selected = value.startsWith('bids-') ? sort.startsWith('bids-') : value.startsWith('price-') ? sort.startsWith('price-') : sort === value;
                                    const hasDirection = value.startsWith('bids-') || value.startsWith('price-');
                                    return <button key={label.split(' ')[0]} type="button" aria-label={label} aria-pressed={selected} onClick={() => update('sort', value)}
                                        className={`inline-flex items-center justify-center gap-2 px-2.5 py-1 text-xs font-medium transition-colors ${group === 0 ? 'h-full rounded-none border-0 border-r border-gray-200 last:border-r-0' : 'h-9 rounded border'} ${selected ? `${group === 0 ? '' : 'border-blue-200'} bg-blue-50 text-blue-800` : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}>
                                        {hasDirection ? <>
                                            <span>{value.startsWith('bids-') ? 'Most Bids' : 'Price'}</span>
                                            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                                                {!selected ? <path d="m7 8 5-5 5 5M7 16l5 5 5-5" /> : <path d={sort.endsWith('-desc') ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />}
                                            </svg>
                                        </> : label}
                                    </button>;
                                })}
                            </div>)}
                        </div>
                        <button type="button" aria-label={`Auction type: ${kindLabel}`} aria-pressed={kind !== 'all'}
                            onClick={() => update('kind', kind === 'all' ? 'sell' : kind === 'sell' ? 'buy' : '')}
                            title={`Showing ${kindLabel}. Click to show ${kind === 'all' ? 'Sell' : kind === 'sell' ? 'Buy' : 'Buy & Sell'} auctions.`}
                            className={`inline-flex h-9 w-32 shrink-0 items-center gap-2 whitespace-nowrap rounded border px-3 text-sm font-semibold transition-colors ${kindColors}`}>
                            <span className="flex-1 text-center">{kindLabel}</span>{cycleIcon}
                        </button>
                        <AuctionFiltersButton open={filtersOpen} controls={filtersId}
                            count={Number(status !== 'active') + Number(trade !== 'all') + Number(minPrice != null || maxPrice != null) + Number(ownershipFiltered)}
                            onToggle={() => setFiltersOpen(previous => !previous)} />
                        <button type="button" aria-label="View all auctions" onClick={clearAdvancedFilters}
                            title="Reset search, sorting, and all filters"
                            className="inline-flex h-9 w-36 shrink-0 items-center gap-2 whitespace-nowrap rounded border border-blue-700 bg-white px-3 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                            <span className="flex-1 text-center">View All</span>{cycleIcon}
                        </button>
                    </div>
                    {filtersOpen && <AuctionFilters id={filtersId} status={status} trade={trade} bounds={priceBounds} minPrice={minPrice} maxPrice={maxPrice}
                        ownership={currentUser ? mineOnly ? '1' : othersOnly ? 'others' : 'all' : null}
                        onUpdate={update} onRangeChange={updatePriceRange} onClear={clearAdvancedFilters} />}
                </section>
                {error && <p role="alert" className="my-3 text-red-700">
                    {hasLoaded ? 'Refresh delayed. Showing previously loaded auctions.' : 'Auctions could not be loaded. Please try again.'}{' '}
                    <button onClick={refreshAuctions} className="underline">Retry</button>
                </p>}
                {isLoading ? <p role="status">Loading auctions…</p> : <>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                        {hasLoaded && <p role="status">{found} {found === 1 ? 'auction' : 'auctions'} found</p>}
                        <button onClick={clearAdvancedFilters} className="min-h-9 border-0 bg-transparent px-2 text-sm text-blue-700 underline">Reset filters</button>
                    </div>
                    {!error && visible.length === 0 && <p className="rounded-lg border bg-white p-6">{trade === 'none' ? 'Select Escrow or Direct to show auctions.' : mineOnly ? 'No auctions of yours match these filters.' : 'No auctions match your search and filters. Try another item name or status.'}</p>}
                    <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {pageRows.map((auction) => <CompactAuctionCard key={auction.id} auction={auction} now={now}
                            expanded={openBid?.id === auction.id && openBid?.browseKey === browseKey}
                            onToggleBid={() => setOpenBid(previous => previous?.id === auction.id && previous?.browseKey === browseKey ? null : { id: auction.id, browseKey })} />)}
                    </div>
                    {(found > 24 || page > 1) && <nav aria-label="Auction pages" className="mt-6 flex items-center justify-center gap-4">
                        <button disabled={page <= 1} onClick={() => update('page', String(page - 1))} className="min-h-11 rounded border bg-white px-4 py-2 disabled:opacity-50">Previous</button>
                        <span>Page {page} of {Math.max(1, Math.ceil(found / 24))}</span>
                        <button disabled={page * 24 >= found} onClick={() => update('page', String(page + 1))} className="min-h-11 rounded border bg-white px-4 py-2 disabled:opacity-50">Next</button>
                    </nav>}
                </>}
            </main>
        </div>
    );
}
