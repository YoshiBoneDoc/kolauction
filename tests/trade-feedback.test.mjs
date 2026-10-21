import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuctionService, mapAuction } from '../src/lib/auctions.js';
import { reputationSummary, reputationScore } from '../src/lib/reputation.js';

test('thumb votes use their own RPC and reject invalid values before sending', async () => {
    const calls = [];
    const service = createAuctionService({ rpc: async (name, args) => { calls.push([name, args]); return { error: null }; } });
    for (const rating of [1, -1]) await service.rateTrade('trade', rating);
    assert.deepEqual(calls, [1, -1].map(rating => ['rate_trade_partner', { p_auction_id: 'trade', p_rating: rating }]));
    for (const rating of [null, 0, 2, '1', true]) await assert.rejects(service.rateTrade('trade', rating), /thumbs/);
    assert.equal(calls.length, 2);
    await assert.rejects(createAuctionService({ rpc: async () => ({ error: { code: 'P0001', message: 'Respond first.' } }) }).rateTrade('trade', 1), /Respond first/);
});

test('own vote and trade response are mapped separately; feedback scores ignore completion counts', () => {
    const row = { id: 'trade', created_at: '2026-10-20', end_time: '2026-10-20', own_feedback: -1, seller_confirmed_at: '2026-10-20', buyer_reported_incomplete: true };
    const auction = mapAuction(row, []);
    assert.equal(auction.ownFeedback, -1);
    assert.equal(auction.sellerConfirmedAt, row.seller_confirmed_at);
    assert.equal(auction.buyerReportedIncomplete, true);
    assert.equal(mapAuction({ ...row, own_feedback: undefined }, []).ownFeedback, null);
    const summary = reputationSummary({ seller_positive: 2, seller_negative: 1, buyer_positive: 3, buyer_negative: 0, seller_confirmed: 100, buyer_confirmed: 200, seller_incomplete: 50 });
    assert.equal(reputationScore(summary.overall), '+4');
});
