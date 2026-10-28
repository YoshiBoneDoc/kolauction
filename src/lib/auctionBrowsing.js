export { auctionPrice } from './auctionPriceRange.js';
import { auctionPrice, auctionFilterPrice } from './auctionPriceRange.js';
import { getAuctionStatus, isAbandonedEscrowDraft } from './auctionLifecycle.js';

export const auctionFilters = [
    ['active', 'Active'],
    ['completed', 'Completed trades'],
    ['cancelled', 'Cancelled'],
    ['expired', 'Expired / no bids'],
    ['ended', 'Ended (all outcomes)'],
    ['all', 'All auctions'],
];

export const auctionSorts = [
    ['ending', 'Ending soon'],
    ['ended-desc', 'Recently ended'],
    ['newest', 'Newest'],
    ['price-asc', 'Price: low to high'],
    ['price-desc', 'Price: high to low'],
    ['bids-desc', 'Most bids'],
    ['bids-asc', 'Fewest bids'],
    ['activity', 'Recent activity'],
];

export function resolveAuctionSort(status, sort) {
    return auctionSorts.some(([value]) => value === sort) ? sort
        : ['ended', 'completed', 'cancelled', 'expired'].includes(status) ? 'ended-desc' : 'ending';
}

// Public browse default only; seller profiles and explicit sorts stay unchanged.
export function resolveBrowseSort(status, sort) {
    return sort === 'recommended' ? sort : !sort && ['active', 'all'].includes(status) ? 'recommended' : resolveAuctionSort(status, sort);
}

export function auctionEndTime(auction) {
    if (['cancelled', 'voided'].includes(auction.status)) {
        // Cancellation is a distinct event and can happen before the deadline.
        // If its timestamp is unavailable, don't present the deadline as one.
        return Date.parse(auction.cancelledAt);
    }
    return Math.min(auction.endTime,
        Date.parse(auction.finalizedAt) || Infinity, Date.parse(auction.instantPurchasedAt) || Infinity);
}

export function browseAuctions(auctions, { search = '', status = 'active', sort = resolveAuctionSort(status), trade = 'all', kind = 'all', minPrice = null, maxPrice = null, now = Date.now() } = {}) {
    const query = search.trim().toLocaleLowerCase();
    return auctions.filter((auction) => {
        if (isAbandonedEscrowDraft(auction)) return false;
        const lifecycle = getAuctionStatus(auction, now);
        const matchesStatus = status === 'all'
            || (status === 'ended' ? !['active', 'finalizing', 'pending_escrow', 'on_hold', 'bidding_closed'].includes(lifecycle)
                : status === 'cancelled' ? ['cancelled', 'voided'].includes(lifecycle)
                    : status === 'expired' ? ['expired', 'ended_no_bids'].includes(lifecycle)
                        : lifecycle === status || status === 'active' && lifecycle === 'finalizing');
        const price = auctionFilterPrice(auction);
        return (minPrice == null || price >= minPrice) && (maxPrice == null || price <= maxPrice) && matchesStatus && (kind === 'all' || (auction.auctionKind || 'sell') === kind) && (trade === 'all' || trade !== 'none' && auction.escrowMode === (trade === 'escrow')) && auction.item.toLocaleLowerCase().includes(query);
    }).sort((a, b) => {
        let comparison = 0;
        if (sort === 'bids-desc') comparison = (b.bidCount ?? b.bids?.length ?? 0) - (a.bidCount ?? a.bids?.length ?? 0);
        if (sort === 'bids-asc') comparison = (a.bidCount ?? a.bids?.length ?? 0) - (b.bidCount ?? b.bids?.length ?? 0);
        if (sort === 'activity') {
            if (a.latestBidAt == null || b.latestBidAt == null) comparison = a.latestBidAt == null ? (b.latestBidAt == null ? 0 : 1) : -1;
            else comparison = b.latestBidAt - a.latestBidAt;
        }
        if (sort === 'recommended') {
            const urgent = auction => getAuctionStatus(auction, now) === 'active' && auction.endTime > now && auction.endTime - now <= 86400000;
            comparison = Number(urgent(b)) - Number(urgent(a)) || (urgent(a) && urgent(b) ? a.endTime - b.endTime : b.createdAt - a.createdAt);
        }
        if (sort === 'newest') comparison = b.createdAt - a.createdAt;
        if (sort === 'ending') comparison = a.endTime - b.endTime;
        if (sort === 'ended-desc') {
            const leftEnd = auctionEndTime(a), rightEnd = auctionEndTime(b);
            comparison = Number.isFinite(leftEnd) && Number.isFinite(rightEnd) ? rightEnd - leftEnd
                : Number.isFinite(leftEnd) ? -1 : Number.isFinite(rightEnd) ? 1 : 0;
        }
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

export const exploreAuctionTabs = [
    { id: 'popular', label: 'Popular', sort: 'bids-desc' },
    { id: 'new', label: 'New', sort: 'newest' },
    { id: 'ending', label: 'Ending Soon', sort: 'ending' },
];

// Sort the full active pool before choosing one representative per catalog item.
export function exploreAuctions(auctions, tab = 'popular', now = Date.now()) {
    const { sort } = exploreAuctionTabs.find(option => option.id === tab) || exploreAuctionTabs[0];
    const seen = new Set();
    return browseAuctions(auctions, { sort, now }).filter(auction => {
        const key = auction.itemId != null ? `id:${auction.itemId}` : `name:${auction.item.trim().toLocaleLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
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


export const HIGH_ROLLER_MIN_PRICE = 50_000_000;
export function auctionEndingSoon(auction, now = Date.now()) {
    return getAuctionStatus(auction, now) === 'active' && auction.endTime - now <= 3 * 60 * 60 * 1000;
}
export function highRollerValue(auction) {
    const price = auction.auctionKind === 'buy' ? auction.pricePerItem
        : auction.status === 'completed' ? auction.finalPrice ?? auction.currentBid : auction.currentBid || auction.minBidMeat;
    return Math.max(Number(price) || 0, Number(auction.marketValueMeat) || 0);
}
export function highRollerAuctions(auctions, now = Date.now()) {
    return auctions.filter(auction => ['active', 'completed'].includes(getAuctionStatus(auction, now))
        && highRollerValue(auction) >= HIGH_ROLLER_MIN_PRICE)
        .sort((a, b) => {
            const aSoon = auctionEndingSoon(a, now), bSoon = auctionEndingSoon(b, now);
            return Number(bSoon) - Number(aSoon) || (aSoon && bSoon ? a.endTime - b.endTime : 0)
                || highRollerValue(b) - highRollerValue(a) || String(a.id).localeCompare(String(b.id));
        });
}
