import { isAuctionableItem, itemImageUrl } from './itemCatalog.js';
import { parseAuctionAmount } from './auctionInputs.js';

export const MAX_BUNDLE_ITEMS = 10;
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
export function bundleTitle(entries) {
    return `Bundle: ${entries[0].name.slice(0, 140)} + ${entries.length - 1} more item types`;
}

export function bundleConfirmation(auction) {
    return auction.isBundle && auction.bundleItems?.length
        ? `\n\nEntire bundle:\n${auction.bundleItems.map(item => `${Number(item.quantity).toLocaleString('en-US')} × ${item.name}`).join('\n')}`
        : '';
}
