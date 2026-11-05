import test from 'node:test';
import assert from 'node:assert/strict';
import { watchRaffleCommitment } from '../src/lib/raffleCommitmentRefresh.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
test('automatically discovers a commitment, pauses hidden pages, and stops on completed draws', async () => {
    const document = Object.assign(new EventTarget(), { hidden: false }), window = new EventTarget();
    const tasks = new Map(); let serial = 0, reads = 0, now = 0;
    const timers = { setTimeout(fn, delay) { tasks.set(++serial, { fn, delay }); return serial; }, clearTimeout(id) { tasks.delete(id); } };
    let value = { required: true }, last;
    const stop = watchRaffleCommitment({ read: async () => { reads++; return value; }, onValue: v => { last = v; }, onError: () => assert.fail('unexpected error'), document, window, timers, now: () => now, random: () => 0, endsAt: '1970-01-01T00:00:20Z' });
    await settle(); assert.equal(reads, 1); assert.equal([...tasks.values()][0].delay, 20000);
    now = 20000; value = { required: true, commitmentHash: 'hash', complete: false };
    let task = [...tasks.entries()][0]; tasks.delete(task[0]); task[1].fn(); await settle();
    assert.equal(last.commitmentHash, 'hash'); assert.equal([...tasks.values()][0].delay, 5000);
    document.hidden = true; task = [...tasks.entries()][0]; tasks.delete(task[0]); task[1].fn(); await settle(); assert.equal(reads, 2);
    now = 25000; document.hidden = false; value = { ...value, complete: true }; document.dispatchEvent(new Event('visibilitychange')); task = [...tasks.entries()][0]; tasks.delete(task[0]); task[1].fn(); await settle();
    assert.equal(reads, 3); assert.equal(tasks.size, 0);
    stop(); window.dispatchEvent(new Event('focus')); await settle(); assert.equal(reads, 3);
});
test('a failed read retries, but unmounted views do not publish in-flight responses', async () => {
    const document = Object.assign(new EventTarget(), { hidden: false }), window = new EventTarget();
    let retry, errors = 0, resolve, reads = 0, values = 0;
    const stop = watchRaffleCommitment({ read: async () => { if (++reads === 1) throw new Error('offline'); return new Promise(done => { resolve = done; }); }, onValue: () => values++, onError: () => errors++, document, window,
        timers: { setTimeout(fn) { retry = fn; return 1; }, clearTimeout() {} } });
    await settle(); assert.equal(errors, 1); retry(); await settle(); stop(); resolve({ complete: true }); await settle(); assert.equal(values, 0);
});
