import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PublicAuctionCache } from '../workers/public-auction-cache/index.js';
import { cacheFailure } from '../workers/public-auction-cache/errors.js';
import { publicProjection, publicRequest } from '../workers/public-auction-cache/protocol.js';
import { onRequest } from '../functions/api/public-auctions.js';
import { createPublicAuctionReader } from '../src/lib/publicAuctionReader.js';
import { createAuctionService } from '../src/lib/auctions.js';
import { createAuctionReadCache } from '../src/lib/auctionReadCache.js';
import { onRequest as invalidateRequest } from '../functions/api/public-auctions/invalidate.js';
import { onRequest as bannerRequest } from '../functions/api/public-banner.js';
import { readPublicBanner } from '../src/lib/publicBannerReader.js';
import { createSiteBannerService } from '../src/lib/siteBanner.js';

test('origin failures expose fixed diagnostic categories without upstream secrets', async () => {
    const original = globalThis.fetch;
    const cache = new PublicAuctionCache({ blockConcurrencyWhile() {}, storage: {}, waitUntil() {} }, {
        SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
    });
    try {
        for (const [status, code, expected] of [
            [404, 'PGRST202', 'CACHE_RPC_MISSING'], [401, 'bad_key', 'CACHE_ORIGIN_AUTH'],
            [403, '42501', 'CACHE_ORIGIN_PERMISSION'], [500, '57014', 'CACHE_ORIGIN_TIMEOUT'],
            [500, 'XX000', 'CACHE_ORIGIN_ERROR'],
        ]) {
            globalThis.fetch = async () => Response.json({ code, message: 'PRIVATE SQL AND KEY' }, { status });
            await assert.rejects(cache.readOrigin({ view: 'home' }), error => {
                assert.equal(error.code, expected);
                assert.doesNotMatch(error.message, /PRIVATE|SQL|KEY/);
                return true;
            });
        }
        globalThis.fetch = async () => { throw new DOMException('PRIVATE URL', 'TimeoutError'); };
        await assert.rejects(cache.readOrigin({ view: 'home' }), { code: 'CACHE_ORIGIN_TIMEOUT' });
        globalThis.fetch = async () => new Response('not JSON');
        await assert.rejects(cache.readOrigin({ view: 'home' }), { code: 'CACHE_INVALID_RESPONSE' });
        cache.env.SUPABASE_URL = '';
        await assert.rejects(cache.readOrigin({ view: 'home' }), { code: 'CACHE_CONFIG_URL' });
        cache.env.SUPABASE_URL = 'https://project.supabase.co';
        cache.env.SUPABASE_PUBLISHABLE_KEY = '';
        await assert.rejects(cache.readOrigin({ view: 'home' }), { code: 'CACHE_CONFIG_KEY' });
    } finally { globalThis.fetch = original; }
});

test('diagnostic reason survives cooldown and restart without another origin request', async () => {
    const f = await fixture();
    f.cache.readOrigin = async () => { throw cacheFailure('CACHE_RPC_MISSING'); };
    const response = await f.get();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'CACHE_RPC_MISSING');
    const restarted = await fixture(f.storage);
    assert.equal((await (await restarted.get()).json()).code, 'CACHE_RPC_MISSING');
    assert.equal(restarted.reads(), 0);
    restarted.cache.cooldownUntil = 0;
    assert.equal((await restarted.get()).status, 200);
    assert.equal(restarted.cache.lastFailureCode, 'CACHE_UNAVAILABLE');
});

const id = '12345678-1234-4123-8123-123456789abc';
const url = 'https://site.test/api/public-auctions?view=browse';
function source() {
    return { privacy_version: 1, server_time: new Date(Date.now()).toISOString(), bids: [], total: 1,
        rows: [{ id, status: 'active', item: 'Test item', quantity: 1, current_bid: 100,
            end_time: new Date(Date.now() + 3600000).toISOString(), created_at: new Date(Date.now()).toISOString(),
            seller_id: 'PRIVATE-ACCOUNT', seller_username: 'PRIVATE-NAME', highest_bidder_id: 'PRIVATE-BIDDER',
            settlement_contacts: { secret: 'CONTACT' }, balance_meat: 'PRIVATE-BALANCE', fulfillments: [{ secret: true }],
            reservation_audit: ['PRIVATE-AUDIT'], my_reservation: { secret: true },
            bundle_items: [{ id: 2, name: 'Bundle item', quantity: 1, image: '2.gif', private: 'SECRET' }],
        }], sections: { popular: [id], new: [id], ending: [id], highRollers: [], recent: [] } };
}
async function fixture(storage = new Map()) {
    const waits = [];
    let ready;
    const ctx = { storage: { get: async key => structuredClone(storage.get(key)), put: async (key, data) => { storage.set(key, structuredClone(data)); } },
        blockConcurrencyWhile(fn) { ready = fn(); }, waitUntil(task) { waits.push(task); } };
    const cache = new PublicAuctionCache(ctx, {});
    await ready;
    let reads = 0;
    cache.readOrigin = async request => { reads++; return publicProjection(source(), request); };
    return { cache, waits, storage, reads: () => reads, get: (target = url) => cache.fetch(new Request(target)) };
}

