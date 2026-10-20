export function reputationSummary(stats) {
    const keys = ['seller_positive', 'seller_negative', 'buyer_positive', 'buyer_negative'];
    if (keys.some(key => stats[key] == null)) return null;
    const seller = { positive: BigInt(stats.seller_positive), negative: BigInt(stats.seller_negative) };
    const buyer = { positive: BigInt(stats.buyer_positive), negative: BigInt(stats.buyer_negative) };
    const overall = { positive: seller.positive + buyer.positive, negative: seller.negative + buyer.negative };
    return { seller, buyer, overall };
}

export function reputationScore({ positive, negative }) {
    const score = positive - negative;
    return `${score > 0n ? '+' : ''}${score.toLocaleString('en-US')}`;
}
