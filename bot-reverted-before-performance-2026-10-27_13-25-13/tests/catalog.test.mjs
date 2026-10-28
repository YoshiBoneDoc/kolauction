import test from 'node:test';
import assert from 'node:assert/strict';
import { readCatalog } from '../src/catalog.mjs';

test('catalog is bundled inside the standalone bot and contains unique item IDs', async () => {
    const items = await readCatalog();
    assert.ok(items.length > 10000);
    assert.equal(new Set(items.map(item => item.id)).size, items.length);
    assert.ok(items.every(item => Number.isInteger(item.id) && item.id > 0 && typeof item.name === 'string' && item.name.length > 0));
});
