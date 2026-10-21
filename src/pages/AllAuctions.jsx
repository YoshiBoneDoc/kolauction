import { useContext, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { auctionFilters, auctionSorts, browseAuctions } from '../lib/auctionBrowsing';
import { useNow } from '../hooks/useNow';
import CompactAuctionCard from '../components/CompactAuctionCard';
import AuctionNavigation from '../components/AuctionNavigation';
import PendingTrades from '../components/PendingTrades';
import useAuctionSearch from '../hooks/useAuctionSearch';

export default function AllAuctions() {
    const { auctions, total, isLoading, error } = useContext(AuctionsContext);
    const [params, setParams] = useSearchParams();
    const [searchInput, setSearchInput] = useAuctionSearch();
    const now = useNow();
    const [openBid, setOpenBid] = useState(null);
    const browseKey = params.toString();
    const search = params.get('q') || '';
    const status = auctionFilters.some(([value]) => value === params.get('status')) ? params.get('status') : 'active';
    const sort = auctionSorts.some(([value]) => value === params.get('sort')) ? params.get('sort') : 'ending';
    const page = Math.min(1000000, Math.max(1, Number.parseInt(params.get('page'), 10) || 1));
    const visible = useMemo(() => browseAuctions(auctions, { search, status, sort, now }), [auctions, search, status, sort, now]);
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
        <div className="min-h-screen bg-[#F9F9F9] px-4 pb-8 sm:px-6">
            <AuctionNavigation />
            <main className="mx-auto max-w-7xl">
                <h1 className="my-4 text-center text-3xl font-bold text-[#7695FF] sm:text-4xl">All Auctions</h1>
                <PendingTrades />
                <section aria-label="Find auctions" className="mb-1 grid gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr]">
                    <div className="min-w-0 sm:col-span-2 lg:col-span-1">
                        <label htmlFor="auction-search" className="mb-1 block text-xs font-semibold">Search item names</label>
                        <input id="auction-search" type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)}
                            placeholder="Search for an item…" className="min-h-10 w-full min-w-0 rounded border border-gray-400 bg-white px-3 py-2 text-sm text-gray-900" />
                    </div>
                    <div className="min-w-0">
                        <label htmlFor="auction-status" className="mb-1 block text-xs font-semibold">Auction status</label>
                        <select id="auction-status" value={status} onChange={(event) => update('status', event.target.value)} className="min-h-10 w-full rounded border border-gray-400 bg-white px-3 py-2 text-sm text-gray-900">
                            {auctionFilters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                    </div>
                    <div className="min-w-0">
                        <label htmlFor="auction-sort" className="mb-1 block text-xs font-semibold">Sort by</label>
                        <select id="auction-sort" value={sort} onChange={(event) => update('sort', event.target.value)} className="min-h-10 w-full rounded border border-gray-400 bg-white px-3 py-2 text-sm text-gray-900">
                            {auctionSorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                    </div>
                </section>
                {isLoading ? <p role="status">Loading auctions…</p> : <>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                        <p role="status">{found} {found === 1 ? 'auction' : 'auctions'} found</p>
                        <button onClick={() => { setOpenBid(null); setSearchInput(''); setParams({}, { replace: true }); }} className="min-h-9 border-0 bg-transparent px-2 text-sm text-blue-700 underline">Reset filters</button>
                    </div>
                    {!error && visible.length === 0 && <p className="rounded-lg border bg-white p-6">{auctions.length === 0 ? 'No auctions have been listed yet.' : 'No auctions match your search and filters. Try another item name or status.'}</p>}
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
