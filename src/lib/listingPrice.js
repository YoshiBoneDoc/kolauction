import { parseMeatAmount, parseAuctionAmount } from './auctionInputs.js';

// Keep the entered side untouched; use integer arithmetic for the derived side.
export function listingPrice(value, side, quantity, canonicalSide) {
    const fields = { whole: '', item: '', message: '', canonical: '' };
    fields[side] = value;
    const price = parseMeatAmount(value);
    const count = parseAuctionAmount(quantity, 5000000000);
    if (side === canonicalSide) fields.canonical = value;
    if (price === null || count === null) return fields;
    const amount = BigInt(price);
    const units = BigInt(count);
    if (side === 'whole' && amount % units !== 0n) {
        fields.message = `This total is not divisible by the quantity into whole Meat per item.${canonicalSide === 'item' ? ' Enter a divisible total or a whole per-item price.' : ' The whole-listing price will be used unchanged.'}`;
        return fields;
    }
    const derived = side === 'whole' ? amount / units : amount * units;
    const other = side === 'whole' ? 'item' : 'whole';
    fields[other] = derived.toLocaleString('en-US');
    if (other === canonicalSide && derived <= BigInt(Number.MAX_SAFE_INTEGER)) fields.canonical = String(derived);
    if (derived > BigInt(Number.MAX_SAFE_INTEGER) && other === canonicalSide) fields.message = 'The calculated price exceeds the supported Meat limit.';
    return fields;
}
