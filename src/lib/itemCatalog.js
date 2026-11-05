import { decodeItemName } from '../../scripts/lib/item-name.mjs';
const decoded = items => items?.some(item => decodeItemName(item.name) !== item.name) ? items.map(item => ({ ...item, name: decodeItemName(item.name) })) : items;
const imagePath = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.gif$/;

export function itemImageUrl(image) {
    if (typeof image !== 'string' || !imagePath.test(image)) return '';
    return `https://images.kingdomofloathing.com/${image.includes('/') ? image : `itemimages/${image}`}`;
}

export function validTradeableItems(items) {
    if (!Array.isArray(items) || !items.length || items.length > 50000) return false;
    const ids = new Set();
    return items.every(item => {
        if (!Number.isSafeInteger(item.id) || item.id <= 0 || ids.has(item.id) || !isAuctionableItem(item)
            || typeof item.tradeable !== 'boolean'
            || (item.giftable !== undefined && typeof item.giftable !== 'boolean')
            || (item.is_gift_package !== undefined && typeof item.is_gift_package !== 'boolean')
            || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 128 || !itemImageUrl(item.image)) return false;
        ids.add(item.id);
        return true;
    });
}

export function isAuctionableItem(item) {
    return (item.tradeable === true || item.giftable === true) && item.is_gift_package !== true;
}

// Versioned static reference data; only the small manifest revalidates every five minutes.
// A failed read uses the checked-in auctionable snapshot; server validation remains
// authoritative if an item's eligibility has changed since that snapshot.
export function createItemCatalogService(client, fallback, now = Date.now, fetcher = globalThis.fetch) {
    let cached = typeof fallback === 'function' ? null : decoded(fallback);
    let expires = 0;
    let loading;
    let version;
    return {
        async load() {
            if (now() < expires) return cached;
            if (loading) return loading;
            loading = (async () => {
                try {
                    const manifestResponse = await fetcher('/api/item-catalog', { cache: 'no-cache', signal: AbortSignal.timeout(5000) });
                    if (!manifestResponse.ok) throw new Error('Catalogue manifest unavailable');
                    const manifest = await manifestResponse.json();
                    if (!/^[a-f0-9]{64}$/.test(manifest.version) || ![`/catalog/items-${manifest.version}.json`, `/api/item-catalog?version=${manifest.version}`].includes(manifest.url)) throw new Error('Invalid catalogue manifest');
                    if (manifest.version === version) { expires = now() + 300000; return cached; }
                    const response = await fetcher(manifest.url, { cache: 'force-cache', signal: AbortSignal.timeout(5000) });
                    if (!response.ok) throw new Error('Catalogue unavailable');
                    const data = await response.json();
                    if (data?.ready === true && validTradeableItems(data.items)) {
                        cached = decoded(data.items);
                        version = manifest.version;
                        expires = now() + 5 * 60 * 1000;
                    } else throw new Error('Invalid catalogue items');
                } catch {
                    expires = now() + 30000;
                    if (!cached?.length && typeof fallback === 'function') {
                        try { cached = decoded(await fallback()); } catch { cached = []; }
                    }
                }
                return cached;
            })().finally(() => { loading = null; });
            return loading;
        },
    };
}
