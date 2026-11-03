import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAuctionableItem, validTradeableItems } from '../src/lib/itemCatalog.js';

export async function buildItemCatalog(directory) {
    const items = JSON.parse(await readFile(new URL('../src/data/items.json', import.meta.url), 'utf8')).filter(isAuctionableItem);
    if (!validTradeableItems(items)) throw new Error('Invalid public item catalogue');
    const payload = JSON.stringify({ ready: true, items });
    const version = createHash('sha256').update(payload).digest('hex');
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/items-${version}.json`, payload);
    await writeFile(`${directory}/manifest.json`, JSON.stringify({ version, url: `/catalog/items-${version}.json` }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildItemCatalog(fileURLToPath(new URL('../build/catalog', import.meta.url)));
