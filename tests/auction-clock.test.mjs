import test from 'node:test';
import assert from 'node:assert/strict';
import {auctionNow,observeAuctionServerTime,subscribeAuctionClock} from '../src/lib/auctionClock.js';

test('auction time uses server samples, monotonic elapsed time and bounded request-delay compensation', t => {
    let monotonic=1000,wall=100000;
    t.mock.method(globalThis.performance,'now',()=>monotonic);
    t.mock.method(Date,'now',()=>wall);
    assert.equal(auctionNow(),wall);
    let changes=0;const unsubscribe=subscribeAuctionClock(()=>changes++);
    const server=Date.parse('2026-10-22T12:00:00Z');
    observeAuctionServerTime(new Date(server).toISOString(),800);
    assert.equal(auctionNow(),server+100);
    wall+=3600000;monotonic+=5000;
    assert.equal(auctionNow(),server+5100);assert.equal(changes,1);
    observeAuctionServerTime('not a date',5000);assert.equal(changes,1);
    observeAuctionServerTime(new Date(server-10000).toISOString(),700);assert.equal(changes,1);
    observeAuctionServerTime(new Date(server+5000).toISOString(),5900);assert.equal(changes,2);
    unsubscribe();
});
