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
    restarted.cache.cooldownUntil = 0; restarted.cache.failures.clear();
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
    const ctx = { storage: { get: async key => structuredClone(storage.get(key)), put: async (key, data) => { if (typeof key === 'object') { for (const [k,v] of Object.entries(key)) storage.set(k, structuredClone(v)); } else storage.set(key, structuredClone(data)); } },
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
    const input = { ...source(), site_totals: { meat: '1420000000', items: '24582', trades: '328', record_bids: '78', balance: 'PRIVATE' } };
    assert.deepEqual(publicProjection(input, { view: 'home' }).site_totals,
        { meat: '1420000000', items: '24582', trades: '328', record_bids: '78' });
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

test('stale reads share refresh, database failure backs off its family, age never slides, clock remains current', async () => {
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
        rpc(name, args) { if (name === 'read_ignore_relationships') return Promise.resolve({ data: false }); rpcCalls.push({ name, args }); return Promise.resolve({ data: { privacy_version: 1,
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
    assert.deepEqual(calls, ['read_home_cards']);
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
    const saved = f.storage.get('public-freshness-v1');
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

 test('ignore eligibility is private, cached and selects personalized pagination only for affected Direct pools', async () => {
    const f = readerFixture('alice');
    let checks = 0;
    const original = f.client.rpc;
    f.client.rpc = (name, args) => name === 'read_ignore_relationships'
        ? (checks++, Promise.resolve({ data: true })) : original(name, args);
    for (const view of ['home', 'browse', 'seller']) {
        assert.equal(await f.reader.accepts({ view, id, status: 'active' }), false);
        assert.equal(await f.reader.accepts({ view, id, status: 'active', trade: 'escrow' }), true);
    }
    assert.equal(await f.reader.accepts({ view: 'detail', id }), true);
    assert.equal(checks, 1);
    assert.equal(f.requests.length, 0);
 });

test('eligibility refreshes after its bounded TTL and session changes; detail/escrow skip eligibility', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        const f = readerFixture('alice');
        let checks = 0, blocked = false;
        f.client.rpc = async () => { checks++; return { data: blocked }; };
        const request = { view: 'browse', status: 'active' };
        assert.equal(await f.reader.accepts(request), true);
        blocked = true;
        assert.equal(await f.reader.accepts(request), true);
        assert.equal(checks, 1);
        now += 60001;
        assert.equal(await f.reader.accepts(request), false);
        assert.equal(checks, 2);
        assert.equal(await f.reader.accepts({ view: 'detail', id }), true);
        assert.equal(await f.reader.accepts({ ...request, trade: 'escrow' }), true);
        assert.equal(checks, 2);
        f.client.auth.getSession = async () => ({ data: { session: { access_token: 'NEW-SCOPE' } } });
        blocked = false;
        assert.equal(await f.reader.accepts(request), true);
        assert.equal(checks, 3);
    } finally { Date.now = realNow; }
});

test('independent live reads get a probe after one Home timeout; two failing families open global circuit', async () => {
    const f = await fixture();
    await f.get(); // Warm browse at the current revision.
    f.cache.lastOriginAt = 0;
    let origins = 0;
    f.cache.readOrigin = async () => { origins++; throw cacheFailure('CACHE_ORIGIN_TIMEOUT'); };
    assert.equal((await f.get('https://site.test/api/public-auctions?view=home')).status, 503);
    assert.equal((await f.get(`https://site.test/api/public-auctions?view=detail-live&id=${id}`)).status, 503);
    assert.equal(origins, 2); // Independent family got one bounded probe.
    assert.ok(f.cache.cooldownUntil > Date.now());
    const browse = await f.get();
    assert.equal(browse.status, 200);
    assert.equal(browse.headers.get('X-Khub-Cache'), 'HIT');
});

test('a legacy dirty listing still cannot return pre-bid prices after isolated family failures', async () => {
    const f = await fixture();
    f.cache.env.PUBLIC_CACHE_INVALIDATION_SECRET = signingSecret;
    await f.get();
    f.cache.lastOriginAt = 0;
    let origins = 0;
    f.cache.readOrigin = async () => { origins++; throw cacheFailure('CACHE_ORIGIN_TIMEOUT'); };
    await f.get('https://site.test/api/public-auctions?view=home');
    await f.cache.fetch(notification('1'));
    const browse = await f.get();
    assert.equal(browse.status, 503);
    assert.doesNotMatch(await browse.text(), /current_bid/);
    assert.equal(origins, 2);
});

const signedAuction = (revision, auction_id = id) => ({ revision, auction_id,
    signature: createHmac('sha256', signingSecret).update(`khub-public-auctions:v2:${revision}:${auction_id}`).digest('hex') });
const scopedNotification = (revision, auction = id) => new Request('https://cache.internal/invalidate', {
    method: 'POST', body: JSON.stringify(signedAuction(revision, auction)),
});
const secondId = '22345678-1234-4123-8123-123456789abc';
async function liveFixture() {
    const f = await fixture();
    f.cache.env.LIVE_AUCTION_STATE = 'true';
    f.cache.env.PUBLIC_CACHE_INVALIDATION_SECRET = signingSecret;
    const calls = [];
    f.cache.readOrigin = async request => {
        calls.push(request);
        f.cache.lastOriginAt = 0;
        const input = source();
        if (request.view === 'batch-live') input.rows = request.ids.map(auction => ({ ...input.rows[0], id: auction, current_bid: 200 }));
        return publicProjection(input, request);
    };
    return { ...f, calls, get: (target = url) => f.cache.fetch(new Request(target, { headers: { 'X-Khub-Live-State': '1' } })) };
}

test('live mode coalesces a visitor burst and reuses auction state across different browse keys', async () => {
    const f = await liveFixture();
    const responses = await Promise.all(Array.from({ length: 100 }, () => f.get()));
    assert.equal(f.calls.filter(q => q.view === 'browse').length, 1);
    assert.equal(f.calls.filter(q => q.view === 'batch-live').length, 1);
    assert.equal((await responses[0].json()).rows[0].current_bid, 200);
    await f.get(`${url}&sort=ending`);
    assert.equal(f.calls.filter(q => q.view === 'batch-live').length, 1);
});

test('scoped invalidation refreshes live bid state without rebuilding listing selection', async () => {
    const f = await liveFixture();
    await f.get();
    await f.cache.fetch(scopedNotification('1'));
    const response = await f.get();
    const body = await response.json();
    assert.equal(body.rows[0].current_bid, 200);
    assert.equal(body.public_snapshot.ordering_delayed, true);
    assert.equal(f.calls.filter(q => q.view === 'browse').length, 1);
    assert.equal(f.calls.filter(q => q.view === 'batch-live').length, 2);
});

test('unrelated scoped bids preserve live state and out-of-order notifications remain effective', async () => {
    const f = await liveFixture();
    await f.get();
    await f.cache.fetch(scopedNotification('4', secondId));
    await f.get();
    assert.equal(f.calls.filter(q => q.view === 'batch-live').length, 1);
    await f.cache.fetch(scopedNotification('3', id));
    await f.get();
    assert.equal(f.calls.filter(q => q.view === 'batch-live').length, 2);
    assert.equal(f.cache.revision, '4');
    const forged = signedAuction('5'); forged.auction_id = secondId;
    assert.equal((await f.cache.fetch(new Request('https://cache.internal/invalidate', { method: 'POST', body: JSON.stringify(forged) }))).status, 403);
});

test('failed live verification returns catalogue facts without any old bidding information', async () => {
    const f = await liveFixture();
    await f.get();
    await f.cache.fetch(scopedNotification('1'));
    f.cache.readOrigin = async () => { f.cache.lastOriginAt = 0; throw cacheFailure('CACHE_ORIGIN_TIMEOUT'); };
    const response = await f.get();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rows[0].item, 'Test item');
    assert.equal(body.rows[0]._live_unavailable, true);
    for (const field of ['current_bid','min_bid_meat','bid_count','end_time','status','final_price','available_quantity','has_winner']) {
        assert.equal(Object.hasOwn(body.rows[0], field), false, field);
    }
    assert.equal(body.public_snapshot.live_unavailable, true);
});

test('family cooldown, global breaker and single origin scheduler remain bounded in live mode', async () => {
    const f = await liveFixture();
    let origins = 0;
    f.cache.readOrigin = async request => {
        f.cache.lastOriginAt = 0; origins++;
        if (request.view === 'home' || request.view === 'browse') throw cacheFailure('CACHE_ORIGIN_TIMEOUT');
        return publicProjection(source(), request);
    };
    assert.equal((await f.get('https://cache.test/?view=home')).status, 503);
    assert.equal((await f.get('https://cache.test/?view=home')).status, 503);
    assert.equal(origins, 1);
    const detail = await f.get(`https://cache.test/?view=detail-live&id=${id}`);
    assert.equal(detail.status, 200);
    assert.equal(origins, 2);
    assert.equal((await f.get()).status, 503);
    const before = origins;
    assert.equal((await f.get(`https://cache.test/?view=detail-live&id=${secondId}`)).status, 503);
    assert.equal(origins, before);
});

test('private overlays are reused during shared live polling and cannot override newer prices', async () => {
    let privateCalls = 0;
    const session = { access_token: 'viewer-token', user: { id: 'viewer' } };
    const client = { auth: { getSession: async () => ({ data: { session } }) }, rpc: async name => {
        if (name === 'read_ignore_relationships') return { data: false };
        privateCalls++;
        return { data: { privacy_version: 1, rows: [{ id, current_bid: 100, seller_id: 'owner', highest_bidder_id: 'viewer', viewer_is_highest_bidder: true }] } };
    } };
    const fetcher = async () => Response.json({ privacy_version: 1, shared_cache_version: 1, rows: [{ id, current_bid: 200 }], bids: [], total: 1,
        public_snapshot: { live_mode: true } });
    const reader = createPublicAuctionReader(client, { enabled: true, fetch: fetcher });
    const request = publicRequest(url);
    await reader.accepts(request);
    await reader.load(request);
    const result = await reader.load(request);
    assert.equal(privateCalls, 1);
    assert.equal(result.rows[0].current_bid, 200);
    assert.equal(result.rows[0].highest_bidder_id, null);
    assert.equal(result.rows[0].viewer_is_highest_bidder, null);
    session.access_token = 'changed-authorization';
    await reader.accepts(request);
    await reader.load(request);
    assert.equal(privateCalls, 2);
});

test('legacy invalidations dirty all live auctions and survive object restart', async () => {
    const f = await liveFixture();
    await f.get();
    await f.cache.fetch(notification('8'));
    const restarted = await fixture(f.storage);
    assert.equal(restarted.cache.changed({ view: 'batch-live', ids: [secondId] }, '7'), true);
    assert.equal(restarted.cache.changed({ view: 'batch-live', ids: [secondId] }, '8'), false);
});

test('live mode rejects catalogue fallback beyond the five-minute bound', async () => {
    const f = await liveFixture();
    await f.get();
    for (const entry of f.cache.entries.values()) entry.storedAt -= 300001;
    f.cache.readOrigin = async () => { throw cacheFailure('CACHE_ORIGIN_TIMEOUT'); };
    const response = await f.get();
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /Test item|current_bid/);
});

test('live refresh failure preserves fresh sibling auctions and marks only missing states unavailable', async () => {
    const f = await liveFixture();
    const original = f.cache.readOrigin;
    f.cache.readOrigin = async request => {
        const data = await original(request);
        if (request.view === 'browse') data.rows.push({ ...data.rows[0], id: secondId });
        if (request.view === 'batch-live') data.rows = data.rows.filter(row => row.id !== secondId);
        return data;
    };
    const body = await (await f.get()).json();
    assert.equal(body.rows.find(row => row.id === id).current_bid, 200);
    assert.equal(body.rows.find(row => row.id === secondId)._live_unavailable, true);
    assert.equal(body.public_snapshot.live_unavailable, true);
});

test('scoped live metadata persists across restart without turning unrelated auctions dirty', async () => {
    const f = await liveFixture();
    await f.cache.fetch(scopedNotification('4', secondId));
    const restarted = await fixture(f.storage);
    assert.equal(restarted.cache.changed({ view: 'batch-live', ids: [id] }, '0'), false);
    assert.equal(restarted.cache.changed({ view: 'batch-live', ids: [secondId] }, '0'), true);
});

test('new live responses require client capability; old clients never receive catalogue-only rows', async () => {
    const f = await liveFixture();
    const legacy = await f.cache.fetch(new Request(url));
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).public_snapshot.live_mode, undefined);
    assert.equal(f.calls.filter(q => q.view === 'batch-live').length, 0);
});

test('site proxy forwards only a fixed live capability and never browser credentials', async () => {
    let forwarded;
    const env = { PUBLIC_AUCTION_CACHE: { idFromName: () => 'fixed', get: () => ({ fetch(request) {
        forwarded = request;
        return Response.json({ ok: true });
    } }) } };
    await onRequest({ env, request: new Request(url, { headers: { 'X-Khub-Live-State': '1', Authorization: 'PRIVATE', Cookie: 'PRIVATE' } }) });
    assert.equal(forwarded.headers.get('X-Khub-Live-State'), '1');
    assert.equal(forwarded.headers.get('Authorization'), null);
    assert.equal(forwarded.headers.get('Cookie'), null);
});

test('one failed live auction does not block a healthy unrelated live auction', async () => {
    const f = await liveFixture();
    let origins = 0;
    f.cache.readOrigin = async request => {
        f.cache.lastOriginAt = 0; origins++;
        if (request.ids?.includes(id)) throw cacheFailure('CACHE_ORIGIN_TIMEOUT');
        const input = source(); input.rows[0].id = secondId;
        return publicProjection(input, request);
    };
    assert.equal((await f.get(`https://cache.test/?view=detail-live&id=${id}`)).status, 503);
    assert.equal((await f.get(`https://cache.test/?view=detail-live&id=${id}`)).status, 503);
    assert.equal(origins, 1);
    const other = await f.get(`https://cache.test/?view=detail-live&id=${secondId}`);
    assert.equal(other.status, 200);
    assert.equal((await other.json()).rows[0].current_bid, 100);
    assert.equal(origins, 2);
    assert.equal(f.cache.cooldownUntil, 0);
});

test('a failed missing-state batch still serves a verified cached sibling state', async () => {
    const f = await liveFixture();
    await f.get();
    const original = f.cache.readOrigin;
    f.cache.readOrigin = async request => {
        f.cache.lastOriginAt = 0;
        if (request.view === 'batch-live') throw cacheFailure('CACHE_ORIGIN_TIMEOUT');
        const data = await original(request);
        data.rows.push({ ...data.rows[0], id: secondId });
        return data;
    };
    const response = await f.get(`${url}&sort=ending`);
    const body = await response.json();
    assert.equal(body.rows.find(row => row.id === id).current_bid, 200);
    assert.equal(body.rows.find(row => row.id === secondId)._live_unavailable, true);
});

test('expired live-mode selection refresh runs behind live verification and does not delay its response', async () => {
    const f=await liveFixture();await f.get();
    const entry=[...f.cache.entries.values()].find(e=>!e.ephemeral);
    entry.storedAt=Date.now()-31000;
    f.cache.liveStates.clear();
    for(const e of f.cache.entries.values())if(e.ephemeral)e.storedAt=Date.now()-3000;
    let release;const held=new Promise(resolve=>{release=resolve;});
    const read=f.cache.readOrigin;
    f.cache.readOrigin=async request=>{
        if(request.view==='browse')await held;
        return await read(request);
    };
    const response=await f.get();
    const body=await response.json();
    assert.equal(body.rows[0].current_bid,200);
    assert.equal(body.public_snapshot.ordering_delayed,true);
    release();await Promise.all(f.waits);
});

test('bid invalidation writes only freshness metadata and live payloads are reconstructible',async()=>{
    const f=await liveFixture();await f.get();
    const payload=structuredClone(f.storage.get('public-snapshots-v1'));
    assert.ok(payload.entries.every(([,entry])=>!entry.ephemeral));
    await f.cache.fetch(scopedNotification('9'));
    assert.deepEqual(f.storage.get('public-snapshots-v1'),payload);
    assert.equal(f.storage.get('public-freshness-v1').revision,'9');
});

test('a relist overlays its reduced minimum and new custom deadline with one shared live refresh', async () => {
    const f = await liveFixture();
    let relisted = false;
    const origin = f.cache.readOrigin;
    f.cache.readOrigin = async request => {
        const data = await origin(request);
        if (request.view === 'batch-live') data.rows = data.rows.map(row => ({ ...row,
            min_bid_meat: relisted ? 95 : 100,
            custom_end_at: relisted ? '2027-01-02T00:00:00Z' : '2027-01-01T00:00:00Z',
        }));
        return data;
    };
    await f.get();
    relisted = true;
    await f.cache.fetch(scopedNotification('1'));
    const responses = await Promise.all(Array.from({ length: 100 }, () => f.get()));
    for (const response of responses) {
        const row = (await response.json()).rows[0];
        assert.equal(row.min_bid_meat, 95);
        assert.equal(row.custom_end_at, '2027-01-02T00:00:00Z');
    }
    assert.equal(f.calls.filter(q => q.view === 'browse').length, 1);
    assert.equal(f.calls.filter(q => q.view === 'batch-live').length, 2);
});

test('an aborted eligibility check is not reused by Retry after a stalled private read', async () => {
    let calls = 0;
    const client = {
        auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-token' } } }) },
        rpc() { calls++; return calls === 1 ? new Promise(() => {}) : Promise.resolve({ data: false }); },
    };
    const reader = createPublicAuctionReader(client, { enabled: true });
    const controller = new AbortController();
    const first = reader.accepts({ view: 'home', signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('Page read expired'));
    await assert.rejects(first, /Page read expired/);
    assert.equal(await reader.accepts({ view: 'home' }), true);
    assert.equal(calls, 2);
});

test('queued overlapping live requests reuse verified state without renewing freshness', async () => {
    const f = await liveFixture();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const original = f.cache.readOrigin.bind(f.cache);
    f.cache.readOrigin = async request => { await gate; return original(request); };
    const batch = { view: 'batch-live', ids: [id, secondId] };
    const detail = { view: 'detail-live', id };
    const first = f.cache.refresh(JSON.stringify(batch), batch);
    const second = f.cache.refresh(JSON.stringify(detail), detail);
    release();
    const [a,b] = await Promise.all([first,second]);
    assert.equal(f.calls.length, 1, 'one origin read serves both queued requests');
    assert.equal(b.storedAt,a.storedAt, 'reuse cannot extend the two-second TTL');
    assert.equal(b.data.rows.length,1);
    assert.equal(b.data.rows[0].id,id);
    assert.equal(b.data.rows[0].current_bid,200);
    await f.cache.fetch(scopedNotification('1',id));
    await f.cache.refresh(JSON.stringify(detail),detail);
    assert.equal(f.calls.length,2,'an invalidated auction must be verified again');
});

test('expired or incomplete live coverage never suppresses an origin read', async () => {
    const f = await liveFixture();
    const single = { view: 'detail-live', id };
    await f.cache.refresh(JSON.stringify(single),single);
    const value=f.cache.liveStates.get(id);
    value.at=Date.now()-2001;
    await f.cache.refresh(JSON.stringify(single),single);
    assert.equal(f.calls.length,2);
    const batch={view:'batch-live',ids:[id,secondId]};
    await f.cache.refresh(JSON.stringify(batch),batch);
    assert.equal(f.calls.length,3,'partial coverage still reads every requested ID');
});

test('live queue reuse retains conservative timestamps and is disabled for legacy mode', async () => {
    const f=await liveFixture();
    const at=Date.now();
    f.cache.liveStates.set(id,{row:{...source().rows[0],current_bid:300},at:at-1000,revision:'0',server_time:new Date(at-1000).toISOString()});
    f.cache.liveStates.set(secondId,{row:{...source().rows[0],id:secondId,current_bid:400},at:at-500,revision:'0',server_time:new Date(at-500).toISOString()});
    const query={view:'batch-live',ids:[id,secondId]};
    const entry=f.cache.cachedLiveEntry(query);
    assert.equal(entry.storedAt,at-1000);
    assert.equal(Date.parse(entry.data.server_time),at-1000);
    assert.deepEqual(entry.data.rows.map(row=>row.current_bid),[300,400]);
    assert.equal(f.cache.cachedLiveEntry({view:'browse'}),null);
    f.cache.env.LIVE_AUCTION_STATE='false';
    assert.equal(f.cache.cachedLiveEntry(query),null);
});

test('Home transports bounded per-type selections and rejects oversized sections or live batches', () => {
    const input = source();
    input.rows = Array.from({ length: 130 }, (_, index) => ({ ...input.rows[0], id: `fixture-${index}` }));
    input.total = 130;
    input.sections = { popular: [], new: [], ending: [], highRollers: [], recent: [], popular_buy: input.rows.slice(120).map(row => row.id) };
    const result = publicProjection(input, { view: 'home' });
    assert.deepEqual(result.sections.popular_buy, input.sections.popular_buy);
    assert.equal(result.rows.length, 130);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET/);
    input.sections.popular_buy = input.rows.slice(0, 25).map(row => row.id);
    assert.throws(() => publicProjection(input, { view: 'home' }), /Invalid public section/);
    input.rows = Array.from({ length: 337 }, () => source().rows[0]);
    assert.throws(() => publicProjection(input, { view: 'batch-live' }));
});
