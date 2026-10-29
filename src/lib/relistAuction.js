import { bundleTitle } from './bundles.js';
import { getAuctionStatus } from './auctionLifecycle.js';

export function canRelist(auction, user, now = Date.now()) {
    return Boolean(user?.id && !user.isBanned && auction.sellerId === user.id
        && ['completed', 'expired', 'ended_no_bids', 'cancelled', 'voided'].includes(getAuctionStatus(auction, now)));
}

// Only listing terms are copied. No bids, financial records, or old deadlines.
export function relistDraft(auction) {
    const customHours = auction.customEndAt ? (Date.parse(auction.customEndAt) - auction.createdAt) / 3600000 : null;
    const hours = Math.max(1, Math.min(720, customHours > 0 ? customHours : Number(auction.auctionTime) || 24));
    return {
        kind: auction.bundleItems?.length > 1 ? 'bundle' : auction.auctionKind === 'buy' ? 'buy' : 'sell',
        itemId: String(auction.itemId), itemSearch: auction.item, quantity: String(auction.quantity),
        minimum: String(auction.auctionKind === 'buy' ? auction.pricePerItem : auction.minBidMeat),
        buyout: auction.instantPurchasePrice > 0 ? String(auction.instantPurchasePrice) : '',
        escrow: auction.escrowMode, hours,
        delivery: auction.deliveryMode || 'immediate',
        entries: (auction.bundleItems || []).map(({ id, quantity }) => ({ id, quantity: String(quantity) })),
        title: auction.bundleItems?.length > 1 ? (auction.item === bundleTitle(auction.bundleItems) ? '' : auction.item.replace(/^Bundle:\s*/, '')) : '',
        cover: auction.bundleItems?.find(item => item.image === auction.image)?.id ?? null,
    };
}

export function relistSnapshot(auction) {
    return Object.fromEntries(['id', 'sellerId', 'status', 'item', 'itemId', 'quantity', 'minBidMeat',
        'instantPurchasePrice', 'auctionTime', 'escrowMode', 'auctionKind', 'pricePerItem', 'deliveryMode',
        'createdAt', 'customEndAt', 'endTime', 'image', 'bundleItems'].map(key => [key, auction[key]]));
}
