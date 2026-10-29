import { isAuctionableItem, itemImageUrl } from './itemCatalog.js';
import { parseAuctionAmount } from './auctionInputs.js';

export const MAX_BUNDLE_ITEMS = 10;
export const MAX_BUNDLE_TITLE_LENGTH = 100;
export function normalizeBundleTitle(value = '') {
    // Reject control characters deliberately; these names also reach terminal logs.
    // eslint-disable-next-line no-control-regex
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069<>]/u.test(value)
        || [...value.trim()].length > MAX_BUNDLE_TITLE_LENGTH) {
        throw new Error('Bundle title must be 100 characters or fewer and use plain text on one line.');
    }
    return value.trim();
}
export function prepareBundle(entries, catalog) {
    if (!Array.isArray(entries) || entries.length < 2 || entries.length > MAX_BUNDLE_ITEMS) throw new Error('Choose 2 to 10 different items for the bundle.');
    const seen = new Set();
    return entries.map(entry => {
        const item = catalog.find(candidate => String(candidate.id) === String(entry.id) && isAuctionableItem(candidate));
        if (!item) throw new Error('Choose current tradeable or giftable items for the bundle.');
        if (seen.has(item.id)) throw new Error('Each item can appear only once. Adjust its quantity instead.');
        seen.add(item.id);
        const quantity = parseAuctionAmount(String(entry.quantity), 5000000000);
        if (quantity === null) throw new Error('Every bundle quantity must be a whole number between 1 and 5 billion.');
        return { id: item.id, quantity, name: item.name, image: itemImageUrl(item.image) };
    }).sort((a, b) => a.id - b.id);
}
export function bundleTitle(entries, title = '') {
    return (normalizeBundleTitle(title) ? `Bundle: ${normalizeBundleTitle(title)}` : '') || `Bundle: ${entries[0].name.slice(0, 140)} + ${entries.length - 1} more item types`;
}

export function bundleConfirmation(auction) {
    return auction.isBundle && auction.bundleItems?.length
        ? `\n\nEntire bundle:\n${auction.bundleItems.map(item => `${Number(item.quantity).toLocaleString('en-US')} × ${item.name}`).join('\n')}`
        : '';
}

// Display total components without changing the lot quantity used for bidding.
export function auctionQuantityLabel(auction) {
    if (auction.bundleItems?.length > 1) {
        const total = auction.bundleItems.reduce((sum, item) => sum + Number(item.quantity), 0);
        return `(${total.toLocaleString('en-US')} items)`;
    }
    return `×${Number(auction.quantity).toLocaleString('en-US')}`;
}

export function bundleCover(entries, selectedId, prices = new Map()) {
    const explicit = entries.find(item => String(item.id) === String(selectedId));
    if (explicit) return explicit;
    return [...entries].sort((a, b) => {
        const price = item => prices.get(Number(item.id))?.available ? Number(prices.get(Number(item.id)).price_meat) || 0 : 0;
        return price(b) - price(a) || Number(a.id) - Number(b.id);
    })[0];
}
