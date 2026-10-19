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
];

export function auctionPrice(auction) {
    return auction.finalPrice ?? (auction.currentBid || auction.minBidMeat);
}

export function browseAuctions(auctions, { search = '', status = 'active', sort = 'ending', now = Date.now() } = {}) {
    const query = search.trim().toLocaleLowerCase();
    return auctions.filter((auction) => {
        const lifecycle = getAuctionStatus(auction, now);
        const matchesStatus = status === 'all'
            || (status === 'ended' ? lifecycle !== 'active' && lifecycle !== 'pending_escrow' : lifecycle === status);
        return matchesStatus && auction.item.toLocaleLowerCase().includes(query);
    }).sort((a, b) => {
        let comparison = 0;
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
