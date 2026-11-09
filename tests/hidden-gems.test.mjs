import test from 'node:test';
import assert from 'node:assert/strict';
import { dealScore, browseAuctions, exploreAuctions } from '../src/lib/auctionBrowsing.js';
import { bundleMarketPriceDisplay } from '../src/lib/marketPrices.js';
import { mapAuction } from '../src/lib/auctions.js';
import { publicProjection, publicRequest } from '../workers/public-auction-cache/protocol.js';
const now = Date.parse('2026-11-03T12:00:00Z');
const base = { id: 'gem', item: 'Gem', status: 'active', createdAt: now - 1000, endTime: now + 86400000,
    dealMarketValueMeat: 100000, dealCheckedAt: new Date(now).toISOString(), minBidMeat: 20000, currentBid: 0 };

test('bargains require both thresholds, fresh complete estimates and the next payable bid', () => {
    assert.equal(dealScore(base, now), 0.8);
    assert.equal(dealScore({ ...base, minBidMeat: 90000 }, now), 0.1);
    assert.equal(dealScore({ ...base, minBidMeat: 90001 }, now), 0);
    assert.equal(dealScore({ ...base, dealMarketValueMeat: 1000000, minBidMeat: 960000 }, now), 0);
    assert.equal(dealScore({ ...base, currentBid: 90000 }, now), 0);
    assert.equal(dealScore({ ...base, currentBid: 89999, instantPurchasePrice: 90000 }, now), 0.1);
    for (const patch of [{ dealCheckedAt: null }, { dealMarketValueMeat: 0 }, { dealCheckedAt: new Date(now - 86400000).toISOString() },
        { dealCheckedAt: new Date(now + 1).toISOString() }, { status: 'completed' }, { giveawayTitle: 'Giveaway' }]) {
        assert.equal(dealScore({ ...base, ...patch }, now), 0);
    }
    assert.equal(dealScore({ ...base, auctionKind: 'buy', pricePerItem: 120000 }, now), 0.2);
    assert.equal(dealScore({ ...base, auctionKind: 'buy', pricePerItem: 80000 }, now), 0);
});

test('Discover keeps urgency while Hidden Gems ranks value; giveaways lead both and unknowns remain discoverable', () => {
    const pool = [base,
        { ...base, id: 'urgent', endTime: now + 3600000, minBidMeat: 99999 },
        { ...base, id: 'giveaway', giveawayTitle: 'Giveaway', dealMarketValueMeat: 0 },
        { ...base, id: 'lesser', minBidMeat: 50000 },
        { ...base, id: 'unknown', dealCheckedAt: null, createdAt: now },
        { ...base, id: 'cheap', dealMarketValueMeat: 1000, minBidMeat: 1 },
    ].map((a, i) => ({ ...a, itemId: i + 1 }));
    assert.deepEqual(browseAuctions(pool, { sort: 'recommended', now }).map(a => a.id), ['giveaway', 'urgent', 'gem', 'lesser', 'unknown', 'cheap']);
    assert.deepEqual(exploreAuctions(pool, 'popular', now).map(a => a.id), ['giveaway', 'gem', 'lesser']);
    assert.deepEqual(browseAuctions(pool, { sort: 'best-value', now }).map(a => a.id).slice(0, 3), ['giveaway', 'gem', 'lesser']);
});

test('bundle display sums quantities, keeps stale warnings, and never publishes a partial total', () => {
    const items = [{ id: 1, quantity: 2 }, { id: 2, quantity: 3 }];
    const records = new Map([[1, { available: true, price_meat: 100, checked_at: new Date(now).toISOString() }],
        [2, { available: true, price_meat: 200, checked_at: new Date(now).toISOString() }]]);
    assert.deepEqual(bundleMarketPriceDisplay(items, records, now), { text: 'Market Value: 800 Meat for the entire bundle', available: true, stale: false });
    records.get(1).checked_at = new Date(now - 86400000).toISOString();
    assert.equal(bundleMarketPriceDisplay(items, records, now).stale, true);
    records.get(2).available = false;
    assert.equal(bundleMarketPriceDisplay(items, records, now).available, false);
});

test('shared transport carries public quote facts and accepts Best value without exposing identities', () => {
    assert.equal(publicRequest('https://example.test/api/public-auctions?sort=best-value').sort, 'best-value');
    const data = publicProjection({ privacy_version: 1, server_time: new Date(now).toISOString(), rows: [{ id: 'gem', status: 'active', deal_market_value_meat: '100000',
        deal_checked_at: new Date(now).toISOString(), seller_id: 'private' }], total: 1, bids: [] }, { view: 'browse' });
    assert.equal(data.rows[0].seller_id, undefined);
    const mapped = mapAuction(data.rows[0], []);
    assert.equal(mapped.dealMarketValueMeat, 100000);
    assert.equal(mapped.dealCheckedAt, new Date(now).toISOString());
});

test('Explore types filter before per-item selection and preserve Buy as a separate type', () => {
    const pool = [
        { ...base, id: 'direct', itemId: 1, escrowMode: false },
        { ...base, id: 'escrow', itemId: 1, escrowMode: true, createdAt: now - 2000 },
        { ...base, id: 'buy', itemId: 1, auctionKind: 'buy', escrowMode: true, pricePerItem: 120000, createdAt: now - 3000 },
    ];
    for (const tab of ['popular', 'new', 'ending']) {
        assert.deepEqual(exploreAuctions(pool, tab, now, 'direct').map(a => a.id), ['direct']);
        assert.deepEqual(exploreAuctions(pool, tab, now, 'escrow').map(a => a.id), ['escrow']);
        assert.deepEqual(exploreAuctions(pool, tab, now, 'buy').map(a => a.id), ['buy']);
        assert.equal(exploreAuctions(pool, tab, now, 'all').length, 1);
    }
});
