import test from 'node:test';
import assert from 'node:assert/strict';
import { ESCROW_FEE_TIERS, escrowFee } from '../src/lib/escrowFees.js';

test('fee estimates match the agreed marginal schedule and whole-Meat rounding', () => {
    for (const [price, fee] of [[0,0],[1,0],[19,0],[20,1],[999999,49999],
        [1000000,50000],[1000001,50000],[1000025,50001],
        [9999999,409999],[10000000,410000],[10000001,410000],
        [100000000,3110000],[1000000000,21110000],[10000000000,111110000],
        [Number.MAX_SAFE_INTEGER,90072003657409]]) {
        assert.equal(escrowFee(price), fee, `price ${price}`);
        assert.ok(fee <= price);
    }
    assert.deepEqual(ESCROW_FEE_TIERS.map(tier => tier.bps), [500,400,300,200,100]);
});

test('crossing a fee threshold never reduces the total fee or seller proceeds', () => {
    for (const boundary of [1000000,10000000,100000000,1000000000]) {
        let lastFee = 0, lastProceeds = 0;
        for (let price = boundary - 100; price <= boundary + 100; price++) {
            const fee = escrowFee(price);
            assert.ok(fee >= lastFee);
            assert.ok(price - fee >= lastProceeds);
            lastFee = fee; lastProceeds = price - fee;
        }
    }
    for (const price of [null, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1000000']) {
        assert.throws(() => escrowFee(price), /Invalid/);
    }
});
