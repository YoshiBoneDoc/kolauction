import test from 'node:test';
import assert from 'node:assert/strict';
import { mrAReferenceRange, mrAPaymentValue, mrABuyoutPayment, mrACommission, MR_A_PRICE_MAX_AGE_MS } from '../src/lib/mrAPayment.js';
import { escrowFee } from '../src/lib/escrowFees.js';

const now = Date.parse('2026-11-07T12:00:00Z');
const quote = { item_id: 194, available: true, price_meat: 70_000_000,
    observed_at: new Date(now - 1000).toISOString(), checked_at: new Date(now - 1000).toISOString() };

test('reference range uses exact inclusive ±5% bounds', () => {
    assert.deepEqual(mrAReferenceRange(quote, now), { reference: 70_000_000, minimum: 66_500_000, maximum: 73_500_000 });
    assert.deepEqual(mrAReferenceRange({ ...quote, price_meat: 101 }, now), { reference: 101, minimum: 96, maximum: 106 });
});
test('missing, stale, failed, wrong-item and future quotes fail closed', () => {
    for (const patch of [{ available: false }, { readFailed: true }, { item_id: 195 }, { price_meat: 0 },
        { observed_at: new Date(now - MR_A_PRICE_MAX_AGE_MS).toISOString() },
        { checked_at: new Date(now + 1).toISOString() }, { observed_at: null }, { checked_at: 'invalid' }]) {
        assert.equal(mrAReferenceRange({ ...quote, ...patch }, now), null);
    }
    assert.equal(mrAReferenceRange(null, now), null);
});
test('payment values preserve compositions and support all three forms', () => {
    assert.equal(mrAPaymentValue(75_000_000, 0, null), 75_000_000);
    assert.equal(mrAPaymentValue(6_000_000, 1, 70_000_000), 76_000_000);
    assert.equal(mrAPaymentValue(0, 2, 70_000_000), 140_000_000);
    assert.equal(mrAPaymentValue(0, 100_000, 70_000_000), 7_000_000_000_000);
});
test('reject rounded, negative, fractional and overflowing amounts', () => {
    for (const args of [[-1, 0, null], [0, 1, null], [0, 1, 0], [0, 0.5, 1],
        [Number.MAX_SAFE_INTEGER + 1, 0, null], [1, Number.MAX_SAFE_INTEGER, 2]]) {
        assert.throws(() => mrAPaymentValue(...args));
    }
});
test('buyout keeps exact Mr. A quantity and returns excess Meat only', () => {
    assert.deepEqual(mrABuyoutPayment(10_000_000, 2, 70_000_000, 150_000_000),
        { meat: 10_000_000, mrAQuantity: 2, value: 150_000_000, refundMeat: 0 });
    assert.deepEqual(mrABuyoutPayment(20_000_000, 2, 70_000_000, 150_000_000),
        { meat: 10_000_000, mrAQuantity: 2, value: 150_000_000, refundMeat: 10_000_000 });
    assert.throws(() => mrABuyoutPayment(0, 3, 70_000_000, 150_000_000));
    assert.throws(() => mrABuyoutPayment(0, 2, 70_000_000, 150_000_000));
});
test('commission is capped to physical Meat, with permanent waiver', () => {
    assert.deepEqual(mrACommission(10_000_000, 4_000_000), { collected: 4_000_000, waived: 0, sellerMeat: 6_000_000 });
    assert.deepEqual(mrACommission(2_000_000, 4_000_000), { collected: 2_000_000, waived: 2_000_000, sellerMeat: 0 });
    assert.deepEqual(mrACommission(0, 4_000_000), { collected: 0, waived: 4_000_000, sellerMeat: 0 });
    assert.equal(mrACommission(10_000_000, 0).collected, 0);
});
test('commission uses the full equivalent value before capping', () => {
    const full = mrAPaymentValue(2_000_000, 1, 70_000_000);
    assert.equal(escrowFee(full), 2_270_000);
    assert.deepEqual(mrACommission(2_000_000, escrowFee(full)), { collected: 2_000_000, waived: 270_000, sellerMeat: 0 });
});
test('buyout and commission conserve each physical asset over many compositions', () => {
    for (let q = 0; q < 30; q++) for (let m = 0; m < 100; m++) {
        const value = mrAPaymentValue(m, q, 7);
        const fee = mrACommission(m, Math.floor(value / 10));
        assert.equal(fee.sellerMeat + fee.collected, m);
        if (value < 100 || q * 7 > 100) continue;
        const payment = mrABuyoutPayment(m, q, 7, 100);
        assert.equal(payment.meat + payment.refundMeat, m);
        assert.equal(payment.mrAQuantity, q);
        assert.equal(payment.meat + q * 7, 100);
    }
});
