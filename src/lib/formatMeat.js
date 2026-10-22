// Display-only shorthand; keep saved amounts and transaction confirmations exact.
// BigInt also preserves seller totals that exceed JavaScript's safe Number range.
function formatMeatRatio(value, quantity = 1) {
    const count = BigInt(quantity);
    const amount = BigInt(value ?? 0);
    const negative = amount < 0n;
    const magnitude = negative ? -amount : amount;
    const units = [{ divisor: 1n, suffix: '' }, { divisor: 1000n, suffix: 'k' },
        { divisor: 1000000n, suffix: 'm' }, { divisor: 1000000000n, suffix: 'b' }];
    let index = units.length - 1;
    while (index > 0 && magnitude < units[index].divisor * count) --index;
    if (!index) {
        if (count === 1n) return amount.toLocaleString('en-US');
        const hundredths = (magnitude * 100n + count / 2n) / count;
        if (magnitude > 0n && hundredths === 0n) return '<0.01';
        const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
        return `${negative ? '-' : ''}${(hundredths / 100n).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
    }
    let tenths = (magnitude * 10n + units[index].divisor * count / 2n) / (units[index].divisor * count);
    if (tenths >= 10000n && index < units.length - 1) {
        ++index;
        tenths = (magnitude * 10n + units[index].divisor * count / 2n) / (units[index].divisor * count);
    }
    const fraction = tenths % 10n;
    return `${negative ? '-' : ''}${(tenths / 10n).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}${units[index].suffix}`;
}

export function formatCompactMeat(value) {
    return formatMeatRatio(value);
}

export function formatPerItemMeat(value, quantity) {
    return formatMeatRatio(value, quantity);
}
