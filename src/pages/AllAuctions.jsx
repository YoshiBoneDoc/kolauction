import { useContext, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import { auctionFilters, auctionSorts, browseAuctions } from '../lib/auctionBrowsing';
import { useNow } from '../hooks/useNow';
import CompactAuctionCard from '../components/CompactAuctionCard';
import PendingTrades from '../components/PendingTrades';
import useAuctionSearch from '../hooks/useAuctionSearch';

export default function AllAuctions() {
    const { auctions, total, isLoading, error } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);
    const [params, setParams] = useSearchParams();
    const [searchInput, setSearchInput] = useAuctionSearch();
    const now = useNow();
    const [openBid, setOpenBid] = useState(null);
    const browseKey = params.toString();
    const search = params.get('q') || '';
    const mineOnly = Boolean(currentUser && params.get('mine') === '1');
    const othersOnly = Boolean(currentUser && params.get('mine') === 'others');
    const ownershipFiltered = mineOnly || othersOnly;
    const ownershipAction = mineOnly ? 'Others' : othersOnly ? 'View All' : 'My Auctions';
    const status = auctionFilters.some(([value]) => value === params.get('status')) ? params.get('status') : 'active';
    const sort = auctionSorts.some(([value]) => value === params.get('sort')) ? params.get('sort') : 'ending';
    const trade = ['escrow', 'direct', 'none'].includes(params.get('trade')) ? params.get('trade') : 'all';
    const page = Math.min(1000000, Math.max(1, Number.parseInt(params.get('page'), 10) || 1));
    const visible = useMemo(() => browseAuctions(ownershipFiltered ? auctions.filter(auction => mineOnly ? auction.sellerId === currentUser.id : auction.sellerId !== currentUser.id) : auctions, { search, status, sort, trade, now }), [auctions, mineOnly, ownershipFiltered, currentUser?.id, search, status, sort, trade, now]);
    const found = total ?? visible.length;

    function update(name, value) {
        setOpenBid(null);
        setParams((previous) => {
            const next = new URLSearchParams(previous);
            if (name !== 'page') next.delete('page');
            if (value) next.set(name, value);
            else next.delete(name);
            return next;
        }, { replace: true });
    }

    return (
        <div className="flex-1 bg-[#F9F9F9] px-4 pb-8 sm:px-6">

            <main className="mx-auto max-w-7xl">
                <h1 className="my-4 text-center text-3xl font-bold text-[#7695FF] sm:text-4xl">All Auctions</h1>
                <PendingTrades />
                <section aria-label="Find auctions" className="mb-1 rounded-lg border border-gray-200 bg-white px-3 py-3">
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="min-w-[160px] flex-1">
                            <label htmlFor="auction-search" className="sr-only">Search item names</label>
                            <input id="auction-search" type="search" value={searchInput} onChange={event => setSearchInput(event.target.value)}
                                placeholder="Search for an item…" className="h-9 w-full rounded border border-gray-400 bg-white px-3 text-sm text-gray-900" />
                        </div>
                        <div role="group" aria-label="Sort auctions" className="flex flex-wrap items-center gap-2">
                            {[
                                [['ending', 'Ending Soon'], ['newest', 'Newest'], ['activity', 'Recent Activity']],
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
                        <div role="group" aria-label="Trading methods" className="flex items-center gap-1">
                            {['escrow', 'direct'].map(method => {
                                const selected = trade === 'all' || trade === method;
                                const colors = selected
                                    ? 'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100'
                                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50';
                                return <button key={method} type="button" aria-pressed={selected}
                                    onClick={() => update('trade', trade === 'all' ? (method === 'escrow' ? 'direct' : 'escrow') : trade === method ? 'none' : trade === 'none' ? method : '')}
                                    className={`h-9 rounded border px-2.5 py-1 text-xs font-medium transition-colors ${colors}`}>
                                    {method === 'escrow' ? 'Escrow' : 'Direct'}
                                </button>;
                            })}
                        </div>
                        <div>
                            <label htmlFor="auction-status" className="sr-only">Auction status</label>
                            <select id="auction-status" value={status} onChange={event => update('status', event.target.value)} className="h-9 rounded border border-gray-400 bg-white px-2 text-sm text-gray-900">
                                {auctionFilters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </div>
                        {currentUser && <button type="button" aria-pressed={ownershipFiltered} onClick={() => update('mine', mineOnly ? 'others' : othersOnly ? '' : '1')}
                            title={mineOnly ? 'Show auctions from other sellers' : othersOnly ? 'Show all auctions' : 'Show only your listings'}
                            className={`h-9 w-32 shrink-0 whitespace-nowrap rounded border border-blue-700 px-3 text-sm font-semibold transition-colors ${ownershipFiltered ? 'bg-blue-700 text-white hover:bg-blue-100 hover:text-blue-800' : 'bg-white text-blue-700 hover:bg-blue-50'}`}>{ownershipAction}</button>}
                    </div>
                </section>
                {isLoading ? <p role="status">Loading auctions…</p> : <>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                        <p role="status">{found} {found === 1 ? 'auction' : 'auctions'} found</p>
                        <button onClick={() => { setOpenBid(null); setSearchInput(''); setParams({}, { replace: true }); }} className="min-h-9 border-0 bg-transparent px-2 text-sm text-blue-700 underline">Reset filters</button>
                    </div>
                    {!error && visible.length === 0 && <p className="rounded-lg border bg-white p-6">{trade === 'none' ? 'Select Escrow or Direct to show auctions.' : mineOnly ? 'No auctions of yours match these filters.' : 'No auctions match your search and filters. Try another item name or status.'}</p>}
                    <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {visible.map((auction) => <CompactAuctionCard key={auction.id} auction={auction} now={now}
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
