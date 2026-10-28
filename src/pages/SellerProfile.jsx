import { useContext } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuctionsContext } from '../context/AuctionsContext';
import { UserContext } from '../context/UserContext';
import PublicProfileAuctionCard from '../components/PublicProfileAuctionCard';
import { auctionFilters, auctionSorts, resolveAuctionSort } from '../lib/auctionBrowsing';
import { useNow } from '../hooks/useNow';
import useAuctionSearch from '../hooks/useAuctionSearch';
import TradeHistorySummary from '../components/TradeHistorySummary';

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
        if (showStats) next.set('view', 'stats');
        else next.delete('view');
        return { search: next.toString() ? `?${next}` : '' };
    }
    const status = auctionFilters.some(([value]) => value === params.get('status')) ? params.get('status') : 'all';
    const sort = resolveAuctionSort(status, params.get('sort'));
    const page = Math.min(1000000, Math.max(1, Number.parseInt(params.get('page'), 10) || 1));
    function update(name, value) {
        setParams(previous => {
            const next = new URLSearchParams(previous);
            if (name !== 'page') next.delete('page');
            if (name === 'status') next.delete('sort');
            if (value) next.set(name, value); else next.delete(name);
            return next;
        }, { replace: true });
    }

    if (isLoading && !seller) return <p role="status" className="p-6">Loading seller…</p>;
    if (error && !seller) return <main className="mx-auto max-w-6xl space-y-4 p-6"><p role="alert">This seller could not be loaded.</p><button onClick={refreshAuctions} className="min-h-11 text-blue-700 underline">Retry</button></main>;
    if (!seller) return <main className="mx-auto max-w-6xl space-y-4 p-6"><h1 className="text-2xl font-bold">Seller not found</h1><p>This seller has no public listings.</p><Link to="/auctions" className="text-blue-700 underline">Browse auctions</Link></main>;

    const stats = seller.stats;
    return (
        <main className="site-page-background public-seller-profile flex-1 px-4 py-5 sm:px-6 lg:px-8">
            <div className="public-profile-container mx-auto">
                <header className={`public-profile-header ${detailed ? 'is-detailed' : ''}`}>
                    <div className="public-profile-header-content">
                        <Link to="/auctions" className="public-profile-back">← Back to Auctions</Link>
                        <h1 className="public-profile-player-name">{currentUser && !currentUser.isBanned && seller.usernames_visible !== false ? seller.username : 'Player profile'}</h1>
                        {(!currentUser || currentUser.isBanned || seller.usernames_visible === false) && <p className="public-profile-login-note text-sm text-gray-600">Log in with an unrestricted account to see usernames.</p>}
                        <nav aria-label="Seller profile views" className="public-profile-tabs">
                            <Link to={viewLink(false)} aria-current={!detailed ? 'page' : undefined} className={`public-profile-tab ${!detailed ? 'is-active' : ''}`}>Auctions</Link>
                            <Link to={viewLink(true)} aria-current={detailed ? 'page' : undefined} className={`public-profile-tab ${detailed ? 'is-active' : ''}`}>Seller Profile</Link>
                        </nav>
                    </div>
                </header>
                {detailed ? <section aria-label="Trade History" className="public-profile-detail-panel mx-auto w-full space-y-5 break-words rounded-lg border bg-white p-5">
                    <TradeHistorySummary stats={stats} detailed />
                </section> : <div className="public-profile-layout">
                    <div className="public-profile-section-heading">
                        <h2>Auctions</h2>
                        {!isLoading && !error && <p role="status">{number(total)} found</p>}
                    </div>
                    <div className="public-profile-toolbar">
                        <label className="public-profile-filter public-profile-search">Search items
                            <input type="search" value={search} onChange={event => setSearch(event.target.value)} />
                        </label>
                        <label className="public-profile-filter">Auction status
                            <select value={status} onChange={event => update('status', event.target.value)}>
                                {auctionFilters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </label>
                        <label className="public-profile-filter">Sort by
                            <select value={sort} onChange={event => update('sort', event.target.value)}>
                                {auctionSorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </label>
                    </div>
                    <section aria-label="Seller auctions" className="public-profile-auctions">
                        {isLoading ? <p role="status">Loading auctions…</p> : error ? <div role="alert" className="space-y-2">
                            <p>These auctions could not be loaded.</p>
                            <button onClick={refreshAuctions} className="min-h-11 text-blue-700 underline">Retry</button>
                        </div> : <>
                            <div className="public-profile-auction-list">
                                {auctions.length > 0 && <div className="public-profile-auction-header public-profile-auction-grid">
                                    <span>Item</span>
                                    <span>Auction Details</span>
                                    <span className="public-profile-auction-header-price">Price / Bid</span>
                                </div>}
                                {auctions.length === 0
                                    ? <p className="public-profile-empty">No auctions match these filters. Choose All auctions to include this seller’s history.</p>
                                    : auctions.map(auction => <PublicProfileAuctionCard key={auction.id} auction={auction} now={now} />)}
                            </div>
                            {(total > 24 || page > 1) && <nav aria-label="Seller auction pages" className="flex flex-wrap items-center justify-center gap-4">
                                <button disabled={page <= 1} onClick={() => update('page', String(page - 1))} className="min-h-11 rounded border bg-white px-4 disabled:opacity-50">Previous</button>
                                <span>Page {page} of {Math.max(1, Math.ceil(total / 24))}</span>
                                <button disabled={page * 24 >= total} onClick={() => update('page', String(page + 1))} className="min-h-11 rounded border bg-white px-4 disabled:opacity-50">Next</button>
                            </nav>}
                        </>}
                    </section>
                    <aside aria-label="Seller statistics" className="min-w-0 space-y-5 break-words rounded-lg border bg-white p-5">
                        <TradeHistorySummary stats={stats} />
                    </aside>
                </div>}
            </div>
        </main>
    );
}
