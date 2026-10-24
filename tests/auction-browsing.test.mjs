import test from 'node:test';
import assert from 'node:assert/strict';
import { browseAuctions, popularActiveAuctions, auctionPrice, highRollerAuctions, exploreAuctions, exploreAuctionTabs } from '../src/lib/auctionBrowsing.js';
import { parseAuctionAmount, parseMeatAmount, normalizeAuctionAmount } from '../src/lib/auctionInputs.js';

const now = 10000;
const base = { item: 'Mr. Accessory', status: 'active', createdAt: 100, endTime: 20000, currentBid: 0, minBidMeat: 100, bids: [] };
const listings = [
    { ...base, id: 'a', endTime: 12000, createdAt: 200, minBidMeat: 300 },
    { ...base, id: 'b', item: 'tiny plastic sword', currentBid: 200, createdAt: 300, bids: [{}] },
    { ...base, id: 'expired', status: 'ended_no_bids', endTime: now, bids: Array(20).fill({}) },
    { ...base, id: 'pending', status: 'awaiting_trade', highestBidderId: 'buyer', currentBid: 500 },
    { ...base, id: 'complete', status: 'completed', finalPrice: 50, currentBid: 500 },
    { ...base, id: 'cancel', status: 'cancelled' },
    { ...base, id: 'unsold', status: 'ended_no_bids' },
];
const ids = (values) => values.map((value) => value.id);

test('Explore selects a unique item after ranking the full pool for each tab, without affecting All Auctions', () => {
    const pool = [
        { ...base, id: 'popular', itemId: 1, bidCount: 9, createdAt: 100, endTime: 19000 },
        { ...base, id: 'new', itemId: '1', bidCount: 1, createdAt: 300, endTime: 18000, auctionKind: 'buy' },
        { ...base, id: 'ending', itemId: 1, bidCount: 2, createdAt: 200, endTime: 11000 },
        { ...base, id: 'other', itemId: 2, item: 'Other item', bidCount: 4, createdAt: 250, endTime: 15000 },
        { ...base, id: 'closed', itemId: 3, status: 'completed', bidCount: 99, createdAt: 500, endTime: 10500 },
        { ...base, id: 'pending', itemId: 4, status: 'pending_escrow' },
    ];
    const original = [...pool];
    assert.deepEqual(ids(exploreAuctions(pool, 'popular', now)), ['popular', 'other']);
    assert.deepEqual(ids(exploreAuctions(pool, 'new', now)), ['new', 'other']);
    assert.deepEqual(ids(exploreAuctions(pool, 'ending', now)), ['ending', 'other']);
    assert.deepEqual(ids(exploreAuctions(pool, 'invalid', now)), ['popular', 'other']);
    assert.equal(browseAuctions(pool, { now }).length, 4);
    assert.deepEqual(pool, original);
    for (const tab of exploreAuctionTabs) {
        const sorted = browseAuctions(pool, { now, sort: tab.sort });
        assert.equal(exploreAuctions(pool, tab.id, now)[0].id, sorted[0].id);
    }
});

test('Explore does not truncate before deduplication and falls back to normalized item names', () => {
    const pool = [
        ...Array.from({ length: 60 }, (_, i) => ({ ...base, id: `duplicate-${i}`, bidCount: 100 - i })),
        { ...base, id: 'name-variant', item: '  MR. ACCESSORY ', bidCount: 2 },
        ...Array.from({ length: 30 }, (_, i) => ({ ...base, id: `unique-${i}`, item: `Item ${i}`, bidCount: 1 })),
    ];
    assert.equal(exploreAuctions(pool, 'popular', now).length, 31);
    assert.equal(exploreAuctions(pool, 'popular', now)[0].id, 'duplicate-0');
    assert.deepEqual(exploreAuctions([], 'new', now), []);
});

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

