export const MAX_MEAT = Number.MAX_SAFE_INTEGER;
export const PRICE_SLIDER_STEPS = 1000;

export function parsePrice(value) {
    if (value == null || value === '' || !/^\d+$/.test(String(value))) return null;
    const price = Number(value);
    return Number.isSafeInteger(price) && price >= 0 ? price : null;
}

export function auctionPrice(auction) {
    return auction.auctionKind === 'buy' ? auction.pricePerItem : auction.finalPrice ?? (auction.currentBid || auction.minBidMeat);
}

export function auctionFilterPrice(auction) {
    const price = Number(auctionPrice(auction));
    return Math.min(MAX_MEAT, Math.max(0, price > 0 ? price : Number(auction.marketValueMeat) || 0));
}

export function auctionPriceBounds(auctions) {
    let min = Infinity, max = 0;
    for (const auction of auctions) {
        // Owner/admin drafts can be authorized in a browse response, but must
        // not influence the public market bounds (same policy as the SQL reader).
        if (auction.status === 'pending_escrow') continue;
        const price = auctionFilterPrice(auction);
        const market = Math.min(MAX_MEAT, Math.max(0, Number(auction.marketValueMeat) || 0));
        min = Math.min(min, price, market > 0 ? market : price);
        max = Math.max(max, price, market);
    }
    return { min: Number.isFinite(min) ? min : 0, max };
}

export function priceToSlider(price, bounds) {
    const low = Math.log1p(bounds.min), high = Math.log1p(bounds.max);
    return high > low ? Math.max(0, Math.min(PRICE_SLIDER_STEPS,
        (Math.log1p(price) - low) / (high - low) * PRICE_SLIDER_STEPS)) : 0;
}

export function sliderToPrice(position, bounds) {
    if (position <= 0) return bounds.min;
    if (position >= PRICE_SLIDER_STEPS) return bounds.max;
    return Math.max(bounds.min, Math.min(bounds.max, Math.round(Math.expm1(
        Math.log1p(bounds.min) + position / PRICE_SLIDER_STEPS * (Math.log1p(bounds.max) - Math.log1p(bounds.min))))));
}
