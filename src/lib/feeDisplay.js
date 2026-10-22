// Exact display arithmetic; this never changes commission calculations.
// Show up to four decimal places, trim zeros, and never label a positive fee 0%.
export function effectiveFeePercent(fee, price) {
    const amount = BigInt(fee ?? 0), basis = BigInt(price ?? 0);
    if (amount < 0n || basis < 0n) throw new Error('Fee amounts must be nonnegative.');
    if (amount === 0n || basis === 0n) return '0%';
    const scaled = (amount * 1_000_000n + basis / 2n) / basis;
    if (scaled === 0n) return '<0.0001%';
    const fraction = String(scaled % 10000n).padStart(4, '0').replace(/0+$/, '');
    return `${scaled / 10000n}${fraction ? '.' + fraction : ''}%`;
}

export function feeLabel(fee, price, tiered = true) {
    return `${tiered ? 'Tiered Fee' : 'Fee'} (${effectiveFeePercent(fee, price)})`;
}
