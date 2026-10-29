import test from 'node:test';
import assert from 'node:assert/strict';
import { profileBidAuctions, latestProfileBid } from '../src/lib/profileBids.js';

test('rebids update one auction row and preserve bid records even when snapshots arrive out of order', () => {
    const first = { id: 'keycode-auction', item: 'CyberRealm keycode', currentBid: 100, viewerIsHighestBidder: false,
        bids: [{ id: 'bid-1', bidderId: 'me', amount: 100, timestamp: 1000 }] };
    const second = { ...first, currentBid: 200, viewerIsHighestBidder: true,
        bids: [...first.bids, { id: 'bid-2', bidderId: 'other', amount: 150, timestamp: 2000 },
            { id: 'bid-3', bidderId: 'me', amount: 200, timestamp: 3000 }] };
    const rows = profileBidAuctions([second, first, second], 'me');
    assert.equal(rows.length, 1); assert.equal(rows[0].currentBid, 200);
    assert.equal(rows[0].viewerIsHighestBidder, true);
    assert.equal(rows[0].bids.length, 3);
    assert.equal(latestProfileBid(rows[0], 'me').id, 'bid-3');
    assert.equal(first.bids.length, 1); assert.equal(second.bids.length, 3);
});

test('different auctions for the same item stay separate; auctions without personal bids stay excluded', () => {
    const base = { item: 'Same item', bids: [{ bidderId: 'me', amount: 10 }], currentBid: 10 };
    const rows = profileBidAuctions([{ ...base, id: 'a' }, { ...base, id: 'b' },
        { ...base, id: 'c', bids: [{ bidderId: 'other', amount: 20 }] }], 'me');
    assert.deepEqual(rows.map(row => row.id), ['a', 'b']);
    assert.equal(latestProfileBid(rows[0], 'other'), null);
});
