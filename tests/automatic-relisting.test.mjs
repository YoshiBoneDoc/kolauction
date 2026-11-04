import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuctionService } from '../src/lib/auctions.js';

test('relisting is enrolled atomically for single items and bundles', async () => {
    for (const bundleItems of [undefined, [{ id: 2, quantity: 3 }, { id: 364, quantity: 5 }]]) {
        const calls = [];
        const service = createAuctionService({ async rpc(name, params) {
            calls.push({ name, params }); return { data: 'auction-id' };
        } });
        const listing = { item: 'seal tooth', itemId: 2, quantity: 1, minBidMeat: 100,
            auctionTime: '24', escrowMode: true, autoRelist: true, relistCount: 3,
            relistReduction: 5, ...(bundleItems ? { bundleItems } : {}) };
        assert.equal(await service.create(listing), 'auction-id');
        assert.deepEqual(calls, [{ name: 'create_relisting_auction', params: {
            p_listing: listing, p_relist_count: 3, p_reduction_percent: 5,
        } }]);
    }
});

test('a failed relisting creation never falls back to a second creation', async () => {
    const calls = [];
    const service = createAuctionService({ async rpc(name) {
        calls.push(name); return { error: { message: 'Enrollment rejected' } };
    } });
    await assert.rejects(service.create({ autoRelist: true, relistCount: 3, relistReduction: 5 }), /Enrollment rejected/);
    assert.deepEqual(calls, ['create_relisting_auction']);
});
