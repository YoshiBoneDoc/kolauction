import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAuctionQueue, rotateAuctionQueue } from '../src/lib/auctionCarousel.js';

test('a full rightward lap shows each auction exactly once before repeating without cloning cards', () => {
    const ids = Array.from({ length: 31 }, (_, i) => `auction-${i}`);
    let queue = rotateAuctionQueue(ids);
    const incoming = [];
    for (let i = 0; i < ids.length; i++) {
        assert.equal(new Set(queue).size, ids.length);
        incoming.push(queue[0]); queue = rotateAuctionQueue(queue);
    }
    assert.equal(new Set(incoming).size, ids.length);
    assert.equal(queue[0], incoming[0]);
});

test('live popularity changes do not restart a lap; new and expired listings reconcile without duplicates', () => {
    const current = ['a', 'b', 'c', 'd', 'e', 'f'];
    let queue = rotateAuctionQueue(current);
    queue = rotateAuctionQueue(queue);
    assert.deepEqual(reconcileAuctionQueue(queue, [...current].reverse()), queue);
    const updated = reconcileAuctionQueue(queue, ['g', 'e', 'd', 'c', 'a']);
    assert.deepEqual(updated, queue.filter(id => !['b','f'].includes(id)).concat('g'));
    assert.equal(rotateAuctionQueue(updated)[0], 'g');
    assert.deepEqual(reconcileAuctionQueue(['a','a','removed'], ['b','b','a']), ['a','b']);
    assert.deepEqual(rotateAuctionQueue([]), []);
    assert.deepEqual(rotateAuctionQueue(['only']), ['only']);
});

import { CAROUSEL_POSITION_KEY, readCarouselPosition, saveCarouselPosition } from '../src/lib/auctionCarousel.js';

test('carousel position preserves card order, partial scroll progress and pause preference within the tab', () => {
    const memory = new Map();
    const storage = { getItem: key => memory.get(key) ?? null, setItem: (key,value) => memory.set(key,value) };
    const position = { order: ['c','a','b'], elapsed: 4275.5, paused: true };
    saveCarouselPosition(storage, position);
    assert.deepEqual(readCarouselPosition(storage), position);
    assert.deepEqual(reconcileAuctionQueue(readCarouselPosition(storage).order, ['b','c','d']), ['c','b','d']);
    for (const invalid of ['not JSON', '{}', JSON.stringify({ ...position, elapsed: 9000 }), JSON.stringify({ ...position, order: [4] })]) {
        memory.set(CAROUSEL_POSITION_KEY, invalid);
        assert.equal(readCarouselPosition(storage), null);
    }
    const blocked = { getItem() { throw Error('Blocked'); }, setItem() { throw Error('Full'); } };
    assert.equal(readCarouselPosition(blocked), null);
    assert.doesNotThrow(() => saveCarouselPosition(blocked, position));
});
