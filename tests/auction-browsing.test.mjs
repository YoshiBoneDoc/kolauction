import test from 'node:test';
import assert from 'node:assert/strict';
import { browseAuctions, popularActiveAuctions, auctionPrice } from '../src/lib/auctionBrowsing.js';
import { parseAuctionAmount, parseMeatAmount, normalizeAuctionAmount } from '../src/lib/auctionInputs.js';

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
    for (const [input, amount] of [
        ['1,000', 1000], ['10k', 10000], ['2M', 2000000], ['20b', 20000000000],
        ['9m', 9000000], ['9b', 9000000000], ['4.5m', 4500000], ['1.001k', 1001],
        ['0.000001m', 1], ['4.500000000m', 4500000], ['1.5', 2], ['144.5', 145],
    ]) {
        assert.equal(parseAuctionAmount(input, 20000000000), amount);
    }
    for (const input of ['', '0', '-1', '1..5', '1garbage', '21b', '1e3', '0.0000001m', '20.000000001b', '0.0m', '4.5.0m']) {
        assert.equal(parseAuctionAmount(input, 20000000000), null);
    }
    assert.equal(parseAuctionAmount('6b', 5000000000), null);
    assert.equal(parseAuctionAmount('11b', 10000000000), null);
});

test('Meat rounds plain decimals half up after expanding shorthand exactly', () => {
    for (const [input, amount] of [
        ['99.7', 100], ['99.5', 100], ['10.4', 10], ['10.4 meat', 10],
        ['99.7m', 99700000], ['4.53m', 4530000], ['50k', 50000], ['10b', 10000000000],
        ['1.001k', 1001], ['99.499999999999999999', 99], ['0.5', 1],
        ['1,000.5 Meat', 1001], ['20000000000.4', 20000000000],
    ]) assert.equal(parseMeatAmount(input, 20000000000), amount, input);
    for (const input of ['0.49', '-10.5', '1.5garbage', '0.0000001m', '20000000000.5', '21b', '1e3']) {
        assert.equal(parseMeatAmount(input, 20000000000), null, input);
    }
    assert.equal(parseAuctionAmount('99.7', 5000000000), 100);
});


test('blur normalization rounds quantities and Meat, expands shorthand and preserves invalid input', () => {
    for (const [input,expected] of [['144.5','145'],['144.499999999999999999','144'],['10.3','10'],['10.5','11'],['4.53m','4,530,000'],['99.7m','99,700,000'],['50b','50,000,000,000'],['0.4','0'],['144.','144']]) {
        assert.equal(normalizeAuctionAmount(input),expected);
    }
    assert.equal(normalizeAuctionAmount('10.4 Meat',{meat:true}),'10');
    for (const input of ['', 'unfinished', '-1', '9007199254740992']) assert.equal(normalizeAuctionAmount(input),input);
    assert.equal(parseMeatAmount('50b'),50000000000);
    assert.equal(parseMeatAmount('9007199254740991'),Number.MAX_SAFE_INTEGER);
    assert.equal(parseMeatAmount('9007199254740992'),null);
    assert.equal(parseAuctionAmount('0.0000005m'),1);
});