test('strict public projection drops identities, financial records, nested secrets and future fields', () => {
    const result = publicProjection(source(), publicRequest(url));
    assert.equal(result.rows[0].current_bid, 100);
    assert.equal(result.rows[0].usernames_visible, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|CONTACT|secret|fulfillments|reservation_audit|balance_meat/);
    const invalid = source(); invalid.rows[0].status = 'pending_escrow';
    assert.throws(() => publicProjection(invalid, publicRequest(url)), /Nonpublic/);
    const bids = source(); bids.bids = [{ private: true }];
    assert.throws(() => publicProjection(bids, publicRequest(url)), /Invalid/);
});

test('only homepage aggregate totals cross the shared public projection', () => {
    const input = { ...source(), site_totals: { meat: '1420000000', items: '24582', trades: '328', balance: 'PRIVATE' } };
    assert.deepEqual(publicProjection(input, { view: 'home' }).site_totals,
        { meat: '1420000000', items: '24582', trades: '328' });
    assert.equal(publicProjection(input, publicRequest(url)).site_totals, undefined);
    input.site_totals.meat = 'PRIVATE';
    assert.equal(publicProjection(input, { view: 'home' }).site_totals, undefined);
});

test('public cache keys reject private views/parameters, random cache busters and duplicate filters', () => {
    for (const query of ['view=profile', 'view=detail', 'view=browse&id=secret', 'view=browse&sellerId=secret',
        'view=browse&mine=1', 'view=browse&fresh=1', 'view=browse&status=active&status=all',
        'view=browse&page=-1', 'view=browse&sort=anything', 'view=home&search=x', 'view=browse&minPrice=NaN']) {
        assert.throws(() => publicRequest(`https://cache.test/?${query}`));
    }
    assert.deepEqual(publicRequest(url), publicRequest(`${url}&status=active&search=&sort=recommended&page=1`));
    assert.notDeepEqual(publicRequest(url), publicRequest(`${url}&kind=buy`));
});

test('a simultaneous 200-visitor cold burst runs one origin query and the snapshot survives restart', async () => {
    const f = await fixture();
    const responses = await Promise.all(Array.from({ length: 200 }, () => f.get()));
    assert.equal(f.reads(), 1);
    for (const response of responses) assert.equal(response.status, 200);
    const restarted = await fixture(f.storage);
    const response = await restarted.get();
    assert.equal(response.headers.get('X-Khub-Cache'), 'HIT');
    assert.equal(restarted.reads(), 0);
    assert.equal((await response.json()).rows[0].item, 'Test item');
});

test('stale reads share refresh, database failure backs off globally, age never slides, clock remains current', async () => {
    const realNow = Date.now; let now = realNow(); Date.now = () => now;
    try {
        const f = await fixture();
        const first = await (await f.get()).json();
        now += 31000;
        let failures = 0;
        f.cache.readOrigin = async () => { failures++; throw new Error('database timeout'); };
        const stale = await f.get();
        assert.equal(stale.headers.get('X-Khub-Cache'), 'STALE');
        assert.equal(Date.parse((await stale.json()).server_time) - Date.parse(first.server_time), 31000);
        await Promise.all(f.waits);
        await Promise.all(Array.from({ length: 100 }, () => f.get()));
        assert.equal(failures, 1);
        const restarted = await fixture(f.storage);
        const afterRestart = await (await restarted.get()).json();
        assert.equal(restarted.reads(), 0);
        assert.equal(afterRestart.public_snapshot.delayed, true);
        now += 300001;
        const expired = await f.get();
        assert.equal(expired.status, 503);
        assert.equal(expired.headers.get('Retry-After'), '30');
        assert.equal(failures, 2);
    } finally { Date.now = realNow; }
});

