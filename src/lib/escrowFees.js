export const ESCROW_FEE_POLICY = 'tiered_v1';
export const ESCROW_FEE_TIERS = [
    { upTo: 1_000_000, bps: 500, portion: 'First 1m', rate: '5%' },
    { upTo: 10_000_000, bps: 400, portion: '1m–10m', rate: '4%' },
    { upTo: 100_000_000, bps: 300, portion: '10m–100m', rate: '3%' },
    { upTo: 1_000_000_000, bps: 200, portion: '100m–1b', rate: '2%' },
    { upTo: null, bps: 100, portion: 'Above 1b', rate: '1%' },
];

// Display estimates only. PostgreSQL calculates the authoritative settlement fee.
// Keep every intermediate exact and round down only after summing all tiers.
export function escrowFee(price) {
    if (!Number.isSafeInteger(price) || price < 0) throw new Error('Invalid escrow sale price.');
    const total = BigInt(price);
    let previous = 0n, numerator = 0n;
    for (const tier of ESCROW_FEE_TIERS) {
        const upper = tier.upTo === null ? total : BigInt(tier.upTo);
        const end = total < upper ? total : upper;
        if (end > previous) numerator += (end - previous) * BigInt(tier.bps);
        if (total <= upper) break;
        previous = upper;
    }
    return Number(numerator / 10000n);
}
