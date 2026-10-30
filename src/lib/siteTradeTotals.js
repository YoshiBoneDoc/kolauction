// Exact decimal strings only; totals can exceed JavaScript's safe integer range.
export function parseSiteTradeTotals(value) {
    if (!value || typeof value !== 'object') return null;
    const entries = ['meat', 'items', 'trades'].map(key => [key, value[key]]);
    if (entries.some(([, amount]) => typeof amount !== 'string' || !/^\d{1,40}$/.test(amount))) return null;
    // Older deployed snapshots remain valid while migration/cache rollout runs.
    if (typeof value.record_bids === 'string' && /^\d{1,40}$/.test(value.record_bids)) {
        entries.push(['record_bids', value.record_bids]);
    }
    return Object.fromEntries(entries);
}

export function formatSiteMeat(value) {
    const amount = BigInt(value);
    for (const [unit, suffix] of [[1000000000n, 'b'], [1000000n, 'm'], [1000n, 'k']]) {
        if (amount < unit) continue;
        const rounded = (amount * 100n + unit / 2n) / unit;
        const decimals = String(rounded % 100n).padStart(2, '0').replace(/0+$/, '');
        return `${(rounded / 100n).toLocaleString('en-US')}${decimals ? `.${decimals}` : ''}${suffix}`;
    }
    return amount.toLocaleString('en-US');
}