test('distinct cold queries have a bounded global queue and bounded persistent storage', async () => {
    const f = await fixture();
    let release;
    f.cache.readOrigin = () => new Promise(resolve => { release = () => resolve(publicProjection(source(), publicRequest(url))); });
    const waiting = Array.from({ length: 4 }, (_, i) => f.get(`${url}&search=${i}`));
    const overloaded = await f.get(`${url}&search=overflow`);
    assert.equal(overloaded.status, 503);
    // Complete the four queued requests without real timer waits.
    for (let i = 0; i < 4; i++) {
        while (!release) await new Promise(resolve => setImmediate(resolve));
        f.cache.lastOriginAt = 0;
        const finish = release; release = null; finish();
        await waiting[i];
    }
    const realNow = Date.now; let now = realNow(); Date.now = () => now;
    try {
        f.cache.readOrigin = async request => publicProjection(source(), request);
        for (let i = 0; i < 60; i++) { now += 1001; await f.get(`${url}&search=entry${i}`); }
        assert.ok(f.cache.entries.size <= 48);
        assert.ok(new TextEncoder().encode(JSON.stringify([...f.storage.values()])).byteLength <= 1024 * 1024 + 1000);
    } finally { Date.now = realNow; }
});

test('Pages forwards no cookie/JWT/body/custom headers and all responses disallow HTTP caching', async () => {
    let forwarded;
    const env = { PUBLIC_AUCTION_CACHE: { idFromName(name) { assert.equal(name, 'public-auctions-v1'); return 'fixed'; },
        get() { return { fetch(request) { forwarded = request; return Response.json({ public: true }); } }; } } };
    const response = await onRequest({ env, request: new Request(url, { headers: { Cookie: 'secret', Authorization: 'Bearer SECRET', 'X-User-ID': 'SECRET' } }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal([...forwarded.headers].length, 0);
    assert.equal((await onRequest({ env, request: new Request(url, { method: 'POST', body: 'secret' }) })).status, 405);
    assert.equal((await onRequest({ env: {}, request: new Request(url) })).status, 503);
});

function readerFixture(user = null) {
    const requests = [], rpcCalls = [];
    const client = { auth: { async getSession() { return { data: { session: user && { access_token: `SECRET-${user}` } } }; } },
        rpc(name, args) { rpcCalls.push({ name, args }); return Promise.resolve({ data: { privacy_version: 1,
            server_time: new Date().toISOString(), rows: [{ id, seller_id: user, my_reservation: { id: `PRIVATE-${user}` } }] } }); } };
    const reader = createPublicAuctionReader(client, { enabled: true, fetch: async (url, options) => {
        requests.push({ url, options }); return Response.json(publicProjection(source(), publicRequest(`https://site.test${url}`)));
    } });
    return { client, reader, requests, rpcCalls };
}

test('signed-in homepage still needs zero Supabase reads; two viewers share public requests but never private context', async () => {
    const a = readerFixture('alice'), b = readerFixture('bob');
    await a.reader.load({ view: 'home' });
    assert.equal(a.rpcCalls.length, 0);
    const results = await Promise.all([a.reader.load({ view: 'browse' }), b.reader.load({ view: 'browse' })]);
    assert.equal(results[0].rows[0].my_reservation.id, 'PRIVATE-alice');
    assert.equal(results[1].rows[0].my_reservation.id, 'PRIVATE-bob');
    assert.equal(a.requests[1].url, b.requests[0].url);
    for (const f of [a, b]) {
        const { options } = f.requests.at(-1);
        assert.equal(options.credentials, 'omit');
        assert.equal(options.cache, 'no-store');
        assert.doesNotMatch(JSON.stringify(f.requests), /SECRET|PRIVATE/);
        assert.equal(f.rpcCalls[0].name, 'read_auction_card_context');
    }
});

test('private routes, personalized filters, signed-in All, and forced post-action reads bypass shared cache', async () => {
    const f = readerFixture('alice');
    for (const request of [{ view: 'detail' }, { view: 'profile' }, { view: 'seller' },
        { view: 'browse', sellerId: 'alice' }, { view: 'browse', excludeOwn: true },
        { view: 'browse', status: 'all' }, { view: 'home', fresh: true }]) {
        assert.equal(await f.reader.accepts(request), false);
    }
    assert.equal(await readerFixture().reader.accepts({ view: 'browse', status: 'all' }), true);
    assert.equal(await f.reader.accepts({ view: 'browse', status: 'active' }), true);
    const calls = [];
    const service = createAuctionService({ rpc(name) { calls.push(name); return Promise.resolve({ data: { ...source(), sections: source().sections } }); } }, { publicReader: f.reader });
    await service.load({ view: 'home', fresh: true });
    assert.deepEqual(calls, ['read_home_auctions']);
    assert.equal(f.requests.length, 0);
});

test('shared cache failure never causes an automatic direct-database fallback storm', async () => {
    const f = readerFixture();
    const reader = createPublicAuctionReader(f.client, { enabled: true, fetch: async () => new Response('busy', { status: 503 }) });
    const service = createAuctionService(f.client, { publicReader: reader });
    await assert.rejects(service.load({ view: 'home' }), /temporarily busy/);
    assert.equal(f.rpcCalls.length, 0);
});

test('origin credentials reject a service role before making any request', async () => {
    const f = await fixture();
    const real = new PublicAuctionCache({ blockConcurrencyWhile() {}, storage: {}, waitUntil() {} }, {
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: `abc.${btoa(JSON.stringify({ role: 'service_role' }))}.sig`,
    });
    await assert.rejects(real.readOrigin({ view: 'home' }), /temporarily busy/);
    assert.equal(f.reads(), 0);
});

test('origin fetch uses only the anonymous key and fixed read-only RPC arguments', async () => {
    const previous = globalThis.fetch, requests = [];
    globalThis.fetch = async (url, options) => { requests.push({ url: String(url), options }); return Response.json(source()); };
    try {
        const real = new PublicAuctionCache({ blockConcurrencyWhile() {}, storage: {}, waitUntil() {} }, {
            SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
        });
        const data = await real.readOrigin(publicRequest(url));
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, 'https://project.supabase.co/rest/v1/rpc/read_public_auction_page');
        assert.equal(requests[0].options.redirect, 'manual', 'use a Workers-supported mode without following redirects');
        assert.deepEqual(requests[0].options.headers, { apikey: 'sb_publishable_fixture', 'Content-Type': 'application/json' });
        assert.equal(JSON.parse(requests[0].options.body).p_view, 'browse');
        assert.equal(JSON.parse(requests[0].options.body).p_id, null);
        assert.doesNotMatch(JSON.stringify(data), /PRIVATE|SECRET/);
    } finally { globalThis.fetch = previous; }
});

test('anonymous gateway cookies do not break reads and never reach the cache or visitors', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
        // Emulate Workers rejecting the unsupported mode, which Node accepts.
        if (options.redirect === 'error') throw new TypeError('Unsupported redirect mode');
        assert.equal(options.redirect, 'manual');
        assert.equal(options.headers.Cookie, undefined);
        return Response.json(source(), { headers: { 'Set-Cookie': '__cf_bm=GATEWAY_COOKIE; HttpOnly; Secure', 'X-Upstream-Private': 'PRIVATE_HEADER' } });
    };
    try {
        const f = await fixture();
        f.cache.env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' };
        f.cache.readOrigin = PublicAuctionCache.prototype.readOrigin.bind(f.cache);
        for (let i = 0; i < 2; i++) {
            const response = await f.get();
            assert.equal(response.status, 200);
            assert.equal(response.headers.has('set-cookie'), false);
            assert.equal(response.headers.has('X-Upstream-Private'), false);
            assert.doesNotMatch(JSON.stringify(await response.json()), /GATEWAY_COOKIE|PRIVATE/);
        }
        assert.doesNotMatch(JSON.stringify([...f.storage]), /GATEWAY_COOKIE|PRIVATE_HEADER/);
    } finally { globalThis.fetch = original; }
});

