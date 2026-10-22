import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCompactMeat, formatPerItemMeat } from '../src/lib/formatMeat.js';

test('list prices use lowercase k/m/b, one decimal at most, and no trailing .0', () => {
    for (const [amount, expected] of [[0,'0'],[506,'506'],[999,'999'],[1000,'1k'],[1500,'1.5k'],
        [99000,'99k'],[59600000,'59.6m'],[6200000000,'6.2b'],[99000000000,'99b']]) {
        assert.equal(formatCompactMeat(amount),expected);
    }
});

test('rounding at unit boundaries promotes the suffix rather than displaying 1000k/m', () => {
    for (const [amount,expected] of [[999949,'999.9k'],[999950,'1m'],[999949999,'999.9m'],[999950000,'1b'],[59650000,'59.7m']]) {
        assert.equal(formatCompactMeat(amount),expected);
    }
});

test('large aggregate strings and BigInts stay exact until display-only rounding', () => {
    assert.equal(formatCompactMeat('9007199254740993'),'9,007,199.3b');
    assert.equal(formatCompactMeat(9007199254740993n),'9,007,199.3b');
    assert.equal(formatCompactMeat(-1500),'-1.5k');
});


test('per-item equivalents divide the exact total before compact rounding', () => {
    for (const [total, quantity, expected] of [[1000000,20,'50k'],[1000000,50,'20k'],[100,3,'33.33'],
        [1,2,'0.5'],[1,500,'<0.01'],[2099,2,'1k'],[2100,2,'1.1k'],[1999900,2,'1m']]) {
        assert.equal(formatPerItemMeat(total,quantity),expected);
    }
});
