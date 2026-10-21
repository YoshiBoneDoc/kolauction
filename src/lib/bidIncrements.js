export const BID_INCREMENT_TIERS = [
    { below: 1000, increment: 10, label: 'Below 1k', display: '10 Meat' },
    { below: 10000, increment: 100, label: '1k–under 10k', display: '100 Meat' },
    { below: 100000, increment: 1000, label: '10k–under 100k', display: '1k' },
    { below: 1000000, increment: 10000, label: '100k–under 1m', display: '10k' },
    { below: 10000000, increment: 100000, label: '1m–under 10m', display: '100k' },
    { below: 100000000, increment: 1000000, label: '10m–under 100m', display: '1m' },
    { below: 1000000000, increment: 10000000, label: '100m–under 1b', display: '10m' },
    { below: 10000000000, increment: 100000000, label: '1b–under 10b', display: '100m' },
    { below: Infinity, increment: null, label: '10b and above', display: '1% (rounded up)' },
];

export function bidIncrement(currentBid) {
    if (!Number.isSafeInteger(currentBid) || currentBid < 0) throw new Error('Invalid current bid.');
    const tier = BID_INCREMENT_TIERS.find(entry => currentBid < entry.below);
    return tier.increment ?? Number((BigInt(currentBid) + 99n) / 100n);
}

// A buyout can be lower than the ordinary next bid. Showing it as the minimum
// lets both typed bids and funded KMail still accept that exact buyout price.
export function minimumAuctionBid({ minBidMeat, currentBid = 0, instantPurchasePrice }) {
    if (!Number.isSafeInteger(minBidMeat) || minBidMeat < 1) throw new Error('Invalid minimum bid.');
    if (!Number.isSafeInteger(currentBid) || currentBid < 0) throw new Error('Invalid current bid.');
    let minimum = BigInt(minBidMeat);
    if (currentBid > 0) {
        const raised = BigInt(currentBid) + BigInt(bidIncrement(currentBid));
        if (raised > minimum) minimum = raised;
    }
    if (Number.isSafeInteger(instantPurchasePrice) && instantPurchasePrice >= minBidMeat && instantPurchasePrice > currentBid && BigInt(instantPurchasePrice) < minimum) {
        minimum = BigInt(instantPurchasePrice);
    }
    return minimum <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minimum) : null;
}