test('origin redirects are rejected without following or caching their response', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
        calls++;
        assert.equal(options.redirect, 'manual');
        return new Response(null, { status: 302, headers: { Location: 'https://another-host.test/' } });
    };
    try {
        const f = await fixture();
        f.cache.env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' };
        f.cache.readOrigin = PublicAuctionCache.prototype.readOrigin.bind(f.cache);
        assert.equal((await f.get()).status, 503);
        assert.equal(calls, 1);
        assert.equal(f.cache.entries.size, 0);
    } finally { globalThis.fetch = original; }
});

test('browser cache passes forced reads to the transport after write invalidation', async () => {
    const options = [];
    const cache = createAuctionReadCache(async (key, signal, readOptions) => { options.push(readOptions); return { auctions: [] }; });
    await cache.load('home');
    cache.invalidate();
    await cache.load('home', { force: true });
    cache.invalidate();
    await cache.load('home', { force: true, fresh: true });
    assert.deepEqual(options, [{ force: false, fresh: false }, { force: true, fresh: false }, { force: true, fresh: true }]);
});

const signingSecret = 'ab'.repeat(32);
const signed = revision => ({ revision, signature: createHmac('sha256', signingSecret).update(`khub-public-auctions:v1:${revision}`).digest('hex') });
const notification = revision => new Request('https://cache.internal/invalidate', {
    method: 'POST', body: JSON.stringify(signed(revision)),
});

