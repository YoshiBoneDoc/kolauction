import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { fetchItemCatalog } from './lib/item-catalog.mjs';

const root = new URL('../', import.meta.url);
async function save(path, text) {
    const target = new URL(path, root);
    await mkdir(new URL('.', target), { recursive: true });
    const temporary = new URL(`${target.href}.tmp`);
    await writeFile(temporary, text);
    await rename(temporary, target);
}
const snapshot = await fetchItemCatalog();
const items = snapshot.items.filter(item => (item.tradeable || item.giftable) && !item.is_gift_package);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
await save('src/data/items.json', json(items));
const metadata = { source: snapshot.source, fetched_at: snapshot.fetched_at, sha256: snapshot.sha256, known_items: snapshot.items.length,
    tradeable_items: snapshot.items.filter(item => item.tradeable).length,
    gift_only_items: items.filter(item => !item.tradeable).length, auctionable_items: items.length };
await save('src/data/items.meta.json', json(metadata));
if (await stat(new URL('bot/', root)).catch(() => null)) {
    await save('bot/catalog/items.json', json(snapshot.items));
    await save('bot/catalog/items.meta.json', json(metadata));
    await save('bot/src/item-catalog-source.mjs', await readFile(new URL('scripts/lib/item-catalog.mjs', root), 'utf8'));
}
console.log(`Updated ${snapshot.items.length} known items; ${items.length} items available for auctions, including ${metadata.gift_only_items} gift-only collectibles. Gift packages excluded. Source: ${snapshot.source}`);
