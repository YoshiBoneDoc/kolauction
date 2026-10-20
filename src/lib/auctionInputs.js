// Expand and round as decimal digits, without floating-point rounding or capping.
function parseAmount(value, maximum) {
    const match = String(value).trim().replace(/,/g, '').match(/^(\d+)(?:\.(\d*))?([kmb]?)$/i);
    if (!match) return null;
    const places = { k: 3, m: 6, b: 9 }[match[3].toLowerCase()] || 0;
    const fraction = match[2] || '';
    const whole = Number(match[1] + fraction.slice(0, places).padEnd(places, '0'));
    const amount = whole + (fraction[places] >= '5' ? 1 : 0);
    return Number.isSafeInteger(amount) && amount >= 0 && amount <= maximum ? amount : null;
}

const withoutMeatUnit = value => String(value).trim().replace(/\s+meat$/i, '');

export function parseAuctionAmount(value, maximum = Number.MAX_SAFE_INTEGER) {
    const amount = parseAmount(value, maximum);
    return amount > 0 ? amount : null;
}

export function parseMeatAmount(value, maximum = Number.MAX_SAFE_INTEGER) {
    return parseAuctionAmount(withoutMeatUnit(value), maximum);
}

// Used on blur: incomplete/invalid input stays visible so the user can correct it.
export function normalizeAuctionAmount(value, { meat = false } = {}) {
    const amount = parseAmount(meat ? withoutMeatUnit(value) : value, Number.MAX_SAFE_INTEGER);
    return amount === null ? value : amount.toLocaleString('en-US');
}
