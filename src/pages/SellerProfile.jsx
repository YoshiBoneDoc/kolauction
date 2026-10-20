import { useContext } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import AuctionCard from '../components/AuctionCard';
import { formatCompactMeat } from '../lib/formatMeat';
import { auctionFilters, auctionSorts } from '../lib/auctionBrowsing';
import { useNow } from '../hooks/useNow';
import useAuctionSearch from '../hooks/useAuctionSearch';
import FeedbackCounts from '../components/FeedbackCounts';
import ReputationSummary from '../components/ReputationSummary';

const number = value => BigInt(value ?? 0).toLocaleString('en-US');

export default function SellerProfile() {
    const { currentUser } = useContext(UserContext);
    const { seller, auctions, total, isLoading, error, refreshAuctions } = useContext(AuctionsContext);
    const [params, setParams] = useSearchParams();
    const [search, setSearch] = useAuctionSearch();
    const now = useNow();
    const detailed = params.get('view') === 'stats';
    function viewLink(showStats) {
        const next = new URLSearchParams(params);
        if (showStats) {
            next.set('view', 'stats');
            if (!next.has('status')) next.set('status', 'all');
        } else next.delete('view');
        return { search: next.toString() ? `?${next}` : '' };
    }
    const status = auctionFilters.some(([value]) => value === params.get('status')) ? params.get('status') : 'active';
    const sort = auctionSorts.some(([value]) => value === params.get('sort')) ? params.get('sort') : 'ending';
    const page = Math.min(1000000, Math.max(1, Number.parseInt(params.get('page'), 10) || 1));
    function update(name, value) {
        setParams(previous => {
            const next = new URLSearchParams(previous);
            if (name !== 'page') next.delete('page');
            if (value) next.set(name, value); else next.delete(name);
            return next;
        }, { replace: true });
    }

    if (isLoading && !seller) return <p role="status" className="p-6">Loading seller…</p>;
    if (error && !seller) return <main className="mx-auto max-w-6xl space-y-4 p-6"><p role="alert">This seller could not be loaded.</p><button onClick={refreshAuctions} className="min-h-11 text-blue-700 underline">Retry</button></main>;
    if (!seller) return <main className="mx-auto max-w-6xl space-y-4 p-6"><h1 className="text-2xl font-bold">Seller not found</h1><p>This seller has no public listings.</p><Link to="/auctions" className="text-blue-700 underline">Browse auctions</Link></main>;

    const stats = seller.stats;
    return (
        <main className="min-h-screen bg-gray-50 px-4 py-6 sm:px-6">
            <div className="mx-auto max-w-6xl">
                <Link to="/auctions" className="inline-flex min-h-11 items-center text-blue-700 underline">Back to Auctions</Link>
                <h1 className="my-5 break-words text-3xl font-bold text-blue-700">{currentUser && !currentUser.isBanned && seller.usernames_visible !== false ? seller.username : 'Player profile'}</h1>
                {(!currentUser || currentUser.isBanned || seller.usernames_visible === false) && <p className="mb-4 text-sm text-gray-600">Log in with an unrestricted account to see usernames.</p>}
                <nav aria-label="Seller profile views" className="mb-5 flex flex-wrap items-center gap-5 border-b border-gray-200">
                    <Link to={viewLink(false)} aria-current={!detailed ? 'page' : undefined} className={`inline-flex min-h-11 items-center border-b-2 text-lg ${!detailed ? 'border-blue-700 font-bold text-blue-700' : 'border-transparent text-gray-600 hover:text-blue-700'}`}>Auctions</Link>
                    <Link to={viewLink(true)} aria-current={detailed ? 'page' : undefined} className={`inline-flex min-h-11 items-center border-b-2 text-lg ${detailed ? 'border-blue-700 font-bold text-blue-700' : 'border-transparent text-gray-600 hover:text-blue-700'}`}>Seller Profile</Link>
                </nav>
                <div className={`grid grid-cols-1 items-start gap-6 ${detailed ? '' : 'lg:grid-cols-[minmax(0,1fr)_18rem]'}`}>
                    <aside aria-label="Seller statistics" className={`order-first min-w-0 space-y-5 break-words rounded-lg border bg-white p-5 ${detailed ? '' : 'lg:order-last'}`}>
                        <section className="space-y-2">
                            <h2 className="text-xl font-bold">Direct-settlement history</h2>
                            {detailed && <p className="text-sm text-gray-600">Trades where the buyer relied on this seller to deliver without escrow.</p>}
                            {BigInt(stats.legacy_sales ?? 0) > 0n ? <>
                                <p className="text-lg font-semibold">{number(stats.legacy_sales)} completed sales</p>
                                <p>{formatCompactMeat(stats.legacy_value)} Meat in sales</p>
                                {detailed && <p className="text-xs text-gray-600">Confirmed by both participants. kHub did not handle these transfers.</p>}
                            </> : <p className="text-sm text-gray-600">No completed direct sales yet.</p>}
                        </section>
                        <ReputationSummary stats={stats} detailed={detailed} />
                        <section className="space-y-2 border-t pt-4">
                            <h2 className="font-bold">Seller rating · direct settlement</h2>
                            {!detailed && <FeedbackCounts positive={stats.seller_positive} negative={stats.seller_negative} />}
                            {detailed && <p className="text-xs text-gray-600">Feedback from winning buyers. Thumbs up counts the buyer’s confirmation that they received their side; it does not prove both sides completed the trade. Thumbs down counts immediately, including reports awaiting review. Administrators can exclude a thumbs-down count after review. Escrow sales do not establish a direct-settlement track record.</p>}
                        </section>
                        {(detailed || BigInt(stats.buyer_positive ?? 0) > 0n || BigInt(stats.buyer_negative ?? 0) > 0n) && <section className="space-y-2 border-t pt-4">
                            <h2 className="font-bold">Buyer rating · direct settlement</h2>
                            {!detailed && <FeedbackCounts positive={stats.buyer_positive} negative={stats.buyer_negative} />}
                            {detailed && <p className="text-xs text-gray-600">Feedback this player received as a winning buyer, from sellers. The same counting rules apply. Seller and buyer feedback stay separate; escrow trades do not contribute to either rating. Explanations and moderation notes remain private.</p>}
                        </section>}
                        <section className="space-y-2 border-t pt-4">
                            <h2 className="font-bold">Listing activity</h2>
                            <p>{number(stats.active)} active</p>
                            <p>{number(stats.pending)} awaiting settlement</p>
                            <p>{number(stats.unsold)} ended without bids</p>
                            <p>{number(stats.cancelled)} cancelled</p>
                            {detailed && <p className="text-sm text-gray-600">Activity covers both settlement modes. Awaiting settlement means the sale is not complete yet. Listings that ended without bids and cancellations are not counted as completed sales or automatic defaults.</p>}
                        </section>
                        <section className="space-y-2 border-t pt-4">
                            <h2 className="font-bold">Escrow sales</h2>
                            <p>{number(stats.escrow_sales)} completed sales</p>
                            <p>{formatCompactMeat(stats.escrow_value)} Meat in sales</p>
                            {detailed && <p>{number(stats.escrow_units)} item units sold</p>}
                            {detailed && <p className="text-xs text-gray-600">Bot-verified deliveries. Shown separately from the seller’s direct-settlement history. Sale value includes commission.</p>}
                        </section>
                        {detailed && <section className="space-y-2 border-t pt-4">
                            <h2 className="font-bold">How to read these totals</h2>
                            <p className="text-sm text-gray-600">Completed sales count auctions, not individual items. Sale value is the total agreed Meat across completed sales. Item units count quantities across completed escrow sales. These lifetime totals include all of this seller’s public history and do not change with the listing filters below.</p>
                            <p className="text-sm text-gray-600">A completion rate is not available yet. Pending trades and missing feedback do not prove a failure to deliver.</p>
                        </section>}
                    </aside>
                    <section aria-label="Seller auctions" className="min-w-0 space-y-4">
                        <h2 className="text-2xl font-bold">{detailed ? 'Auction history' : 'Auctions'}</h2>
                        <div className="grid grid-cols-1 gap-3 rounded-lg border bg-white p-4 sm:grid-cols-3">
                            <label className="min-w-0 text-sm font-semibold">Search items
                                <input type="search" value={search} onChange={event => setSearch(event.target.value)} className="mt-1 min-h-11 w-full rounded border border-gray-400 bg-white p-2 text-base font-normal text-gray-900" />
                            </label>
                            <label className="min-w-0 text-sm font-semibold">Auction status
                                <select value={status} onChange={event => update('status', event.target.value)} className="mt-1 min-h-11 w-full rounded border border-gray-400 bg-white p-2 text-base font-normal text-gray-900">
                                    {auctionFilters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                                </select>
                            </label>
                            <label className="min-w-0 text-sm font-semibold">Sort by
                                <select value={sort} onChange={event => update('sort', event.target.value)} className="mt-1 min-h-11 w-full rounded border border-gray-400 bg-white p-2 text-base font-normal text-gray-900">
                                    {auctionSorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                                </select>
                            </label>
                        </div>
                        {isLoading ? <p role="status">Loading auctions…</p> : error ? <div role="alert" className="space-y-2">
                            <p>These auctions could not be loaded.</p>
                            <button onClick={refreshAuctions} className="min-h-11 text-blue-700 underline">Retry</button>
                        </div> : <>
                        <p role="status">{number(total)} {Number(total) === 1 ? 'auction' : 'auctions'} found</p>
                        {auctions.length === 0 && <p className="rounded-lg border bg-white p-5">No auctions match these filters. Choose All auctions to include this seller’s history.</p>}
                        <div className={`grid gap-4 sm:grid-cols-2 ${detailed ? 'lg:grid-cols-3 xl:grid-cols-4' : 'xl:grid-cols-3'}`}>{auctions.map(auction => <AuctionCard key={auction.id} auction={auction} now={now} />)}</div>
                        {(total > 24 || page > 1) && <nav aria-label="Seller auction pages" className="flex flex-wrap items-center justify-center gap-4">
                            <button disabled={page <= 1} onClick={() => update('page', String(page - 1))} className="min-h-11 rounded border bg-white px-4 disabled:opacity-50">Previous</button>
                            <span>Page {page} of {Math.max(1, Math.ceil(total / 24))}</span>
                            <button disabled={page * 24 >= total} onClick={() => update('page', String(page + 1))} className="min-h-11 rounded border bg-white px-4 disabled:opacity-50">Next</button>
                        </nav>}
                        </>}
                    </section>
                </div>
            </div>
        </main>
    );
}
