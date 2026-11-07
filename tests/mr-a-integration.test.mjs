import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuctionService, mapAuction } from '../src/lib/auctions.js';
import { overlayLive, unavailableRow } from '../workers/public-auction-cache/liveState.js';
import { PUBLIC_FIELDS } from '../workers/public-auction-cache/protocol.js';
import { relistDraft } from '../src/lib/relistAuction.js';
import { paymentLabel } from '../src/lib/mrAPayment.js';

test('opted-in creation is one atomic RPC and never falls back on failure', async () => {
    const calls = [];
    const listing = { item: 'seal tooth', itemId: 2, quantity: 1, minBidMeat: 1, auctionTime: '24', escrowMode: false, mrARate: 70_000_000 };
    const service = createAuctionService({ rpc: async (name, args) => { calls.push([name, args]); return { data: 'id' }; } });
    assert.equal(await service.create(listing), 'id');
    assert.deepEqual(calls, [['create_mr_a_auction', { p_listing: listing, p_rate: 70_000_000 }]]);
    const failing = createAuctionService({ rpc: async name => { assert.equal(name, 'create_mr_a_auction'); throw new Error('uncertain'); } });
    await assert.rejects(failing.create(listing), /uncertain/);
});
test('mixed bid transports physical composition; legacy bids retain original RPC', async () => {
    const calls = [];
    const service = createAuctionService({ rpc: async (name, args) => { calls.push([name, args]); return {}; } });
    await service.bid('id', 76_000_000, { meat: 6_000_000, mrAQuantity: 1 });
    await service.bid('id', 80_000_000);
    assert.deepEqual(calls, [['place_mixed_bid', { p_auction_id: 'id', p_meat: 6_000_000, p_mr_a: 1 }], ['place_bid', { p_auction_id: 'id', p_amount: 80_000_000 }]]);
});
test('history normalization keeps asset composition separate from value', () => {
    const auction = mapAuction({ id: 'id', current_bid: 76_000_000, payment_meat: 6_000_000, payment_mr_a: 1, mr_a_rate: 70_000_000 }, []);
    assert.equal(auction.currentBid, 76_000_000);
    assert.equal(auction.paymentMeat, 6_000_000);
    assert.equal(auction.paymentMrA, 1);
    const advanced = mapAuction({ id: 'id', current_bid: 76_000_000, payment_meat: 6_000_000, payment_mr_a: 1 }, [{ id: 'bid', auction_id: 'id', amount: 140_000_000, payment_meat: 0, payment_mr_a: 2 }]);
    assert.equal(advanced.paymentMeat, 0);
    assert.equal(advanced.paymentMrA, 2);
    assert.equal(mapAuction({ id: 'id', current_bid: 100 }, []).paymentMeat, 100);
});
test('live overlay replaces payment with current value; unavailable state hides old payment', () => {
    const row = { id: 'id', mr_a_rate: 70_000_000, current_bid: 76_000_000, payment_meat: 6_000_000, payment_mr_a: 1 };
    const result = overlayLive({ rows: [row] }, { rows: [{ ...row, current_bid: 140_000_000, payment_meat: 0, payment_mr_a: 2 }] });
    assert.equal(result.rows[0].payment_mr_a, 2);
    const unavailable = unavailableRow(row);
    assert.equal(unavailable.mr_a_rate, 70_000_000);
    assert.equal(unavailable.payment_mr_a, undefined);
    for (const key of ['mr_a_rate', 'payment_meat', 'payment_mr_a']) assert.ok(PUBLIC_FIELDS.includes(key));
});
test('manual relist keeps preference but cannot copy an old valuation', () => {
    const draft = relistDraft({ itemId: 2, quantity: 1, minBidMeat: 1, mrARate: 70_000_000 });
    assert.equal(draft.acceptMrA, true);
    assert.equal(draft.mrARate, undefined);
});
test('payment labels show actual assets and equivalent value', () => {
    assert.equal(paymentLabel(6_000_000, 1, 76_000_000), '1 Mr. A + 6,000,000 Meat (76,000,000 Meat value)');
    assert.equal(paymentLabel(0, 2, 140_000_000), "2 Mr. A's (140,000,000 Meat value)");
    assert.equal(paymentLabel(10, 0, 10), '10 Meat');
});
