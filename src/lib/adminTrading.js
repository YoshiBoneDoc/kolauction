export function percentage(part, total) {
    const denominator = BigInt(total);
    if (denominator === 0n) return '—';
    const hundredths = (BigInt(part) * 10000n + denominator / 2n) / denominator;
    return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`;
}
export function tradingRows(transactions) {
    return [['sell','escrow'],['sell','direct'],['buy','escrow'],['bundle','escrow'],['bundle','direct']].map(([kind,method]) => ({ kind,method,count:'0',meat:'0',fees:'0', ...transactions.breakdown.find(row => row.kind===kind && row.method===method) }));
}
export function tradingTotal(rows) {
    return rows.reduce((sum,row) => ({count:sum.count+BigInt(row.count),meat:sum.meat+BigInt(row.meat),fees:sum.fees+BigInt(row.fees)}),{count:0n,meat:0n,fees:0n});
}

export function compactMeat(value) {
    const amount = BigInt(value);
    for (const [scale, suffix] of [[1000000000000n,'t'],[1000000000n,'b'],[1000000n,'m'],[1000n,'k']]) {
        if (amount >= scale) {
            const hundredths = amount * 100n / scale;
            return `${hundredths / 100n}${hundredths % 100n ? '.' + String(hundredths % 100n).padStart(2,'0').replace(/0$/, '') : ''}${suffix}`;
        }
    }
    return amount.toLocaleString('en-US');
}
