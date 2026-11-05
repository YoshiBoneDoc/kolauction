import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrafficPressure } from '../src/lib/trafficPressure.js';
import { coordinatedRefresh, refreshScope } from '../src/lib/coordinatedRefresh.js';
import { submitConfirmedBid } from '../src/lib/confirmedBid.js';
const settle = () => new Promise(resolve => setImmediate(resolve));

test('busy mode requires repeated pressure, holds through brief recoveries and exits after sustained healthy reads', () => {
    let now = 0;
    const pressure = createTrafficPressure({ now: () => now });
    pressure.observe({ milliseconds: 3000 }); pressure.observe({ milliseconds: 10 });
    assert.equal(pressure.busy(), false);
    pressure.observe({ milliseconds: 10, failed: true }); pressure.observe({ milliseconds: 3000 });
    assert.equal(pressure.busy(), true); assert.equal(pressure.delay(60000), 180000);
    for (let n = 0; n < 5; n++) pressure.observe({ milliseconds: 20 });
    assert.equal(pressure.busy(), true, 'minimum hold survives a burst of fast reads');
    now = 61000; pressure.observe({ milliseconds: 20 }); assert.equal(pressure.busy(), false);
    now = 100000; pressure.observe({ milliseconds: 3000 }); now = 140000;
    pressure.observe({ milliseconds: 3000 }); pressure.observe({ milliseconds: 3000 });
    assert.equal(pressure.busy(), false, 'old failures expire from the observation window');
});

test('cross-tab refresh serializes freshness checks without sharing private responses; force refresh and expired leases still read', async () => {
    let queue = Promise.resolve(), calls = 0, now = 1000;
    const stored = new Map();
    const storage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
    const locks = { request: (_key, run) => { const job = queue.then(run); queue = job.catch(() => {}); return job; } };
    const key = 'account:' + await refreshScope('private-user-id');
    const opts = { storage, locks, now: () => now };
    const read = async () => { calls++; await settle(); return true; };
    await Promise.all(Array.from({ length: 10 }, () => coordinatedRefresh(key, read, opts)));
    assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify([...stored]), /private-user-id|token|email/);
    await coordinatedRefresh(key, read, { ...opts, force: true }); assert.equal(calls, 2);
    now += 61000; await coordinatedRefresh(key, read, opts); assert.equal(calls, 3);
    await coordinatedRefresh(key, read, { ...opts, locks: null }); assert.equal(calls, 4);
});

test('failed coordinated reads never suppress another tab retry; blocked storage falls back to a local read', async () => {
    let writes = 0;
    const opts = { locks: { request: (_key, run) => run() }, storage: { getItem: () => null, setItem: () => writes++ } };
    assert.equal(await coordinatedRefresh('key', async () => false, opts), false); assert.equal(writes, 0);
    assert.equal(await coordinatedRefresh('key', async () => true, { ...opts, storage: { getItem() { throw new Error(); } } }), true);
});

test('a confirmed bid resolves while reconciliation is pending, and read failures never resubmit or change the saved outcome', async () => {
    let sends = 0, resolve, reads = 0;
    await submitConfirmedBid(async () => { sends++; }, () => { reads++; return new Promise(done => { resolve = done; }); });
    assert.equal(sends, 1); assert.equal(reads, 1); resolve();
    await submitConfirmedBid(async () => { sends++; }, async () => { throw new Error('read failed'); });
    await settle(); assert.equal(sends, 2);
    const failure = new Error('uncertain write');
    await assert.rejects(submitConfirmedBid(async () => { sends++; throw failure; }, async () => { reads++; }), failure);
    assert.equal(sends, 3); assert.equal(reads, 2);
});


test('unavailable Web Locks fall back without treating an infrastructure error as an account failure', async () => {
    let calls = 0;
    const result = await coordinatedRefresh('key', async () => { calls++; return true; }, {
        locks: { request: async () => { throw new Error('not allowed'); } },
        storage: { getItem: () => null },
    });
    assert.equal(result, true); assert.equal(calls, 1);
});
