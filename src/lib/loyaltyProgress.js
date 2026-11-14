import { loyaltyTiers } from './loyaltyPreview.js';
import { withReadDeadline } from './readDeadline.js';

export function parseLoyaltySales(data) {
    const value = data?.completed_escrow_sales_meat;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Your sales progress could not be verified.');
    return BigInt(value);
}

export async function readLoyaltySales(client, signal) {
    if (!client) throw new Error('Sales progress is temporarily unavailable.');
    return withReadDeadline(async abort => {
        let request = client.rpc('read_my_loyalty_progress');
        if (request.abortSignal) request = request.abortSignal(abort);
        const { data, error } = await request;
        if (error) throw new Error('Your sales progress could not be loaded. Please retry.');
        return parseLoyaltySales(data);
    }, { signal });
}

export function loyaltyProgress(sales) {
    if (typeof sales !== 'bigint' || sales < 0n) throw new Error('Invalid sales total.');
    let earnedIndex = 0;
    for (let i = 1; i < loyaltyTiers.length; i++) if (sales >= BigInt(loyaltyTiers[i].minimum)) earnedIndex = i;
    const next = loyaltyTiers[earnedIndex + 1];
    const fills = loyaltyTiers.map((tier, index) => {
        if (index === 0) return 100;
        const from = BigInt(loyaltyTiers[index - 1].minimum);
        const until = BigInt(tier.minimum);
        return sales >= until ? 100 : sales <= from ? 0 : Number((sales - from) * 10000n / (until - from)) / 100;
    });
    return { earnedIndex, fills, next, remaining: next ? BigInt(next.minimum) - sales : 0n };
}
export const compactLoyaltyMeat = value => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