test('homepage excludes confirmed terminal listings but keeps unverified deadlines pending a shared refresh', () => {
    assert.deepEqual(ids(popularActiveAuctions(listings, now)), ['b', 'a']);
    assert.deepEqual(ids(popularActiveAuctions(listings, 12000)), ['b', 'a']);
    assert.deepEqual(ids(popularActiveAuctions(listings, 20000)), ['b', 'a']);
    assert.deepEqual(ids(browseAuctions([listings[0]], {now: 12000, status: 'ended'})), []);
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


test('browse sorts by total accepted bids and latest bid with unbid auctions last', () => {
    const lots = [
        { ...base, id: 'older', bidCount: 10, latestBidAt: 200, escrowMode: false },
        { ...base, id: 'recent', bidCount: 2, latestBidAt: 300, escrowMode: true },
        { ...base, id: 'unbid', bidCount: 0, latestBidAt: null, createdAt: 500, escrowMode: true },
    ];
    assert.deepEqual(ids(browseAuctions(lots, { now, sort: 'bids-desc' })), ['older', 'recent', 'unbid']);
    assert.deepEqual(ids(browseAuctions(lots, { now, sort: 'bids-asc' })), ['unbid', 'recent', 'older']);
    assert.deepEqual(ids(browseAuctions(lots, { now, sort: 'activity' })), ['recent', 'older', 'unbid']);
    assert.deepEqual(ids(browseAuctions(lots, { now, sort: 'activity', trade: 'escrow', search: 'Accessory' })), ['recent', 'unbid']);
    assert.deepEqual(ids(browseAuctions(lots, { now, trade: 'direct' })), ['older']);
    assert.deepEqual(browseAuctions(lots, { now, trade: 'none' }), []);
});


import { recentCompletedAuctions } from '../src/lib/auctionBrowsing.js';
test('recent completed trades exclude other outcomes and order by completion rather than listing time', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: String(i), status: 'completed', completedAt: new Date(100000 + i * 1000).toISOString(), createdAt: 30000 - i }));
    rows.push(...['active', 'awaiting_trade', 'settling', 'cancelled', 'voided', 'ended_no_bids'].map(status => ({ id: status, status, completedAt: new Date(9999999).toISOString() })));
    const recent = recentCompletedAuctions(rows);
    assert.equal(recent.length, 24);
    assert.deepEqual(recent.map(a => a.id), Array.from({ length: 24 }, (_, i) => String(29-i)));
});


test('High Rollers requires strictly over 50M and active or confirmed completion, with displayed price semantics',()=>{
    const base={endTime:20000000,minBidMeat:60000000,currentBid:0,auctionKind:'sell'};
    const rows=['active','completed','awaiting_trade','settling','cancelled','expired','voided','pending_escrow','ended_no_bids'].map(status=>({...base,id:status,status,finalPrice:70000000}));
    rows.push({...base,id:'boundary',status:'active',minBidMeat:50000000},
        {...base,id:'past-deadline',status:'active',endTime:999},
        {...base,id:'low-final',status:'completed',finalPrice:40000000,currentBid:90000000},
        {...base,id:'low-buyout',status:'active',minBidMeat:1000,instantPurchasePrice:100000000},
        {...base,id:'cheap-order',status:'active',auctionKind:'buy',pricePerItem:100,quantity:1000000},
        {...base,id:'expensive-order',status:'active',auctionKind:'buy',pricePerItem:80000000},
        {...base,id:'direct',status:'active',escrowMode:false,minBidMeat:50000001});
    assert.deepEqual(highRollerAuctions(rows,1000).map(a=>a.id),['expensive-order','completed','active','direct']);
});


test('High Rollers prioritizes red countdowns by ending time and reorders after a deadline extension',()=>{
    const now=1000000, hours=3600000;
    const base={status:'active',minBidMeat:60000000,currentBid:0};
    const rows=[{...base,id:'later',endTime:now+4*hours,minBidMeat:90000000},
        {...base,id:'urgent',endTime:now+2*hours,minBidMeat:100000000},
        {...base,id:'soonest',endTime:now+hours},
        {...base,id:'three-hour-boundary',endTime:now+3*hours},
        {...base,id:'completed',status:'completed',endTime:now-hours,finalPrice:1000000000}];
    assert.deepEqual(highRollerAuctions(rows,now).map(a=>a.id),['soonest','urgent','three-hour-boundary','completed','later']);
    const extended=rows.map(a=>a.id==='soonest'?{...a,endTime:now+5*hours}:a);
    assert.deepEqual(highRollerAuctions(extended,now).map(a=>a.id),['urgent','three-hour-boundary','completed','later','soonest']);
});
