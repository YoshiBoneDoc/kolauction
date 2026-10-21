import test from 'node:test';
import assert from 'node:assert/strict';
import { BID_INCREMENT_TIERS, bidIncrement, minimumAuctionBid } from '../src/lib/bidIncrements.js';

test('minimum increases switch at the current-bid boundaries, not the proposed next amount', () => {
    const cases = [[0,10],[999,10],[1000,100],[9999,100],[10000,1000],[99999,1000],
        [100000,10000],[999999,10000],[1000000,100000],[9999999,100000],
        [10000000,1000000],[99999999,1000000],[100000000,10000000],[999999999,10000000],
        [1000000000,100000000],[9999999999,100000000],[10000000000,100000000],
        [10000000001,100000001],[12345678901,123456790],[Number.MAX_SAFE_INTEGER,90071992547410]];
    for (const [current, expected] of cases) assert.equal(bidIncrement(current), expected, `current bid ${current}`);
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: 999 }), 1009);
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: 1009 }), 1109);
    assert.equal(BID_INCREMENT_TIERS.length, 9);
});

test('the first bid meets the seller minimum; later bids depend on the actual highest bid', () => {
    assert.equal(minimumAuctionBid({ minBidMeat: 20000000, currentBid: 0 }), 20000000);
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: 0 }), 1);
    assert.equal(minimumAuctionBid({ minBidMeat: 100, currentBid: 20000000 }), 21000000);
    assert.equal(minimumAuctionBid({ minBidMeat: 100, currentBid: 25000000 }), 26000000);
    assert.equal(minimumAuctionBid({ minBidMeat: 100, currentBid: 21000001 }), 22000001);
    assert.equal(minimumAuctionBid({ minBidMeat: 100, currentBid: 10000000001 }), 10100000002);
});

test('an exact buyout below the normal next bid remains valid, without rounding or changing its price', () => {
    const auction = { minBidMeat: 100, currentBid: 20000000, instantPurchasePrice: 20500000 };
    assert.equal(minimumAuctionBid(auction), 20500000);
    assert.equal(minimumAuctionBid({ ...auction, instantPurchasePrice: 21000000 }), 21000000);
    assert.equal(minimumAuctionBid({ ...auction, instantPurchasePrice: 30000000 }), 21000000);
    assert.equal(minimumAuctionBid({ minBidMeat: 999, currentBid: 0, instantPurchasePrice: 999 }), 999);
});

test('large calculations stay exact; an unrepresentable next bid disables ordinary bidding instead of rounding', () => {
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: Number.MAX_SAFE_INTEGER }), null);
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: Number.MAX_SAFE_INTEGER - 1, instantPurchasePrice: Number.MAX_SAFE_INTEGER }), Number.MAX_SAFE_INTEGER);
    for (const current of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => bidIncrement(current));
});
