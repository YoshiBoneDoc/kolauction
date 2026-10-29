import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSiteTradeTotals, formatSiteMeat } from '../src/lib/siteTradeTotals.js';

test('public trade totals accept only exact nonnegative decimal fields', () => {
    assert.deepEqual(parseSiteTradeTotals({ meat: '1420000000', items: '24582', trades: '328', private: 'DROP' }),
        { meat: '1420000000', items: '24582', trades: '328' });
    for (const value of [null, {}, { meat: 12, items: '1', trades: '1' },
        { meat: '-1', items: '1', trades: '1' }, { meat: '1e9', items: '1', trades: '1' }]) {
        assert.equal(parseSiteTradeTotals(value), null);
    }
});
test('homepage Meat shorthand preserves big integers and two decimal places', () => {
    assert.equal(formatSiteMeat('1420000000'), '1.42b');
    assert.equal(formatSiteMeat('0'), '0');
    assert.equal(formatSiteMeat('2500000'), '2.5m');
    assert.equal(formatSiteMeat('9007199254740993'), '9,007,199.25b');
});
