import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useBarterRead from '../hooks/useBarterRead';
import CompactAuctionCard from '../components/CompactAuctionCard';
import AuctionPagination from '../components/AuctionPagination';
import { useAuctionBoundaryNow } from '../hooks/useAuctionBoundaryNow';

export default function BarterCorner() {
    const [params, setParams] = useSearchParams();
    const [draft, setDraft] = useState(null);
    const query = params.get('q') || '';
    const search = draft?.from === query ? draft.value : query;
    const sort = ['ending', 'newest', 'activity'].includes(params.get('sort')) ? params.get('sort') : 'ending';
    const page = Math.min(10000, Math.max(1, Number.parseInt(params.get('page'), 10) || 1));
    useEffect(() => { const timer = setTimeout(() => {
        if (search === query) return;
        setParams(previous => { const next = new URLSearchParams(previous); next.delete('page'); if (search) next.set('q', search); else next.delete('q'); return next; }, { replace: true });
    }, 250); return () => clearTimeout(timer); }, [search, query, setParams]);
    const { data, error, refresh } = useBarterRead('read_barter_auctions', { p_search: query, p_sort: sort, p_page: page });
    const [openBid, setOpenBid] = useState(null);
    const browseKey = `${query}:${sort}:${page}`;
    const rows = (data?.rows || []).map(row => ({ ...row, auctionKind: 'barter', status: 'active', escrowMode: false, minBidMeat: row.minimumValue || 0 }));
    const now = useAuctionBoundaryNow(rows);
    function update(name, value) { setParams(previous => { const next = new URLSearchParams(previous); next.set(name, String(value)); if (name !== 'page') next.delete('page'); return next; }); }
    return <div className="barter-browse-page site-page-background flex flex-1 flex-col bg-[#F9F9F9] px-4 pb-8 sm:px-6"><main className="mx-auto flex w-full max-w-7xl flex-1 flex-col">
        <h1 className="auction-page-title my-4 text-center font-bold text-[#7695FF]">Barter Corner</h1>
        <section aria-label="Find barter items" className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div role="group" aria-label="Sort barter auctions" className="flex h-9 overflow-hidden rounded border border-gray-200 bg-white">
                {[['ending', 'Ending Soon'], ['newest', 'Newest'], ['activity', 'Recent Activity']].map(([value, label]) => <button key={value} type="button" aria-pressed={sort === value} onClick={() => update('sort', value)} className={`h-full rounded-none border-0 border-r border-gray-200 px-2.5 py-1 text-xs font-medium last:border-r-0 ${sort === value ? 'bg-blue-50 text-blue-800' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{label}</button>)}
            </div>
            <label className="auction-search-field flex w-64 max-w-full items-center gap-2.5 text-gray-500">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" className="shrink-0"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
                <input type="search" value={search} maxLength={120} onChange={event => setDraft({ from: query, value: event.target.value })} aria-label="Search barter item names" placeholder="Find an item…" className="w-full min-w-0 rounded-full border-0 bg-gray-100 px-4 py-2.5 text-xs text-gray-900 dark:text-gray-100" />
            </label>
        </section>
        <hr className="mb-3 border-0 border-t border-gray-200" />
        {error && <p role="alert">Barters could not be loaded. {error} <button onClick={refresh}>Retry</button></p>}
        {!data && !error && <p role="status">Loading barters…</p>}
        {data && <>
            <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map(auction => <CompactAuctionCard key={auction.id} auction={auction} now={now}
                    expanded={openBid?.id === auction.id && openBid?.browseKey === browseKey}
                    onToggleBid={() => setOpenBid(previous => previous?.id === auction.id && previous?.browseKey === browseKey ? null : { id: auction.id, browseKey })} />)}
            </div>
            {!data.rows.length && <p className="py-8 text-center text-gray-500">No barter listings match your search.</p>}
            <div className="flex-1" />
            <AuctionPagination page={page} hasNext={Boolean(data.more)} onPage={next => update('page', next)} label="Barter result pages" />
        </>}
    </main></div>;
}
