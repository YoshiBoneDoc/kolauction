import { readFile } from 'node:fs/promises';

export async function readCatalog() {
    return JSON.parse(await readFile(new URL('../catalog/items.json', import.meta.url), 'utf8'));
}
