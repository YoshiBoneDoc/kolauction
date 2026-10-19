import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuctionService, mapAuction } from '../src/lib/auctions.js';

const row = {
    id: 'auction-1', seller_id: 'seller-id', seller_username: 'Seller', item: 'Test item',
    quantity: '5000000000', min_bid_meat: '10000000000', duration_hours: 24,
    created_at: '2026-10-18T12:00:00Z', end_time: '2026-10-19T12:00:00Z', current_bid: '10000000000',
};

test('maps persisted records, sorts bid history, and preserves large values', () => {
    const mapped = mapAuction({ ...row, highest_bidder_username: 'First', highest_bidder_id: 'buyer-1' }, [
        { id: 'b2', auction_id: row.id, bidder_id: 'buyer-2', bidder_username: 'Second', amount: '20000000000', created_at: '2026-10-18T13:00:00Z' },
        { id: 'unrelated', auction_id: 'other-auction', amount: '1' },
        { id: 'b1', auction_id: row.id, bidder_id: 'buyer-1', bidder_username: 'First', amount: '10000000000', created_at: '2026-10-18T12:30:00Z' },
    ]);
    assert.equal(mapped.sellerId, 'seller-id');
    assert.equal(mapped.owner, 'Seller');
    assert.equal(mapped.quantity, 5_000_000_000);
    assert.equal(mapped.currentBid, 20_000_000_000);
    assert.equal(mapped.highestBidderId, 'buyer-2');
    assert.equal(mapped.highestBidder, 'Second');
    assert.deepEqual(mapped.bids.map((bid) => bid.id), ['b1', 'b2']);
    assert.equal(mapped.endTime - mapped.createdAt, 24 * 60 * 60 * 1000);
});

test('creation sends listing fields only; identity, time, ID, and bid state are server-owned', async () => {
    let sent;
    const service = createAuctionService({ rpc: async (name, params) => {
        assert.equal(name, 'create_auction');
        sent = params;
        return { data: 'server-id', error: null };
    } });
    assert.equal(await service.create({ item: 'Test item', quantity: 2, minBidMeat: 50, auctionTime: '24', owner: 'Spoof', endTime: 1, currentBid: 99 }), 'server-id');
    assert.deepEqual(sent, { p_item: 'Test item', p_quantity: 2, p_min_bid_meat: 50, p_duration_hours: 24, p_image: null });
});

test('database bid rejection propagates rather than changing local state', async () => {
    const service = createAuctionService({ rpc: async (name, params) => {
        assert.equal(name, 'place_bid');
        assert.deepEqual(params, { p_auction_id: row.id, p_amount: 150 });
        return { error: { code: 'P0001', message: 'This auction has ended.' } };
    } });
    await assert.rejects(service.bid(row.id, 150), /auction has ended/);
});

test('invalid bid values never reach the API', async () => {
    const service = createAuctionService(null);
    for (const amount of [0, -1, 1.5, NaN, 20_000_000_001]) {
        await assert.rejects(service.bid(row.id, amount), /whole number/);
    }
});

test('reads all pages instead of silently stopping at the API row limit', async () => {
    const requested = [];
    const service = createAuctionService({ rpc: async () => ({ error: null }), from(table) {
        const query = {
            select() { return query; },
            order() { return query; },
            async range(start, end) {
                requested.push([table, start, end]);
                return { error: null, data: table === 'auctions' ? Array.from({ length: start === 0 ? 500 : 1 }, (_, i) => ({ ...row, id: `auction-${start + i}` })) : [] };
            },
        };
        return query;
    } });
    const result = await service.load();
    assert.equal(result.length, 501);
    assert.deepEqual(requested, [['auctions', 0, 499], ['auctions', 500, 999], ['bids', 0, 499]]);
});

test('missing migration produces setup guidance rather than an empty listing', async () => {
    const service = createAuctionService({ rpc: async () => ({ error: null }), from() {
        const query = { select() { return query; }, order() { return query; }, range: async () => ({ error: { code: 'PGRST205' } }) };
        return query;
    } });
    await assert.rejects(service.load(), /Apply any pending auction SQL migrations/);
});


test('loads finalize expired auctions before reading rows', async () => {
    const calls = [];
    const service = createAuctionService({
        async rpc(name) { calls.push(name); return { error: null }; },
        from(table) {
            calls.push(table);
            const query = { select() { return query; }, order() { return query; }, range: async () => ({ data: [], error: null }) };
            return query;
        },
    });
    await service.load();
    assert.deepEqual(calls, ['finalize_expired_auctions', 'auctions', 'bids']);
});

test('lifecycle actions send only the listing ID and propagate rejections', async () => {
    const calls = [];
    const service = createAuctionService({ async rpc(name, params) {
        calls.push([name, params]);
        return { error: name === 'cancel_auction' ? { message: 'An auction with bids cannot be cancelled.' } : null };
    } });
    await service.confirmTrade(row.id);
    await assert.rejects(service.cancel(row.id), /with bids cannot be cancelled/);
    assert.deepEqual(calls, [
        ['confirm_auction_trade', { p_auction_id: row.id }],
        ['cancel_auction', { p_auction_id: row.id }],
    ]);
});

test('recorded winner and final price are preserved separately from current bids', () => {
    const mapped = mapAuction({ ...row, status: 'completed', winner_id: 'winner', winner_username: 'Historic name', final_price: '12345678901', seller_confirmed_at: 'first', buyer_confirmed_at: 'second', completed_at: 'done' }, []);
    assert.equal(mapped.status, 'completed');
    assert.equal(mapped.winner, 'Historic name');
    assert.equal(mapped.finalPrice, 12_345_678_901);
    assert.equal(mapped.completedAt, 'done');
});
