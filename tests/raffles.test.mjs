import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRaffle, raffleCountdown, equalOdds, prizeOddsTotal, adjustPrizeOdds, rebalancePrizePool, nudgePrizeOdds, matchesRaffleBrowse } from '../src/lib/raffles.js';
const now = Date.parse('2026-11-04T12:00:00Z');
const valid = () => ({ name: ' Mystery Raffle ', ticketPrice: '1000000', endsAt: new Date(now + 7 * 86400000).toISOString(), prizes: [{ id: 1, quantity: '20', chance: '50' }, { id: 2, quantity: '1', chance: '50' }] });
test('raffle normalization keeps quantities as distinct outcomes with exact stored probabilities', () => {
    const result = validateRaffle(valid(), now);
    assert.equal(result.name, 'Mystery Raffle'); assert.equal(result.ticketPrice, 1000000);
    assert.deepEqual(result.prizes, [{ id: 1, quantity: 20, probability_bps: 5000 }, { id: 2, quantity: 1, probability_bps: 5000 }]);
});
test('invalid prices, dates, pools and quantities fail closed', () => {
    for (const patch of [{ name: ' ' }, { ticketPrice: 'Infinity' }, { endsAt: 'invalid' }, { endsAt: new Date(now).toISOString() }, { prizes: [] }, { prizes: [{ id: 1, quantity: 1 }, { id: 1, quantity: 2 }] }, { prizes: [{ id: 1, quantity: '2.5' }] }]) assert.throws(() => validateRaffle({ ...valid(), ...patch }, now));
});
test('countdown never implies tickets are active', () => {
    assert.equal(raffleCountdown(valid().endsAt, now), '7d 0h 0m remaining');
    assert.match(raffleCountdown(new Date(now - 1).toISOString(), now), /participation unavailable/);
});

test('ticket prices reuse auction shorthand and comma parsing', () => {
    for (const [input, expected] of [['5k', 5000], ['10m', 10000000], ['50b', 50000000000], ['1,000,000', 1000000], ['4.53m', 4530000]]) assert.equal(validateRaffle({ ...valid(), ticketPrice: input }, now).ticketPrice, expected);
    assert.throws(() => validateRaffle({ ...valid(), ticketPrice: '1001b' }, now));
});

test('equal odds rebalance exactly for every supported pool size', () => {
    for (let n = 1; n <= 20; n++) {
        const pool = equalOdds(Array.from({ length: n }, (_, id) => ({ id: id + 1 })));
        assert.equal(prizeOddsTotal(pool), 10000);
        const units = pool.map(p => Math.round(Number(p.chance) * 100));
        assert.ok(Math.max(...units) - Math.min(...units) <= 1);
    }
});
test('custom odds reject incorrect totals and unsupported precision', () => {
    for (const chances of [['20','20'], ['50.001','49.999'], ['-1','101'], ['', '100']]) {
        assert.throws(() => validateRaffle({ ...valid(), prizes: valid().prizes.map((p, i) => ({ ...p, chance: chances[i] })) }, now), /100%/);
    }
    assert.equal(validateRaffle({ ...valid(), prizes: valid().prizes.map((p, i) => ({ ...p, chance: i ? '66.67' : '33.33' })) }, now).prizes[0].probability_bps, 3333);
});