test('an accepted-bid notification makes the next five visitors share a fresh read, not the old snapshot', async () => {
    const f = await fixture(); f.cache.env.PUBLIC_CACHE_INVALIDATION_SECRET = signingSecret;
    await f.get();
    assert.equal(f.reads(), 1);
    assert.equal((await f.cache.fetch(notification('1'))).status, 200);
    f.cache.lastOriginAt = 0;
    const responses = await Promise.all(Array.from({ length: 5 }, () => f.get()));
    assert.equal(f.reads(), 2);
    for (const response of responses) assert.equal(response.headers.get('X-Khub-Cache'), 'REVALIDATED');
    const saved = [...f.storage.values()][0];
    assert.equal(saved.revision, '1');
    assert.doesNotMatch(JSON.stringify(saved), /signature|abababab/);
});

test('invalidation also dirties sort/filter pages which do not currently contain the changed auction', async () => {
    const f = await fixture(); f.cache.env.PUBLIC_CACHE_INVALIDATION_SECRET = signingSecret;
    await f.get(); f.cache.lastOriginAt = 0; await f.get(`${url}&sort=bids-desc&page=2`);
    assert.equal(f.reads(), 2);
    await f.cache.fetch(notification('2'));
    f.cache.lastOriginAt = 0;
    await f.get(`${url}&sort=bids-desc&page=2`);
    assert.equal(f.reads(), 3);
    assert.equal(f.cache.entries.get(JSON.stringify(publicRequest(url))).revision, '0');
});

test('a bid arriving during an older read prevents it from restoring the invalidated cache', async () => {
    const f = await fixture(); f.cache.env.PUBLIC_CACHE_INVALIDATION_SECRET = signingSecret;
    let started, release;
    const ready = new Promise(resolve => { started = resolve; });
    let reads = 0;
    f.cache.readOrigin = async request => {
        reads++;
        if (reads === 1) { started(); await new Promise(resolve => { release = resolve; }); }
        const data = source(); data.rows[0].current_bid = reads === 1 ? 100 : 200;
        return publicProjection(data, request);
    };
    const pending = f.get(); await ready;
    await f.cache.fetch(notification('1'));
    f.cache.lastOriginAt = 0; release();
    const response = await pending;
    assert.equal(response.status, 200); assert.equal(reads, 2);
    assert.equal((await response.json()).rows[0].current_bid, 200);
    assert.equal([...f.cache.entries.values()][0].revision, '1');
});

test('reordered/repeated hooks cannot roll freshness backward; invalidation survives object restart', async () => {
    const f = await fixture(); f.cache.env.PUBLIC_CACHE_INVALIDATION_SECRET = signingSecret;
    await f.get();
    await f.cache.fetch(notification('3'));
    await f.cache.fetch(notification('1'));
    await f.cache.fetch(notification('3'));
    const restarted = await fixture(f.storage);
    assert.equal(restarted.cache.revision, '3');
    restarted.cache.lastOriginAt = 0;
    assert.equal((await restarted.get()).headers.get('X-Khub-Cache'), 'REVALIDATED');
    assert.equal(restarted.reads(), 1);
});

