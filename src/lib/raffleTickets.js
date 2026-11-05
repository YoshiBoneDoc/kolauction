const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export function formatRaffleTickets(count) {
    if (typeof count === 'string' && /^(0|[1-9][0-9]*)$/.test(count)) return compact.format(BigInt(count)).toLowerCase();
    return compact.format(Number.isSafeInteger(count) && count >= 0 ? count : 0).toLowerCase();
}
