import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuctionStatus, getAuctionResult } from '../src/lib/auctionLifecycle.js';

const now = 10000;
const auction = { endTime: now + 1, status: 'active', currentBid: 100, highestBidderId: 'buyer', highestBidder: 'Buyer' };

test('deadline transitions to awaiting trade, including the exact boundary', () => {
    assert.equal(getAuctionStatus(auction, now), 'active');
    assert.equal(getAuctionStatus(auction, now + 1), 'awaiting_trade');
});

test('expired listing without a bid has no winning price', () => {
    const result = getAuctionResult({ ...auction, highestBidderId: null, currentBid: 0 }, now + 1);
    assert.equal(result.status, 'ended_no_bids');
    assert.equal(result.winnerId, null);
    assert.equal(result.finalPrice, null);
});

test('cancelled and completed states are not overwritten by deadline calculations', () => {
    assert.equal(getAuctionStatus({ ...auction, status: 'cancelled' }, now), 'cancelled');
    assert.equal(getAuctionStatus({ ...auction, status: 'completed' }, now), 'completed');
});

test('frozen settlement details take precedence over live bid display', () => {
    const result = getAuctionResult({ ...auction, status: 'completed', winnerId: 'frozen', winner: 'Historic winner', finalPrice: 200 }, now);
    assert.equal(result.winnerId, 'frozen');
    assert.equal(result.winner, 'Historic winner');
    assert.equal(result.finalPrice, 200);
});

test('current high bidder is not presented as a winner before expiry', () => {
    const result = getAuctionResult(auction, now);
    assert.equal(result.winnerId, null);
    assert.equal(result.finalPrice, null);
});
