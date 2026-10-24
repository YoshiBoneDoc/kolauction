import { getAuctionStatus } from './auctionLifecycle.js';

export const auctionFilters = [
    ['active', 'Active'],
    ['ended', 'Ended (all outcomes)'],
    ['completed', 'Completed trades'],
    ['all', 'All auctions'],
];

export const auctionSorts = [
    ['ending', 'Ending soon'],
    ['newest', 'Newest'],
    ['price-asc', 'Price: low to high'],
    ['price-desc', 'Price: high to low'],
    ['bids-desc', 'Most bids'],
    ['bids-asc', 'Fewest bids'],
    ['activity', 'Recent activity'],
];

export function auctionPrice(auction) {
    return auction.auctionKind === 'buy' ? auction.pricePerItem : auction.finalPrice ?? (auction.currentBid || auction.minBidMeat);
}

export function browseAuctions(auctions, { search = '', status = 'active', sort = 'ending', trade = 'all', kind = 'all', now = Date.now() } = {}) {
    const query = search.trim().toLocaleLowerCase();
    return auctions.filter((auction) => {
        const lifecycle = getAuctionStatus(auction, now);
        const matchesStatus = status === 'all'
            || (status === 'ended' ? !['active', 'finalizing', 'pending_escrow', 'on_hold', 'bidding_closed'].includes(lifecycle)
                : lifecycle === status || status === 'active' && lifecycle === 'finalizing');
        return matchesStatus && (kind === 'all' || (auction.auctionKind || 'sell') === kind) && (trade === 'all' || trade !== 'none' && auction.escrowMode === (trade === 'escrow')) && auction.item.toLocaleLowerCase().includes(query);
    }).sort((a, b) => {
        let comparison = 0;
        if (sort === 'bids-desc') comparison = (b.bidCount ?? b.bids?.length ?? 0) - (a.bidCount ?? a.bids?.length ?? 0);
        if (sort === 'bids-asc') comparison = (a.bidCount ?? a.bids?.length ?? 0) - (b.bidCount ?? b.bids?.length ?? 0);
        if (sort === 'activity') {
            if (a.latestBidAt == null || b.latestBidAt == null) comparison = a.latestBidAt == null ? (b.latestBidAt == null ? 0 : 1) : -1;
            else comparison = b.latestBidAt - a.latestBidAt;
        }
        if (sort === 'newest') comparison = b.createdAt - a.createdAt;
        if (sort === 'ending') comparison = a.endTime - b.endTime;
        if (sort === 'price-asc') comparison = auctionPrice(a) - auctionPrice(b);
        if (sort === 'price-desc') comparison = auctionPrice(b) - auctionPrice(a);
        return comparison || b.createdAt - a.createdAt || String(a.id).localeCompare(String(b.id));
    });
}

export function popularActiveAuctions(auctions, now = Date.now()) {
    return browseAuctions(auctions, { now }).sort((a, b) =>
        (b.bidCount ?? b.bids?.length ?? 0) - (a.bidCount ?? a.bids?.length ?? 0) || a.endTime - b.endTime
    );
}

export function timeRemaining(endTime, now) {
    const remaining = Math.max(0, Math.ceil((endTime - now) / 1000));
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor(remaining % 86400 / 3600);
    const minutes = Math.floor(remaining % 3600 / 60);
    return days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m ${remaining % 60}s`;
}

export function recentCompletedAuctions(auctions) {
    return auctions.filter(auction => auction.status === 'completed')
        .sort((a, b) => (Date.parse(b.completedAt) || 0) - (Date.parse(a.completedAt) || 0)
            || String(a.id).localeCompare(String(b.id))).slice(0, 24);
}
