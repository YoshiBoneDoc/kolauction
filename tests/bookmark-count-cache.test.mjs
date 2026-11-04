import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicAuctionCache } from '../workers/public-auction-cache/index.js';
import { publicRequest, publicProjection } from '../workers/public-auction-cache/protocol.js';
import { onRequest } from '../functions/api/public-bookmark-counts.js';
const id = '12345678-1234-4123-8123-123456789abc';
const other = '22345678-1234-4123-8123-123456789abc';
const secret = 'a'.repeat(64);
const query = `https://cache.internal/public-bookmark-counts?ids=${id}`;
function fixture() {
    const cache = new PublicAuctionCache({ blockConcurrencyWhile() {}, storage: { async put() {} }, waitUntil() {} }, { PUBLIC_CACHE_INVALIDATION_SECRET: secret });
    let reads = 0;
    cache.readOrigin = async request => { reads++; return publicProjection([{ auction_id: request.ids[0], bookmark_count: 3, user_id: 'PRIVATE' }], request); };
    return { cache, reads: () => reads };
}
test('bookmark batch canonicalizes, bounds requests and projects only aggregate counts', () => {
    assert.deepEqual(publicRequest(`${query},${id}`).ids, [id]);
    assert.throws(() => publicRequest(`${query},bad`));
    assert.throws(() => publicRequest(`${query}&token=private`));
    assert.throws(() => publicRequest(`${query},${Array(24).fill(other).join(',')}`));
    assert.throws(() => publicProjection([{ auction_id: other, bookmark_count: 3 }], { view: 'bookmarks', ids: [id] }));
});
test('concurrent visitors and page refreshes share one origin read for 5 minutes', async () => {
    const { cache, reads } = fixture();
    const responses = await Promise.all(Array.from({ length: 15 }, () => cache.fetch(new Request(query))));
    assert.equal(reads(), 1);
    for (const response of responses) { assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /PRIVATE/); }
    const entry = [...cache.entries.values()][0];
    entry.storedAt = Date.now() - 4 * 60 * 1000;
    assert.equal((await cache.fetch(new Request(query))).headers.get('X-Khub-Cache'), 'HIT');
    assert.equal(reads(), 1);
    entry.storedAt = Date.now() - 6 * 60 * 1000;
    cache.lastOriginAt = 0;
    await Promise.all(Array.from({ length: 10 }, () => cache.fetch(new Request(query))));
    assert.equal(reads(), 2);
});
test('bookmark cache survives restart within count TTL without re-reading the database', async () => {
    const key = JSON.stringify(publicRequest(query));
    const entry = { storedAt: Date.now() - 4 * 60 * 1000, revision: '0', data: { counts: [{ auction_id: id, bookmark_count: 3 }], server_time: new Date().toISOString() } };
    let ready;
    const cache = new PublicAuctionCache({ blockConcurrencyWhile(fn) { ready = fn(); }, storage: {
        async get() { return { entries: [[key, entry]] }; }, async put() {},
    }, waitUntil() {} }, {});
    await ready;
    cache.readOrigin = async () => { throw new Error('Should not read origin'); };
    assert.equal((await cache.fetch(new Request(query))).headers.get('X-Khub-Cache'), 'HIT');
});
test('forwarder isolates bookmark cache and strips private request headers', async () => {
    const response = await onRequest({ request: new Request('https://site.test/api/public-bookmark-counts?ids='+id, { headers: { Authorization: 'PRIVATE', Cookie: 'PRIVATE' } }), env: {
        PUBLIC_AUCTION_CACHE: { idFromName(name) { assert.equal(name, 'public-bookmarks-v1'); return name; }, get() { return { async fetch(request) {
            assert.equal(request.headers.get('Authorization'), null); assert.equal(request.headers.get('Cookie'), null);
            assert.match(request.url, /public-bookmark-counts/); return Response.json({ counts: [] });
        } }; } },
    } });
    assert.equal(response.status, 200);
});

test('Vite preview serves the real count protocol and shares origin reads across visitors', async () => {
    const { createBookmarkCountPreview } = await import('../scripts/bookmarkCountPreview.mjs');
    const originalFetch = globalThis.fetch;
    let reads = 0;
    try {
        globalThis.fetch = async (url, options) => {
            reads++;
            assert.match(String(url), /rpc\/read_auction_bookmark_counts/);
            assert.deepEqual(JSON.parse(options.body), { p_ids: [id] });
            assert.equal(options.headers.Cookie, undefined);
            return Response.json([{ auction_id: id, bookmark_count: 2 }]);
        };
        const preview = createBookmarkCountPreview({ VITE_SUPABASE_URL: 'https://project.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' });
        for (let i = 0; i < 3; i++) {
            const response = await preview(new Request('http://localhost/api/public-bookmark-counts?ids='+id));
            assert.equal(response.status, 200);
            assert.match(response.headers.get('Content-Type'), /application\/json/);
            const data = await response.json();
            assert.equal(data.counts[0].bookmark_count, 2);
            assert.ok(Number.isFinite(Date.parse(data.read_started_at)));
            assert.ok(Number.isFinite(Date.parse(data.public_snapshot.captured_at)));
        }
        assert.equal(reads, 1);
    } finally { globalThis.fetch = originalFetch; }
});
