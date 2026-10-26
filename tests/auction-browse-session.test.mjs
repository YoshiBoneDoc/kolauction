import test from 'node:test';
import assert from 'node:assert/strict';
import { AUCTION_BROWSE_SESSION_KEY, normalizeAuctionBrowseParams, readAuctionBrowseSession,
    writeAuctionBrowseSession, restoreAuctionBrowseParams, persistAuctionBrowseParams, clampAuctionPriceParams } from '../src/lib/auctionBrowseSession.js';

function memoryStorage() {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), clear: () => values.clear() };
}
const preferences = 'q=chrome+stick&status=completed&sort=price-desc&trade=escrow&kind=buy&mine=others&minPrice=500&maxPrice=1000000&page=3';

test('session preferences preserve every browse control, while a new tab session starts fresh', () => {
    const storage = memoryStorage();
    writeAuctionBrowseSession(preferences, preferences, storage);
    const saved = readAuctionBrowseSession(storage);
    assert.equal(saved.params, preferences);
    assert.equal(restoreAuctionBrowseParams('', saved).toString(), preferences);
    assert.equal(restoreAuctionBrowseParams(preferences, saved, true).toString(), preferences);
    assert.equal(restoreAuctionBrowseParams('', readAuctionBrowseSession(memoryStorage())).toString(), '');
    // A restored browser-history entry from an expired session must reset too.
    assert.equal(restoreAuctionBrowseParams(preferences, null, true).toString(), '');
});

test('explicit links and Back entries preserve their URL, including an earlier defaults entry', () => {
    const storage = memoryStorage();
    writeAuctionBrowseSession(preferences, preferences, storage);
    const saved = readAuctionBrowseSession(storage);
    assert.equal(restoreAuctionBrowseParams('?status=expired', saved).get('status'), 'expired');
    assert.equal(restoreAuctionBrowseParams('?q=older&sort=newest', saved, true).get('q'), 'older');
    assert.equal(restoreAuctionBrowseParams('', saved, true).toString(), '');
});

test('unfinished searches survive navigation, refresh and unrelated sort changes before debounce', () => {
    const storage = memoryStorage();
    writeAuctionBrowseSession('q=unfinished&status=completed', 'q=old&status=completed', storage);
    assert.equal(restoreAuctionBrowseParams('q=old&status=completed', readAuctionBrowseSession(storage), true).get('q'), 'unfinished');
    persistAuctionBrowseParams('q=old&status=completed&sort=price-desc', storage);
    const saved = readAuctionBrowseSession(storage);
    assert.equal(new URLSearchParams(saved.params).get('q'), 'unfinished');
    assert.equal(new URLSearchParams(saved.params).get('sort'), 'price-desc');
    persistAuctionBrowseParams('q=unfinished&status=completed&sort=price-desc', storage);
    assert.equal(readAuctionBrowseSession(storage).params, readAuctionBrowseSession(storage).source);
    writeAuctionBrowseSession('status=completed', 'q=unfinished&status=completed', storage);
    assert.equal(restoreAuctionBrowseParams('q=unfinished&status=completed', readAuctionBrowseSession(storage), true).has('q'), false);
});

test('clearing the saved session prevents earlier pending searches or filters from returning', () => {
    const storage = memoryStorage();
    writeAuctionBrowseSession(preferences, preferences, storage);
    writeAuctionBrowseSession('', '', storage);
    persistAuctionBrowseParams('', storage);
    assert.equal(restoreAuctionBrowseParams('', readAuctionBrowseSession(storage)).toString(), '');
});

test('saved ranges clamp to changed global bounds without storing stale endpoints or page numbers', () => {
    assert.equal(clampAuctionPriceParams('q=hat&minPrice=50&maxPrice=9000&page=4', { min: 100, max: 5000 }).toString(), 'q=hat');
    assert.equal(clampAuctionPriceParams('minPrice=9000&maxPrice=10000&page=3', { min: 100, max: 5000 }).toString(), 'minPrice=5000');
    assert.equal(clampAuctionPriceParams('minPrice=1&maxPrice=50', { min: 100, max: 5000 }).toString(), 'maxPrice=100');
    assert.equal(clampAuctionPriceParams('minPrice=200&maxPrice=400&page=2', { min: 100, max: 5000 }).toString(), 'minPrice=200&maxPrice=400&page=2');
});

test('corrupt, unsupported and blocked storage cannot break browsing', () => {
    const storage = memoryStorage();
    storage.setItem(AUCTION_BROWSE_SESSION_KEY, 'bad json'); assert.equal(readAuctionBrowseSession(storage), null);
    storage.setItem(AUCTION_BROWSE_SESSION_KEY, JSON.stringify({ version: 2, params: preferences, source: preferences })); assert.equal(readAuctionBrowseSession(storage), null);
    const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
    assert.equal(readAuctionBrowseSession(blocked), null);
    assert.doesNotThrow(() => writeAuctionBrowseSession(preferences, preferences, blocked));
    assert.equal(normalizeAuctionBrowseParams('status=bad&sort=bad&minPrice=-1&maxPrice=NaN&mine=other&panel=open&page=0').toString(), '');
});
