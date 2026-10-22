export const BID_INCREMENT_TIERS = [
    { below: 1000, increment: 10, label: 'Below 1k', display: '10 Meat', roundingDisplay: '—' },
    { below: 10000, increment: 100, label: '1k–under 10k', display: '100 Meat', roundingDisplay: '—' },
    { below: 100000, increment: 1000, label: '10k–under 100k', display: '1k', roundingDisplay: '—' },
    { below: 1000000, increment: 10000, label: '100k–under 1M', display: '10k', roundingDisplay: '—' },
    { below: 10000000, basisPoints: 300, roundingUnit: 10000, label: '1M–under 10M', display: '3%', roundingDisplay: '10k' },
    { below: 100000000, basisPoints: 200, roundingUnit: 100000, label: '10M–under 100M', display: '2%', roundingDisplay: '100k' },
    { below: 10000000000, basisPoints: 100, roundingUnit: 500000, label: '100M–under 10B', display: '1%', roundingDisplay: '500k' },
    { below: Infinity, basisPoints: 50, roundingUnit: 500000, label: '10B and above', display: '0.5%', roundingDisplay: '500k' },
];

export function bidIncrement(currentBid) {
    if (!Number.isSafeInteger(currentBid) || currentBid < 0) throw new Error('Invalid current bid.');
    const tier = BID_INCREMENT_TIERS.find(entry => currentBid < entry.below);
    if (tier.increment !== undefined) return tier.increment;
    // ceil(current × basis points / (10,000 × unit)) × unit, entirely in integers.
    const unit = BigInt(tier.roundingUnit);
    const numerator = BigInt(currentBid) * BigInt(tier.basisPoints);
    const denominator = 10000n * unit;
    return Number(((numerator + denominator - 1n) / denominator) * unit);
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
