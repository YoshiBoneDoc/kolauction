import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPreviousRaffles } from '../src/lib/previousRaffles.js';

function fixture(data) {
    const calls = [];
    const query = {};
    for (const method of ['select', 'eq', 'in', 'order']) query[method] = (...args) => { calls.push([method, ...args]); return query; };
    query.range = (...args) => { calls.push(['range', ...args]); return Promise.resolve({ data }); };
    const client = {
        from: table => { assert.equal(table, 'mystery_raffles'); return query; },
        rpc: async (name, args) => { calls.push(['rpc', name, args]); return { data: { winner_name: 'Slip_N_Slide' } }; },
    };
    const read = async (_key, loader) => loader();
    return { client, read, calls };
}

test('previous raffles are filtered before bounded stable pagination and winner reads', async () => {
    const data = Array.from({ length: 11 }, (_, index) => ({ id: String(index), winner_player_id: 42, selected_outcome: 0 }));
    const f = fixture(data);
    const result = await loadPreviousRaffles(f.client, f.read, 2);
    assert.equal(result.rows.length, 10);
    assert.equal(result.hasNext, true);
    assert.equal(result.rows[0].winner.winner_name, 'Slip_N_Slide');
    assert.deepEqual(f.calls.find(call => call[0] === 'eq'), ['eq', 'is_test', false]);
    assert.deepEqual(f.calls.find(call => call[0] === 'in'), ['in', 'state', ['fulfilling', 'returning', 'settled', 'cancelled', 'empty']]);
    assert.deepEqual(f.calls.filter(call => call[0] === 'order'), [['order', 'ends_at', { ascending: false }], ['order', 'id', { ascending: false }]]);
    assert.deepEqual(f.calls.find(call => call[0] === 'range'), ['range', 10, 20]);
    assert.equal(f.calls.filter(call => call[0] === 'rpc').length, 10);
});

test('raffles without a drawn winner make no result requests and final page stops', async () => {
    const f = fixture([{ id: 'cancelled', winner_player_id: null }, { id: 'pending', winner_player_id: 42, selected_outcome: null }]);
    const result = await loadPreviousRaffles(f.client, f.read, 1);
    assert.equal(result.hasNext, false);
    assert.equal(f.calls.some(call => call[0] === 'rpc'), false);
});

test('unavailable winner reads surface failure rather than silently hiding it', async () => {
    const f = fixture([{ id: 'winner', winner_player_id: 42, selected_outcome: 1 }]);
    f.client.rpc = async () => { throw new Error('unavailable'); };
    await assert.rejects(loadPreviousRaffles(f.client, f.read, 1), /unavailable/);
});
