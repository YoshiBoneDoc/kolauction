import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseItemCatalog, validateCatalog, fetchItemCatalog, ITEM_SOURCE } from '../scripts/lib/item-catalog.mjs';
import { createItemCatalogService, itemImageUrl, validTradeableItems, isAuctionableItem } from '../src/lib/itemCatalog.js';

const header = '1\n# item number\tname\tdescid\timage\tuse\taccess\tautosell\tplural\n';
const entry = (id, access = 't,d', image = 'test.gif') => `${id}\tItem ${id}\t123456\t${image}\tnone\t${access}\t0`;
const small = { minimum: 1, minimumTradeable: 0 };
const fallback = [{ id: 2, name: 'seal tooth', image: 'tooth.gif', tradeable: true }];

test('KoLmafia parser distinguishes tradeable, quest, gift-only and discard-only items; reserved IDs stay excluded', () => {
    const parsed = parseItemCatalog(header + [entry(1), entry(2, 'q'), entry(3, 'g,d'), entry(4, 'd'), entry(5, ''), '6', entry(7, 't', 'otherimages/folders/folder01.gif')].join('\n'), small);
    assert.deepEqual(parsed.map(item => [item.id, item.tradeable]), [[1, true], [2, false], [3, false], [4, false], [5, false], [7, true]]);
    assert.equal(parsed.at(-1).image, 'otherimages/folders/folder01.gif');
    assert.equal(parsed.find(item => item.id === 3).giftable, true);
    assert.equal(isAuctionableItem(parsed.find(item => item.id === 3)), true);
    assert.equal(itemImageUrl(parsed.at(-1).image), 'https://images.kingdomofloathing.com/otherimages/folders/folder01.gif');
    assert.equal(itemImageUrl('tooth.gif'), 'https://images.kingdomofloathing.com/itemimages/tooth.gif');
    for (const path of ['../secret.gif', 'https://example.com/test.gif', 'x.gif?x=1', '']) assert.equal(itemImageUrl(path), '');
});

test('package metadata excludes gift containers without excluding collectible items named box or gift', () => {
    const parsed = parseItemCatalog(header + [
        '1167\tplain brown wrapper\t123456\tplainbrown.gif\tusable, package\tg\t0',
        '3949\tstuffed treasure chest\t123456\tstuffchest.gif\toffhand, usable\tg,d\t20',
        '4852\tgift-a-pult\t123456\tpapult.gif\tweapon\tg\t0',
    ].join('\n'), small);
    assert.equal(isAuctionableItem(parsed[0]), false);
    assert.equal(isAuctionableItem({ ...parsed[0], tradeable: true }), false);
    assert.ok(parsed.slice(1).every(isAuctionableItem));
    assert.equal(validTradeableItems(parsed), false);
    assert.equal(validTradeableItems(parsed.slice(1)), true);
    assert.throws(() => validateCatalog([{ ...fallback[0], giftable: 'true' }], small));
});

test('invalid, truncated, duplicate and unrecognized source data never becomes a catalog', () => {
    for (const text of ['<html>Error</html>', header + entry(1), header + entry(1) + '\n' + entry(1)]) assert.throws(() => parseItemCatalog(text));
    assert.throws(() => parseItemCatalog(header + entry(1, 'surprise'), small), /access flag/);
    assert.throws(() => parseItemCatalog(header + entry(1, 't', '../bad.gif'), small), /Invalid/);
    assert.throws(() => validateCatalog([{ ...fallback[0], tradeable: 'true' }], small), /Invalid/);
});

test('downloads validate the whole snapshot and record source provenance without fetching images', async () => {
    const text = header + Array.from({ length: 10000 }, (_, i) => entry(i + 1)).join('\n');
    let called;
    const result = await fetchItemCatalog({ fetchImpl: async (url, options) => { called = { url, options }; return new Response(text); }, now: () => new Date('2026-10-21T00:00:00Z') });
    assert.equal(called.url, ITEM_SOURCE);
    assert.equal(called.options.redirect, 'error');
    assert.equal(result.items.length, 10000);
    assert.equal(result.fetched_at, '2026-10-21T00:00:00.000Z');
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(fetchItemCatalog({ fetchImpl: async () => new Response('Unavailable', { status: 503 }) }), /download failed/);
});

test('website reads live tradeable items once per cache interval and receives new items without rebuilding', async () => {
    let now = 1, reads = 0;
    let items = [{ id: 12344, name: 'New item', image: 'new.gif', tradeable: true }];
    const service = createItemCatalogService({ async rpc(name) { assert.equal(name, 'read_item_catalog'); reads++; return { data: { ready: true, items } }; } }, fallback, () => now);
    const [first, second] = await Promise.all([service.load(), service.load()]);
    assert.deepEqual(first, items); assert.equal(second, first); assert.equal(reads, 1);
    items = [{ id: 12345, name: 'Next week item', image: 'next.gif', tradeable: true }];
    now += 300001;
    assert.deepEqual(await service.load(), items); assert.equal(reads, 2);
    assert.equal(validTradeableItems([{ ...items[0], tradeable: false }]), false);
    assert.equal(validTradeableItems([items[0], items[0]]), false);
});

test('website keeps its validated fallback after missing migrations, failures or unsafe item data, then retries', async () => {
    for (const result of [{ error: { message: 'Offline' } }, { data: { ready: false, items: [] } }, { data: { ready: true, items: [{ ...fallback[0], tradeable: false }] } }]) {
        const service = createItemCatalogService({ async rpc() { return result; } }, fallback);
        assert.equal(await service.load(), fallback);
    }
    let now = 1, calls = 0;
    const service = createItemCatalogService({ rpc() { calls++; throw new Error('Network'); } }, fallback, () => now);
    assert.equal(await service.load(), fallback);
    now += 30001;
    assert.equal(await service.load(), fallback); assert.equal(calls, 2);
});

test('bundled website catalog includes gift collectibles, excludes every package and keeps normal item/image data', async () => {
    const items = JSON.parse(await readFile(new URL('../src/data/items.json', import.meta.url), 'utf8'));
    assert.ok(items.length > 8000); assert.ok(validTradeableItems(items));
    assert.equal(items.find(item => item.id === 43), undefined);
    assert.equal(items.find(item => item.id === 26), undefined);
    assert.equal(items.find(item => item.id === 12344)?.image, 'potion30.gif');
    assert.equal(items.find(item => item.id === 6618)?.image, 'otherimages/folders/folder01.gif');
    for (const id of [3116,11494,1511,3948]) {
        assert.equal(items.find(item => item.id === id)?.giftable, true);
        assert.equal(items.find(item => item.id === id)?.tradeable, false);
    }
    const full = JSON.parse(await readFile(new URL('../bot/catalog/items.json', import.meta.url), 'utf8'));
    const packages = full.filter(item => item.is_gift_package);
    assert.ok(packages.length >= 21);
    assert.ok(packages.every(pack => !items.some(item => item.id === pack.id)));
});
