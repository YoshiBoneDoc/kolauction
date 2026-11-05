// Display-only shorthand; keep saved amounts and transaction confirmations exact.
// BigInt also preserves seller totals that exceed JavaScript's safe Number range.
function formatMeatRatio(value, quantity = 1, fractionDigits = 1) {
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
    const scale = 10n ** BigInt(fractionDigits);
    let tenths = (magnitude * scale + units[index].divisor * count / 2n) / (units[index].divisor * count);
    if (tenths >= 1000n * scale && index < units.length - 1) {
        ++index;
        tenths = (magnitude * scale + units[index].divisor * count / 2n) / (units[index].divisor * count);
    }
    const fraction = (tenths % scale).toString().padStart(fractionDigits, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${(tenths / scale).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}${units[index].suffix}`;
}

export function formatCompactMeat(value, fractionDigits = 1) {
    return formatMeatRatio(value, 1, fractionDigits);
}

export function formatPerItemMeat(value, quantity) {
    return formatMeatRatio(value, quantity);
}
