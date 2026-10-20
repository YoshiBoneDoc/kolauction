// Display-only shorthand; keep saved amounts and transaction confirmations exact.
// BigInt also preserves seller totals that exceed JavaScript's safe Number range.
export function formatCompactMeat(value) {
    const amount = BigInt(value ?? 0);
    const negative = amount < 0n;
    const magnitude = negative ? -amount : amount;
    const units = [{ divisor: 1n, suffix: '' }, { divisor: 1000n, suffix: 'k' },
        { divisor: 1000000n, suffix: 'm' }, { divisor: 1000000000n, suffix: 'b' }];
    let index = units.length - 1;
    while (index > 0 && magnitude < units[index].divisor) --index;
    if (!index) return amount.toLocaleString('en-US');
    let tenths = (magnitude * 10n + units[index].divisor / 2n) / units[index].divisor;
    if (tenths >= 10000n && index < units.length - 1) {
        ++index;
        tenths = (magnitude * 10n + units[index].divisor / 2n) / units[index].divisor;
    }
    const fraction = tenths % 10n;
    return `${negative ? '-' : ''}${(tenths / 10n).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}${units[index].suffix}`;
}
