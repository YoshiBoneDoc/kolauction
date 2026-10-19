import test from 'node:test';
import assert from 'node:assert/strict';
import { browseAuctions, popularActiveAuctions, auctionPrice } from '../src/lib/auctionBrowsing.js';
import { parseAuctionAmount } from '../src/lib/auctionInputs.js';

const now = 10000;
const base = { item: 'Mr. Accessory', status: 'active', createdAt: 100, endTime: 20000, currentBid: 0, minBidMeat: 100, bids: [] };
const listings = [
    { ...base, id: 'a', endTime: 12000, createdAt: 200, minBidMeat: 300 },
    { ...base, id: 'b', item: 'tiny plastic sword', currentBid: 200, createdAt: 300, bids: [{}] },
    { ...base, id: 'expired', endTime: now, bids: Array(20).fill({}) },
    { ...base, id: 'pending', status: 'awaiting_trade', highestBidderId: 'buyer', currentBid: 500 },
    { ...base, id: 'complete', status: 'completed', finalPrice: 50, currentBid: 500 },
    { ...base, id: 'cancel', status: 'cancelled' },
    { ...base, id: 'unsold', status: 'ended_no_bids' },
];
const ids = (values) => values.map((value) => value.id);

test('search combines with lifecycle filters and trims case-insensitive item names', () => {
    assert.deepEqual(ids(browseAuctions(listings, { search: '  PLASTIC SwOrD ', now })), ['b']);
    assert.equal(browseAuctions(listings, { search: 'unknown', now }).length, 0);
    assert.deepEqual(ids(browseAuctions(listings, { status: 'completed', now })), ['complete']);
    assert.deepEqual(new Set(ids(browseAuctions(listings, { status: 'ended', now }))), new Set(['expired', 'pending', 'complete', 'cancel', 'unsold']));
    assert.equal(browseAuctions(listings, { status: 'all', now }).length, listings.length);
});

test('sorts by deadline, creation time, and actual current or starting price without mutating data', () => {
    const original = ids(listings);
    assert.deepEqual(ids(browseAuctions(listings, { sort: 'ending', now })), ['a', 'b']);
    assert.deepEqual(ids(browseAuctions(listings, { sort: 'newest', now })), ['b', 'a']);
    assert.deepEqual(ids(browseAuctions(listings, { sort: 'price-asc', now })), ['b', 'a']);
    assert.deepEqual(ids(browseAuctions(listings, { sort: 'price-desc', now })), ['a', 'b']);
    assert.equal(auctionPrice(listings.find((auction) => auction.id === 'complete')), 50);
    assert.deepEqual(ids(listings), original);
});

test('homepage excludes expired and terminal listings regardless of popularity, including deadline transitions', () => {
    assert.deepEqual(ids(popularActiveAuctions(listings, now)), ['b', 'a']);
    assert.deepEqual(ids(popularActiveAuctions(listings, 12000)), ['b']);
    assert.deepEqual(ids(popularActiveAuctions(listings, 20000)), []);
});

test('amount parsing preserves supported shorthand and rejects invalid or excessive bids instead of changing them', () => {
    for (const [input, amount] of [['1,000', 1000], ['10k', 10000], ['2M', 2000000], ['20b', 20000000000]]) {
        assert.equal(parseAuctionAmount(input, 20000000000), amount);
    }
    for (const input of ['', '0', '-1', '1.5', '1garbage', '21b', '1e3']) {
        assert.equal(parseAuctionAmount(input, 20000000000), null);
    }
    assert.equal(parseAuctionAmount('6b', 5000000000), null);
    assert.equal(parseAuctionAmount('11b', 10000000000), null);
});