test('forged/extra/oversized notifications never dirty a snapshot or start a database query', async () => {
    const f = await fixture(); f.cache.env.PUBLIC_CACHE_INVALIDATION_SECRET = signingSecret;
    await f.get();
    for (const payload of [{ revision: '2', signature: '00'.repeat(32) }, { ...signed('2'), bidder_id: 'PRIVATE' },
        { ...signed('2'), revision: '-1' }, { ...signed('2'), revision: 2 }, { ...signed('2'), revision: '9223372036854775808' }]) {
        assert.equal((await f.cache.fetch(new Request('https://cache.internal/invalidate', { method: 'POST', body: JSON.stringify(payload) }))).status, 403);
    }
    assert.equal((await f.cache.fetch(new Request('https://cache.internal/invalidate', { method: 'POST', body: 'x'.repeat(513) }))).status, 400);
    assert.equal(f.cache.revision, '0'); assert.equal(f.reads(), 1);
});

test('a dirty snapshot never falls back to its pre-bid price when the database is down', async () => {
    const f = await fixture(); f.cache.env.PUBLIC_CACHE_INVALIDATION_SECRET = signingSecret;
    await f.get(); await f.cache.fetch(notification('1'));
    f.cache.lastOriginAt = 0; f.cache.readOrigin = async () => { throw Error('database unavailable'); };
    const response = await f.get();
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /current_bid/);
});

test('Pages invalidation endpoint forwards only the bounded signed body and preserves auth failure', async () => {
    let forwarded;
    const env = { PUBLIC_AUCTION_CACHE: { idFromName: () => 'fixed', get: () => ({ fetch(request) {
        forwarded = request; return Response.json({ error: 'Invalid signature.' }, { status: 403 });
    } }) } };
    const response = await invalidateRequest({ env, request: new Request('https://site.test/api/public-auctions/invalidate', {
        method: 'POST', headers: { Authorization: 'SECRET', Cookie: 'PRIVATE' }, body: JSON.stringify(signed('1')),
    }) });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(forwarded.headers.get('Authorization'), null);
    assert.equal(forwarded.headers.get('Cookie'), null);
    assert.deepEqual(await forwarded.json(), signed('1'));
});

test('continuous accepted bids bound refresh retries without republishing an older generation', async () => {
    const f = await fixture(); f.cache.env.PUBLIC_CACHE_INVALIDATION_SECRET = signingSecret;
    let reads = 0;
    f.cache.readOrigin = async request => {
        reads++;
        await f.cache.fetch(notification(String(reads)));
        f.cache.lastOriginAt = 0;
        return publicProjection(source(), request);
    };
    assert.equal((await f.get()).status, 503);
    assert.equal(reads, 2);
    assert.equal(f.cache.entries.size, 0);
    assert.equal(f.cache.cooldownUntil, 0);
});

test('public announcement strips admin fields, caches empty results, and coalesces a visitor burst', async () => {
    const f = await fixture(); let reads = 0;
    f.cache.readOrigin = async request => {
        reads++;
        return publicProjection({ revision: 'public-revision', message: 'Hello!', updated_by: 'PRIVATE-ADMIN', active: true }, request);
    };
    const responses = await Promise.all(Array.from({ length: 100 }, () => f.get('https://cache.internal/public-banner')));
    assert.equal(reads, 1);
    const body = await responses[0].json();
    assert.deepEqual(body.banner, { revision: 'public-revision', message: 'Hello!' });
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE|updated_by|active/);
    assert.equal(publicProjection(null, { view: 'banner' }).banner, null);
    assert.throws(() => publicRequest('https://cache.internal/public-banner?user=private'));
});

test('announcement Pages endpoint uses its own object and strips credentials; admin writes stay direct', async () => {
    let forwarded, objectName;
    const env = { PUBLIC_AUCTION_CACHE: { idFromName(name) { objectName = name; return name; }, get: () => ({ fetch(request) {
        forwarded = request; return Response.json(publicProjection(null, { view: 'banner' }));
    } }) } };
    const response = await bannerRequest({ env, request: new Request('https://site.test/api/public-banner', { headers: { Authorization: 'PRIVATE', Cookie: 'PRIVATE' } }) });
    assert.equal(objectName, 'public-banner-v1'); assert.equal([...forwarded.headers].length, 0);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const calls = [];
    const service = createSiteBannerService({ rpc: async name => { calls.push(name); return { data: {} }; } }, {
        publicRead: () => readPublicBanner({ fetch: async (url, options) => {
            assert.equal(url, '/api/public-banner'); assert.equal(options.credentials, 'omit'); return response;
        } }),
    });
    assert.equal(await service.read(), null); await service.manage(); await service.save('New text', true);
    assert.deepEqual(calls, ['read_admin_site_banner', 'save_site_banner']);
    await assert.rejects(readPublicBanner({ fetch: async () => new Response('busy', { status: 503 }) }), /temporarily unavailable/);
});


