import { useContext, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { auctionFilters, auctionSorts, browseAuctions } from '../lib/auctionBrowsing';
import { useNow } from '../hooks/useNow';
import AuctionCard from '../components/AuctionCard';
import AuctionNavigation from '../components/AuctionNavigation';

export default function AllAuctions() {
    const { auctions, isLoading, error } = useContext(AuctionsContext);
    const [params, setParams] = useSearchParams();
    const now = useNow();
    const search = params.get('q') || '';
    const status = auctionFilters.some(([value]) => value === params.get('status')) ? params.get('status') : 'active';
    const sort = auctionSorts.some(([value]) => value === params.get('sort')) ? params.get('sort') : 'ending';
    const visible = useMemo(() => browseAuctions(auctions, { search, status, sort, now }), [auctions, search, status, sort, now]);

    function update(name, value) {
        setParams((previous) => {
            const next = new URLSearchParams(previous);
            if (value) next.set(name, value);
            else next.delete(name);
            return next;
        }, { replace: true });
    }

    return (
        <div className="min-h-screen bg-[#F9F9F9] px-4 pb-8 sm:px-6">
            <AuctionNavigation />
            <main className="mx-auto max-w-6xl">
                <h1 className="my-6 text-center text-3xl font-bold text-[#7695FF] sm:text-4xl">All Auctions</h1>
                <section aria-label="Find auctions" className="mb-6 grid gap-4 rounded-lg border bg-white p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr]">
                    <div className="min-w-0 sm:col-span-2 lg:col-span-1">
                        <label htmlFor="auction-search" className="mb-1 block text-sm font-semibold">Search item names</label>
                        <input id="auction-search" type="search" value={search} onChange={(event) => update('q', event.target.value)}
                            placeholder="Search for an item…" className="min-h-11 w-full min-w-0 rounded border border-gray-400 bg-white p-3 text-base text-gray-900" />
                    </div>
                    <div className="min-w-0">
                        <label htmlFor="auction-status" className="mb-1 block text-sm font-semibold">Auction status</label>
                        <select id="auction-status" value={status} onChange={(event) => update('status', event.target.value)} className="min-h-11 w-full rounded border border-gray-400 bg-white p-3 text-base text-gray-900">
                            {auctionFilters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                    </div>
                    <div className="min-w-0">
                        <label htmlFor="auction-sort" className="mb-1 block text-sm font-semibold">Sort by</label>
                        <select id="auction-sort" value={sort} onChange={(event) => update('sort', event.target.value)} className="min-h-11 w-full rounded border border-gray-400 bg-white p-3 text-base text-gray-900">
                            {auctionSorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                    </div>
                    <p className="text-xs text-gray-600 sm:col-span-2 lg:col-span-3">Price uses the current bid, or the minimum bid if there are no bids. Completed trades use their final price.</p>
                </section>
                {isLoading ? <p role="status">Loading auctions…</p> : <>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                        <p role="status">{visible.length} {visible.length === 1 ? 'auction' : 'auctions'} found</p>
                        <button onClick={() => setParams({}, { replace: true })} className="min-h-11 bg-transparent px-3 text-blue-700 underline">Reset filters</button>
                    </div>
                    {!error && visible.length === 0 && <p className="rounded-lg border bg-white p-6">{auctions.length === 0 ? 'No auctions have been listed yet.' : 'No auctions match your search and filters. Try another item name or status.'}</p>}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {visible.map((auction) => <AuctionCard key={auction.id} auction={auction} now={now} />)}
                    </div>
                </>}
            </main>
        </div>
    );
}
