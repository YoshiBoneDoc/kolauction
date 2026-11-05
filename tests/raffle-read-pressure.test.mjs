import test from 'node:test';
import assert from 'node:assert/strict';
import { createRaffleReads } from '../src/lib/raffleReads.js';
import { publicRequest, publicProjection, originRequest } from '../workers/public-auction-cache/protocol.js';
import { onRequest } from '../functions/api/public-raffle-commitment.js';
import { watchRaffleCommitment } from '../src/lib/raffleCommitmentRefresh.js';
const settle = () => new Promise(resolve => setImmediate(resolve));

test('private raffle reads coalesce, retain data, and discard in-flight data on token changes', async () => {
    let token = 'one', authChange, calls = 0, release;
    const client = { auth: { getSession: async () => ({ data: { session: { access_token: token } } }), onAuthStateChange(fn) { authChange = fn; } } };
    const read = createRaffleReads(client);
    const loader = async () => { calls++; return { data: { private: token } }; };
    assert.deepEqual(await Promise.all([read('tickets', loader), read('tickets', loader)]), [{ data: { private: 'one' } }, { data: { private: 'one' } }]);
    authChange('SIGNED_IN', { access_token: token });
    await read('tickets', loader); assert.equal(calls, 1);
    const pending = read('slow', () => new Promise(resolve => { release = resolve; }));
    await settle(); token = 'two'; authChange('TOKEN_REFRESHED');
    release({ data: { private: 'one' } }); await assert.rejects(pending, /interrupted/);
    assert.deepEqual(await read('tickets', loader), { data: { private: 'two' } });
    assert.equal(calls, 2);
});

test('failed scoped reads back off rather than returning stale private data', async () => {
    const read = createRaffleReads({ auth: { getSession: async () => ({ data: {} }), onAuthStateChange() {} } });
    let calls = 0;
    const fail = async () => { calls++; return { error: Object.assign(new Error('denied'), { code: '42501' }) }; };
    await assert.rejects(read('tickets', fail), /denied/);
    await assert.rejects(read('tickets', fail), /denied/);
    assert.equal(calls, 1);
});

const id = '00000000-0000-0000-0000-000000000001';
test('public commitment transport drops credentials and rejects arbitrary parameters and private fields', async () => {
    let forwarded;
    const response = await onRequest({ request: new Request(`https://khub.test/api/public-raffle-commitment?id=${id}`, { headers: { Authorization: 'PRIVATE', Cookie: 'PRIVATE' } }), env: { PUBLIC_AUCTION_CACHE: { idFromName: name => name, get: () => ({ fetch: async req => { forwarded = req; return Response.json({ commitment: null }); } }) } } });
    assert.equal(response.status, 200); assert.equal(forwarded.headers.get('authorization'), null); assert.equal(forwarded.headers.get('cookie'), null);
    const query = publicRequest(forwarded.url);
    assert.deepEqual(originRequest(query), { rpc: 'read_public_raffle_commitment', args: { p_id: id } });
    assert.throws(() => publicRequest(`${forwarded.url}&private=1`));
    const record = { raffleId: id, commitmentHash: 'a'.repeat(64), committedAt: '2026-11-05T00:00:00Z', round: 42, complete: false, ticketCount: 'PRIVATE', name: 'PRIVATE', manifest: 'PRIVATE' };
    assert.doesNotMatch(JSON.stringify(publicProjection(record, query)), /PRIVATE|ticketCount|manifest/);
    assert.throws(() => publicProjection({ ...record, raffleId: 'different' }, query));
});

test('focus bursts cannot bypass commitment failure cooldown and jittered exponential retries', async () => {
    const document = Object.assign(new EventTarget(), { hidden: false }), window = new EventTarget();
    let task, time = 0, reads = 0;
    const stop = watchRaffleCommitment({ read: async () => { reads++; throw new Error(); }, onValue() {}, onError() {}, document, window, now: () => time, random: () => 0.5,
        timers: { setTimeout(fn, delay) { task = { fn, delay }; return 1; }, clearTimeout() {} } });
    await settle(); assert.equal(task.delay, 11000);
    for (let n = 0; n < 20; n++) window.dispatchEvent(new Event('focus'));
    assert.equal(reads, 1); assert.equal(task.delay, 11000);
    time = 11000; task.fn(); await settle(); assert.equal(reads, 2); assert.equal(task.delay, 22000);
    stop();
});

test('many public viewers share one commitment read even with live auction mode enabled', async () => {
    const { PublicAuctionCache } = await import('../workers/public-auction-cache/index.js');
    let initialized, calls = 0, release;
    const cache = new PublicAuctionCache({ storage: { async get() {}, async put() {} }, blockConcurrencyWhile(fn) { initialized = fn(); }, waitUntil() {} }, { LIVE_AUCTION_STATE: 'true' });
    await initialized;
    cache.readOrigin = async () => { calls++; await new Promise(resolve => { release = resolve; }); return { commitment: null, server_time: new Date().toISOString() }; };
    const url = `https://cache.internal/public-raffle-commitment?id=${id}`;
    const requests = Array.from({ length: 40 }, () => cache.fetch(new Request(url, { headers: { 'X-Khub-Live-State': '1' } })));
    await settle(); assert.equal(calls, 1); release();
    for (const response of await Promise.all(requests)) { assert.equal(response.status, 200); assert.equal((await response.json()).commitment, null); }
    await cache.fetch(new Request(url)); assert.equal(calls, 1);
});
