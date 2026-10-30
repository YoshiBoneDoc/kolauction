import test from 'node:test';
import assert from 'node:assert/strict';
import { listingPrice } from '../src/lib/listingPrice.js';

test('either source determines the other price and quantity changes preserve that source', () => {
    assert.equal(listingPrice('1k', 'whole', '4', 'whole').item, '250');
    assert.equal(listingPrice('1k', 'whole', '5', 'whole').whole, '1k');
    assert.equal(listingPrice('1k', 'whole', '5', 'whole').item, '200');
    assert.equal(listingPrice('250', 'item', '4', 'whole').canonical, '1000');
    assert.equal(listingPrice('250', 'item', '5', 'whole').canonical, '1250');
    assert.equal(listingPrice('1,000 Meat', 'whole', '4', 'item').canonical, '250');
});

test('fractional per-item prices never round or change the entered total', () => {
    const sell = listingPrice('10', 'whole', '3', 'whole');
    assert.equal(sell.whole, '10');
    assert.equal(sell.item, '');
    assert.equal(sell.canonical, '10');
    assert.match(sell.message, /not divisible/);
    assert.equal(listingPrice('10', 'whole', '3', 'item').canonical, '');
});

test('empty, invalid and zero quantities never produce stale or nonfinite prices', () => {
    for (const quantity of ['', '0', 'invalid', '5000000001']) {
        const price = listingPrice('50', 'item', quantity, 'whole');
        assert.equal(price.item, '50');
        assert.equal(price.whole, '');
        assert.equal(price.canonical, '');
    }
    for (const value of ['', 'invalid', '0']) assert.equal(listingPrice(value, 'whole', '3', 'whole').item, '');
});

test('large products are exact and never enter the backend as unsafe numbers', () => {
    const result = listingPrice('9007199254740991', 'item', '5000000000', 'whole');
    assert.equal(result.whole, '45,035,996,273,704,955,000,000,000');
    assert.equal(result.canonical, '');
    assert.match(result.message, /limit/);
});
