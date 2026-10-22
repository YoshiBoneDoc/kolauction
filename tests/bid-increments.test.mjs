import test from 'node:test';
import assert from 'node:assert/strict';
import { BID_INCREMENT_TIERS, bidIncrement, minimumAuctionBid } from '../src/lib/bidIncrements.js';

test('hybrid brackets use the current highest bid, with exact integer rounding', () => {
    const cases = [[0,10],[999,10],[1000,100],[9999,100],[10000,1000],[99999,1000],
        [100000,10000],[999999,10000],[1000000,30000],[1000001,40000],[9999999,300000],
        [10000000,200000],[10000001,300000],[99999999,2000000],
        [100000000,1000000],[100000001,1500000],[999999999,10000000],
        [1000000000,10000000],[9999999999,100000000],
        [10000000000,50000000],[10000000001,50500000],[12345678901,62000000],
        [Number.MAX_SAFE_INTEGER,45035996500000]];
    for (const [current, expected] of cases) assert.equal(bidIncrement(current), expected, `current bid ${current}`);
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: 999 }), 1009);
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: 1009 }), 1109);
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: 999999 }), 1009999);
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: 99000000 }), 101000000);
    assert.equal(BID_INCREMENT_TIERS.length, 8);
});

test('the requested examples round the INCREASE, without rounding the final bid', () => {
    for (const [current, increase, minimum] of [
        [1750000,60000,1810000],[7500000,230000,7730000],[15000000,300000,15300000],
        [350000000,3500000,353500000],[15000000000,75000000,15075000000],
        [1750001,60000,1810001],
    ]) {
        assert.equal(bidIncrement(current), increase);
        assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: current }), minimum);
    }
});

test('the first bid meets the seller minimum; increments apply only to subsequent bids', () => {
    assert.equal(minimumAuctionBid({ minBidMeat: 20000000, currentBid: 0 }), 20000000);
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: 0 }), 1);
    assert.equal(minimumAuctionBid({ minBidMeat: 100, currentBid: 20000000 }), 20400000);
    assert.equal(minimumAuctionBid({ minBidMeat: 100, currentBid: 25000000 }), 25500000);
    assert.equal(minimumAuctionBid({ minBidMeat: 100, currentBid: 21000001 }), 21500001);
    assert.equal(minimumAuctionBid({ minBidMeat: 100, currentBid: 10000000001 }), 10050500001);
});

test('an exact buyout below the normal minimum remains valid, including non-rounded prices', () => {
    const auction = { minBidMeat: 100, currentBid: 20000000, instantPurchasePrice: 20200001 };
    assert.equal(minimumAuctionBid(auction), 20200001);
    assert.equal(minimumAuctionBid({ ...auction, instantPurchasePrice: 20400000 }), 20400000);
    assert.equal(minimumAuctionBid({ ...auction, instantPurchasePrice: 30000000 }), 20400000);
    assert.equal(minimumAuctionBid({ minBidMeat: 999, currentBid: 0, instantPurchasePrice: 999 }), 999);
});

test('very large calculations stay exact and unrepresentable ordinary next bids are disabled', () => {
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: Number.MAX_SAFE_INTEGER }), null);
    assert.equal(minimumAuctionBid({ minBidMeat: 1, currentBid: Number.MAX_SAFE_INTEGER - 1, instantPurchasePrice: Number.MAX_SAFE_INTEGER }), Number.MAX_SAFE_INTEGER);
    for (const current of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) assert.throws(() => bidIncrement(current));
});
