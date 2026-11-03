import test from 'node:test';
import assert from 'node:assert/strict';
import { withReadDeadline } from '../src/lib/readDeadline.js';
test('deadline bounds a stalled read and aborts its transport', async () => {
    let transport;
    await assert.rejects(withReadDeadline(signal => {
        transport = signal;
        return new Promise(() => {});
    }, { milliseconds: 10 }), { code: 'KHUB_READ_TIMEOUT' });
    assert.equal(transport.aborted, true);
});
test('caller cancellation preserves its reason and prevents an already cancelled read', async () => {
    const controller = new AbortController();
    const reason = new Error('navigation');
    controller.abort(reason);
    await assert.rejects(withReadDeadline(() => assert.fail('must not start'), { signal: controller.signal }), reason);
});
test('successful reads return their result', async () => {
    assert.equal(await withReadDeadline(async () => 42), 42);
});

test('a stalled pending-trade read releases the serialized queue for detail loading', async () => {
    const { createAuctionService } = await import('../src/lib/auctions.js');
    const { createAuctionReadCache } = await import('../src/lib/auctionReadCache.js');
    let pendingSignal;
    const service = createAuctionService({ rpc(name) {
        if (name === 'read_pending_trades') return {
            abortSignal(signal) { pendingSignal = signal; return this; },
            then() { /* Simulate a transport which never settles, even on abort. */ },
        };
        return Promise.resolve({ data: { privacy_version: 1, rows: [], bids: [], total: 0 } });
    } }, { readDeadlineMs: 10 });
    const cache = createAuctionReadCache((key, signal) => key === 'pending'
        ? service.pendingTrades(1, { signal }) : service.load({ view: 'detail', id: 'fixture', signal }));
    const pending = cache.load('pending');
    const detail = cache.load('detail');
    await Promise.all([pending, detail]);
    assert.equal(pendingSignal.aborted, true);
    assert.match(cache.snapshot('pending').error, /taking too long/);
    assert.equal(cache.snapshot('pending').refreshing, false);
    assert.equal(cache.snapshot('detail').error, '');
    assert.deepEqual(cache.snapshot('detail').data.auctions, []);
});
