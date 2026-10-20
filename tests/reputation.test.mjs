import test from 'node:test';
import assert from 'node:assert/strict';
import { reputationSummary, reputationScore } from '../src/lib/reputation.js';

test('overall reputation combines seller and buyer feedback and subtracts negatives', () => {
    const summary = reputationSummary({ seller_positive: 2, seller_negative: 0, buyer_positive: 48, buyer_negative: 0 });
    assert.equal(reputationScore(summary.seller), '+2');
    assert.equal(reputationScore(summary.buyer), '+48');
    assert.equal(reputationScore(summary.overall), '+50');
    assert.deepEqual(summary.overall, { positive: 50n, negative: 0n });
    assert.equal(reputationScore({ positive: 3n, negative: 5n }), '-2');
    assert.equal(reputationScore({ positive: 0n, negative: 0n }), '0');
});

test('reputation preserves exact aggregate counts and does not invent missing data', () => {
    const summary = reputationSummary({ seller_positive: '9007199254740993', seller_negative: '1', buyer_positive: '8', buyer_negative: '2' });
    assert.equal(summary.overall.positive, 9007199254741001n);
    assert.equal(reputationScore(summary.overall), '+9,007,199,254,740,998');
    assert.equal(reputationSummary({ seller_positive: 0, seller_negative: 0 }), null);
});
