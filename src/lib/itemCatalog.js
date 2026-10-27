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

// One public reference-data read per five minutes, shared across page mounts.
// A failed read uses the checked-in auctionable snapshot; server validation remains
// authoritative if an item's eligibility has changed since that snapshot.
export function createItemCatalogService(client, fallback, now = Date.now) {
    let cached = fallback;
    let expires = 0;
    let loading;
    return {
        async load() {
            if (!client || now() < expires) return cached;
            if (loading) return loading;
            loading = (async () => {
                try {
                    const { data, error } = await client.rpc('read_item_catalog');
                    if (!error && data?.ready === true && validTradeableItems(data.items)) {
                        cached = data.items;
                        expires = now() + 5 * 60 * 1000;
                    } else expires = now() + 30000;
                } catch { expires = now() + 30000; }
                return cached;
            })().finally(() => { loading = null; });
            return loading;
        },
    };
}
