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


test('receipt-time escrow shows finalizing without naming a winner until the database settles', () => {
    const auction = {status:'active',escrowMode:true,receiptTimeBidding:true,endTime:1000,currentBid:500,highestBidderId:'leader'};
    const pending=getAuctionResult(auction,1001);
    assert.equal(pending.status,'finalizing');assert.equal(pending.hasWinner,false);assert.equal(pending.winnerId,null);
    assert.equal(getAuctionResult({...auction,status:'settling',winnerId:'leader',hasWinner:true,finalPrice:500},1001).hasWinner,true);
    assert.equal(getAuctionResult({...auction,escrowMode:false},1001).status,'awaiting_trade');
});

test('missed deposit deadlines, explicit cancellations and ambiguous older closures have distinct labels', () => {
    const base = { ...auction, escrowMode: true, itemEscrowedAt: null, currentBid: 0, highestBidderId: null };
    assert.equal(getAuctionResult({ ...base, status: 'expired', closureReason: 'deposit_expired' }, now).label, 'Expired');
    assert.equal(getAuctionResult({ ...base, status: 'cancelled', closureReason: 'seller_cancelled' }, now).label, 'Cancelled');
    assert.equal(getAuctionResult({ ...base, status: 'cancelled' }, now).label, 'Closed before deposit');
    assert.equal(getAuctionResult({ ...base, status: 'cancelled', itemEscrowedAt: '2026-10-22T12:00:00Z' }, now).label, 'Cancelled');
});

test('buy orders stop showing Closing once completed, canceled or expired', () => {
    const base = { ...auction, auctionKind: 'buy', escrowMode: true };
    for (const [status, reason, label] of [['completed', 'filled', 'Trade completed'], ['cancelled', 'cancel', 'Cancelled'], ['expired', 'deadline', 'Expired']]) {
        assert.equal(getAuctionResult({ ...base, status, buyClosingReason: reason }, now).label, label);
    }
    assert.equal(getAuctionResult({ ...base, status: 'active', buyClosingReason: 'cancel' }, now).label, 'Closing — cancelled');
    assert.equal(getAuctionResult({ ...base, status: 'active', buyClosingReason: 'deadline' }, now).label, 'Closing — expired');
});