test('public seller listings have canonical shared keys; names, financial summaries and private context stay outside', async () => {
    const sellerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const request = { view: 'seller', id: sellerId, status: 'active', sort: 'ending', page: 1 };
    const anon = readerFixture();
    assert.equal(await anon.reader.accepts(request), true);
    assert.equal(await anon.reader.accepts({ ...request, status: 'all' }), true);
    const signedIn = readerFixture('alice');
    assert.equal(await signedIn.reader.accepts(request), true);
    assert.equal(await signedIn.reader.accepts({ ...request, status: 'all' }), false, 'preserve admin/owner draft pagination');
    assert.equal(await signedIn.reader.accepts({ ...request, summaryOnly: true }), false);
    for (const f of [anon, signedIn]) {
        const original = f.client.rpc;
        f.client.rpc = (name, args) => {
            assert.equal(name, 'read_seller_auction_context');
            assert.equal(args.p_seller_id, sellerId);
            assert.deepEqual(args.p_ids, f === anon ? [] : [id]);
            return original(name, args).then(response => ({ data: { ...response.data, seller: { id: sellerId, username: 'PRIVATE-NAME', stats: { value: 'PRIVATE-MONEY' } } } }));
        };
        const data = await f.reader.load(request);
        assert.equal(data.seller.stats.value, 'PRIVATE-MONEY');
        assert.equal(data.rows[0].item, 'Test item');
        assert.doesNotMatch(JSON.stringify(f.requests), /PRIVATE|SECRET|Authorization/);
    }
    const parsed = publicRequest(`https://cache.test/?view=seller&id=${sellerId.toUpperCase()}`);
    assert.equal(parsed.id, sellerId); assert.equal(parsed.status, 'all'); assert.equal(parsed.sort, 'ending');
    for (const bad of ['view=seller', 'view=seller&id=bad', 'view=browse&id='+sellerId]) assert.throws(() => publicRequest('https://cache.test/?'+bad));
    const projected = publicProjection({ ...source(), seller: { username: 'PRIVATE-NAME', stats: { value: 'PRIVATE-MONEY' } } }, parsed);
    assert.equal(projected.seller, null); assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|SECRET/);
});

test('a 200-visitor seller-profile burst shares one public origin read', async () => {
    const f = await fixture();
    const path = 'https://cache.test/?view=seller&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const responses = await Promise.all(Array.from({length:200}, () => f.get(path)));
    assert.equal(f.reads(), 1);
    assert.ok(responses.every(response => response.status === 200));
    const data = await responses[0].json();
    assert.equal(data.seller, null);
    assert.doesNotMatch(JSON.stringify(data), /PRIVATE|SECRET/);
});

test('cache Worker accepts either public-key variable name and rejects privileged keys under either name', async () => {
    const previous = globalThis.fetch, requests = [];
    globalThis.fetch = async (_url, options) => { requests.push(options); return Response.json(source()); };
    try {
        for (const name of ['SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY']) {
            const cache = new PublicAuctionCache({ blockConcurrencyWhile() {}, storage: {}, waitUntil() {} }, {
                SUPABASE_URL: 'https://project.supabase.co', [name]: 'sb_publishable_fixture',
            });
            const result = await cache.readOrigin(publicRequest(url));
            assert.equal(requests.at(-1).headers.apikey, 'sb_publishable_fixture');
            assert.equal(result.rows[0].item, 'Test item');
            const before = requests.length;
            cache.env[name] = `abc.${btoa(JSON.stringify({ role: 'service_role' }))}.sig`;
            await assert.rejects(cache.readOrigin(publicRequest(url)), /temporarily busy/);
            assert.equal(requests.length, before);
        }
        const cache = new PublicAuctionCache({ blockConcurrencyWhile() {}, storage: {}, waitUntil() {} }, {
            SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_canonical',
            VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_alias',
        });
        await cache.readOrigin(publicRequest(url));
        assert.equal(requests.at(-1).headers.apikey, 'sb_publishable_canonical');
    } finally { globalThis.fetch = previous; }
});
