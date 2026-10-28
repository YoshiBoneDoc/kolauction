import test from 'node:test';
import assert from 'node:assert/strict';
import { meatStackPieceCount } from '../src/lib/meatStack.js';

test('each milestone adds exactly one piece, capped at fourteen', () => {
    const milestones = [100_000n, 500_000n, 1_000_000n, 10_000_000n,
        100_000_000n, 500_000_000n, 1_000_000_000n, 2_000_000_000n,
        4_000_000_000n, 8_000_000_000n, 16_000_000_000n,
        32_000_000_000n, 64_000_000_000n, 128_000_000_000n];
    for (const [index, amount] of milestones.entries()) {
        assert.equal(meatStackPieceCount(amount - 1n), index);
        assert.equal(meatStackPieceCount(amount), index + 1);
    }
    assert.equal(meatStackPieceCount(0n), 0);
    assert.equal(meatStackPieceCount(-1n), 0);
    assert.equal(meatStackPieceCount('1000000000000000000000'), 14);
});

test('Meat stacks accept database bigint strings and handle unavailable totals', () => {
    assert.equal(meatStackPieceCount('13500000'), 4);
    assert.equal(meatStackPieceCount('not a number'), 0);
    assert.equal(meatStackPieceCount(null), 0);
});
