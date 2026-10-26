import test from 'node:test';
import assert from 'node:assert/strict';
import { auctionFilterPrice, parsePrice, priceToSlider, sliderToPrice } from '../src/lib/auctionPriceRange.js';
import { browseAuctions } from '../src/lib/auctionBrowsing.js';
import { auctionReadRequest } from '../src/lib/auctionRefresh.js';
import { createAuctionService } from '../src/lib/auctions.js';

test('logarithmic range covers zero through safe-integer Meat prices with monotonic round trips', () => {
    for (const bounds of [{ min: 100, max: 10_000_000_000 }, { min: 0, max: Number.MAX_SAFE_INTEGER }, { min: 250, max: 250 }]) {
        let previous = bounds.min;
        for (let step = 0; step <= 1000; step++) {
            const value = sliderToPrice(step, bounds);
            assert.ok(value >= previous && value >= bounds.min && value <= bounds.max);
            previous = value;
        }
        for (const value of [bounds.min, bounds.max, Math.round((bounds.min + bounds.max) / 2)]) {
            assert.ok(Math.abs(sliderToPrice(priceToSlider(value, bounds), bounds) - value) <= Math.max(1, value * 1e-12));
        }
    }
    assert.ok(Math.abs(priceToSlider(1_000_000, { min: 100, max: 10_000_000_000 }) - 500) < 1);
    for (const value of [null, '', '-1', 'NaN', '1e6', '5.5', String(Number.MAX_SAFE_INTEGER + 1)]) assert.equal(parsePrice(value), null);
    assert.equal(parsePrice('0'), 0);
});

test('price matching uses bid, starting ask, completed final price, Buy per-item price, then market fallback', () => {
    assert.equal(auctionFilterPrice({ currentBid: 300, minBidMeat: 100, marketValueMeat: 900 }), 300);
    assert.equal(auctionFilterPrice({ currentBid: 0, minBidMeat: 100 }), 100);
    assert.equal(auctionFilterPrice({ finalPrice: 200, currentBid: 300, minBidMeat: 100 }), 200);
    assert.equal(auctionFilterPrice({ auctionKind: 'buy', pricePerItem: 5, quantity: 1_000_000 }), 5);
    assert.equal(auctionFilterPrice({ marketValueMeat: 700 }), 700);
    const base = { item: 'Item', status: 'active', endTime: 20000, createdAt: 1, minBidMeat: 100, escrowMode: true };
    const rows = [100, 200, 300].map(value => ({ ...base, id: String(value), currentBid: value }));
    const original = rows.map(row => row.id);
    assert.deepEqual(browseAuctions(rows, { minPrice: 150, maxPrice: 300, search: 'item', trade: 'escrow', sort: 'price-desc', now: 1 }).map(row => row.id), ['300', '200']);
    assert.deepEqual(browseAuctions(rows, { minPrice: 999, now: 1 }), []);
    assert.deepEqual(rows.map(row => row.id), original);
});

test('URL price bounds compose with sorting, search, ownership and status without changing defaults', () => {
    const request = auctionReadRequest('/auctions', '?minPrice=100&maxPrice=9000000000&mine=others&q=hat&status=expired&sort=price-desc&trade=direct&page=2', 'viewer');
    assert.deepEqual(request, { view: 'browse', excludeOwn: true, search: 'hat', status: 'expired', minPrice: 100, maxPrice: 9000000000, sort: 'price-desc', trade: 'direct', page: 2 });
    assert.equal(auctionReadRequest('/auctions', '?minPrice=-1&maxPrice=bad').minPrice, undefined);
    assert.equal(auctionReadRequest('/auctions', '?minPrice=-1&maxPrice=bad').maxPrice, undefined);
});

test('paginated browse sends prices to the server and exposes independent global bounds without scanning rows', async () => {
    const calls = [];
    const service = createAuctionService({ async rpc(name, args) {
        calls.push([name, args]);
        return { data: name === 'finalize_expired_auctions' ? null : { privacy_version: 1, rows: [], bids: [], total: 0, price_bounds: { min: '5', max: '9000000000' } } };
    } });
    const result = await service.load({ minPrice: 100, maxPrice: 200, trade: 'escrow', kind: 'buy', page: 3 });
    assert.equal(calls.length, 2);
    assert.equal(calls[1][0], 'read_filtered_auction_page');
    assert.equal(calls[1][1].p_min_price, 100);
    assert.equal(calls[1][1].p_max_price, 200);
    assert.equal(calls[1][1].p_trade, 'escrow');
    assert.equal(calls[1][1].p_kind, 'buy');
    assert.equal(calls[1][1].p_page, 3);
    assert.deepEqual(result.priceBounds, { min: 5, max: 9000000000 });
    assert.equal(result.total, 0);
});
