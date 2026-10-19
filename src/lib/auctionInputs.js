// Accept full amounts and optional k/m/b shorthand without silently changing
// invalid input or capping a larger intended bid to a different amount.
export function parseAuctionAmount(value, maximum) {
    const match = String(value).trim().replace(/,/g, '').match(/^(\d+)([kmb]?)$/i);
    if (!match) return null;
    const multiplier = { k: 1000, m: 1000000, b: 1000000000 }[match[2].toLowerCase()] || 1;
    const amount = Number(match[1]) * multiplier;
    return Number.isSafeInteger(amount) && amount > 0 && amount <= maximum ? amount : null;
}