const pool = () => [{ id: 1, chance: '20' }, { id: 2, chance: '30' }, { id: 3, chance: '50' }];
test('editing retains entered odds while other prizes balance proportionally', () => {
    const result = adjustPrizeOdds(pool(), 1, '60');
    assert.deepEqual(result.map(p => Number(p.chance)), [60, 15, 25]);
    assert.equal(prizeOddsTotal(result), 10000);
});
test('locks preserve values and impossible changes leave the pool untouched', () => {
    const prizes = pool().map(p => ({ ...p, locked: p.id === 2 }));
    assert.deepEqual(adjustPrizeOdds(prizes, 1, '60').map(p => Number(p.chance)), [60, 30, 10]);
    assert.throws(() => adjustPrizeOdds(prizes, 1, '71'), /Cannot balance/);
    assert.throws(() => adjustPrizeOdds(prizes, 2, '10'), /Unlock/);
    assert.deepEqual(prizes.map(p => p.chance), ['20', '30', '50']);
    assert.throws(() => adjustPrizeOdds([{ id: 1, chance: '100' }], 1, '99'), /Cannot balance/);
    for (const value of ['-1', '101', '20.001', '']) assert.throws(() => adjustPrizeOdds(prizes, 1, value));
});
test('zero weights split evenly and rounding always totals exactly 100%', () => {
    let prizes = [{ id: 1, chance: '100' }, { id: 2, chance: '0' }, { id: 3, chance: '0' }];
    assert.deepEqual(adjustPrizeOdds(prizes, 1, '50').map(p => Number(p.chance)), [50, 25, 25]);
    prizes = equalOdds(Array.from({ length: 20 }, (_, id) => ({ id })));
    for (let i = 0; i < 100; i++) {
        const value = ((i * 7919 % 10001) / 100).toFixed(2);
        prizes = adjustPrizeOdds(prizes, i % 20, value);
        assert.equal(prizeOddsTotal(prizes), 10000);
        assert.equal(Number(prizes[i % 20].chance), Number(value));
        assert.ok(prizes.every(p => Number(p.chance) >= 0));
    }
});
test('pool changes preserve locked odds; reset equal odds unlocks everything', () => {
    const prizes = pool().map(p => ({ ...p, locked: p.id === 1 }));
    const added = rebalancePrizePool(prizes, [...prizes, { id: 4, chance: '0' }]);
    assert.equal(added[0].chance, '20'); assert.ok(Number(added[3].chance) > 0);
    assert.equal(prizeOddsTotal(added), 10000);
    const removed = rebalancePrizePool(added, added.filter(p => p.id !== 3));
    assert.equal(removed[0].chance, '20'); assert.equal(prizeOddsTotal(removed), 10000);
    assert.throws(() => rebalancePrizePool(prizes, [prizes[0]]), /Cannot balance/);
    assert.deepEqual(rebalancePrizePool(prizes, []), []);
    const reset = equalOdds(removed);
    assert.ok(reset.every(p => !p.locked)); assert.equal(prizeOddsTotal(reset), 10000);
});

test('arrow steps scale with pool size independently of manual precision', () => {
    for (const [count, step] of [[4, 100], [5, 80], [10, 40], [3, 133]]) {
        const prizes = equalOdds(Array.from({ length: count }, (_, id) => ({ id })));
        const updated = nudgePrizeOdds(prizes, 0, 1);
        assert.equal(Math.round(Number(updated[0].chance) * 100) - Math.round(Number(prizes[0].chance) * 100), step);
        assert.equal(prizeOddsTotal(updated), 10000);
        assert.equal(prizeOddsTotal(nudgePrizeOdds(updated, 0, -1)), 10000);
        assert.equal(Number(adjustPrizeOdds(prizes, 0, '10.01')[0].chance), 10.01);
    }
});
test('arrows clamp to available odds, preserve locks, and stop when nothing can absorb changes', () => {
    const prizes = [{ id: 1, chance: '0.01' }, { id: 2, chance: '99.98', locked: true }, { id: 3, chance: '0.01' }];
    const increased = nudgePrizeOdds(prizes, 1, 1);
    assert.equal(Number(increased[0].chance), .02); assert.equal(increased[1].chance, '99.98');
    assert.equal(prizeOddsTotal(increased), 10000);
    assert.equal(Number(nudgePrizeOdds(prizes, 1, -1)[0].chance), 0);
    assert.throws(() => nudgePrizeOdds(prizes, 2, 1), /Unlock/);
    const fixed = [{ id: 1, chance: '20' }, { id: 2, chance: '80', locked: true }];
    assert.deepEqual(nudgePrizeOdds(fixed, 1, 1), fixed);
});

test('pinned raffle respects explicit browse search and filters independently of sorting', () => {
    const raffle = { name: 'Mystery Raffle', ticket_price: 1000000, prizes: [{ name: 'dense meat stack' }] };
    assert.equal(matchesRaffleBrowse(raffle), true);
    assert.equal(matchesRaffleBrowse(raffle, { query: 'MEAT STACK' }), true);
    assert.equal(matchesRaffleBrowse(raffle, { query: 'mystery' }), true);
    assert.equal(matchesRaffleBrowse(raffle, { query: 'unmatched' }), false);
    for (const filter of [{ status: 'completed' }, { status: 'ended' }, { kind: 'buy' }, { trade: 'direct' }, { trade: 'none' }, { buyout: 'with' }, { bundle: 'with' }, { ownershipFiltered: true }, { minPrice: 1000001 }, { maxPrice: 999999 }]) assert.equal(matchesRaffleBrowse(raffle, filter), false);
    assert.equal(matchesRaffleBrowse(raffle, { status: 'all', kind: 'sell', trade: 'escrow', bundle: 'without', buyout: 'without', minPrice: 1000000, maxPrice: 1000000 }), true);
});
