import { ESCROW_FEE_TIERS } from './escrowFees.js';

export const MAX_BUY_ORDER_MEAT = 20_000_000_000;

// Mirror SQL exactly: preserve fractional per-item commission, then round only
// after multiplying by the quantity in this fulfillment.
export function buyFee(price, quantity, reserve = false) {
    if (!Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Enter a positive whole price per item and quantity.');
    const total = BigInt(price);
    let previous = 0n, numerator = 0n;
    for (const tier of ESCROW_FEE_TIERS) {
        const upper = tier.upTo === null ? total : BigInt(tier.upTo);
        const end = total < upper ? total : upper;
        if (end > previous) numerator += (end - previous) * BigInt(tier.bps);
        if (total <= upper) break;
        previous = upper;
    }
    return (numerator * BigInt(quantity) + (reserve ? 9999n : 0n)) / 10000n;
}

export function buyFunding(price, quantity) {
    const feeReserve = buyFee(price, quantity, true);
    const purchase = BigInt(price) * BigInt(quantity);
    const total = purchase + feeReserve;
    if (total > BigInt(MAX_BUY_ORDER_MEAT)) throw new Error('A buy order including its fee reserve cannot exceed 20 billion Meat.');
    return { purchase: Number(purchase), feeReserve: Number(feeReserve), total: Number(total) };
}
