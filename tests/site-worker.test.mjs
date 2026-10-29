import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import site from '../workers/site/index.js';
import { publicRequest, publicProjection } from '../workers/public-auction-cache/protocol.js';

const origin = 'https://kolauction.test';
function fixture() {
    const calls = [], assetCalls = [];
    return { calls, assetCalls, env: {
        ASSETS: { async fetch(request) { assetCalls.push(request); return new Response('SPA or static asset', { headers: { 'Content-Type': 'text/html' } }); } },
        PUBLIC_AUCTION_CACHE: {
            idFromName(name) { calls.push({ name }); return name; },
            get(id) { return { async fetch(request) {
                calls.push({ id, url: request.url, method: request.method, headers: [...request.headers], body: await request.clone().text() });
                return Response.json({ ok: true }, { headers: { 'X-Khub-Cache': 'HIT' } });
            } }; },
        },
    } };
}

for (const path of ['/api/public-auctions?view=home', '/api/public-auctions/?view=browse', '/api/public-banner']) {
    test(`website Worker runs the existing API handler for ${path}`, async () => {
        const f = fixture();
        const response = await site.fetch(new Request(origin + path, { headers: { Cookie: 'private', Authorization: 'Bearer private', 'X-User-ID': 'private' } }), f.env);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Type'), 'application/json');
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(response.headers.get('X-Khub-Cache'), 'HIT');
        assert.equal(f.assetCalls.length, 0);
        assert.equal(f.calls[0].name, path.includes('public-banner') ? 'public-banner-v1' : 'public-auctions-v1');
        assert.deepEqual(f.calls[1].headers, []);
        assert.equal(f.calls[1].method, 'GET');
        assert.equal(f.calls[1].body, '');
    });
}

test('signed invalidation forwards only the revision/signature payload to the existing object', async () => {
    const f = fixture(), body = { revision: '12', signature: 'a'.repeat(64) };
    const response = await site.fetch(new Request(origin + '/api/public-auctions/invalidate', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'private', Authorization: 'Bearer private' }, body: JSON.stringify(body),
    }), f.env);
    assert.equal(response.status, 200);
    assert.equal(f.calls[0].name, 'public-auctions-v1');
    assert.equal(f.calls[1].url, 'https://cache.internal/invalidate');
    assert.deepEqual(JSON.parse(f.calls[1].body), body);
    assert.deepEqual(f.calls[1].headers, [['content-type', 'application/json']]);
    assert.equal(f.assetCalls.length, 0);
});

for (const [path, method, status] of [
    ['/api/public-auctions', 'POST', 405], ['/api/public-banner', 'POST', 405],
    ['/api/public-auctions/invalidate', 'GET', 405], ['/api/missing', 'GET', 404], ['/api', 'GET', 404],
]) {
    test(`${method} ${path} returns ${status} without SPA fallback`, async () => {
        const f = fixture();
        const response = await site.fetch(new Request(origin + path, { method }), f.env);
        assert.equal(response.status, status);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.match(response.headers.get('Content-Type'), /application\/json/);
        assert.equal(f.assetCalls.length, 0);
        assert.equal(f.calls.length, 0);
    });
}

test('missing cache binding returns an explicit API error instead of index.html', async () => {
    const f = fixture(); delete f.env.PUBLIC_AUCTION_CACHE;
    const response = await site.fetch(new Request(origin + '/api/public-auctions?view=home'), f.env);
    assert.equal(response.status, 503);
    assert.match(response.headers.get('Content-Type'), /application\/json/);
    assert.equal(f.assetCalls.length, 0);
});

for (const path of ['/', '/profile', '/seller/some-profile?view=stats', '/auction/some-auction', '/assets/app.js', '/meet-the-creator']) {
    test(`website assets and navigation are preserved for ${path}`, async () => {
        const f = fixture(), request = new Request(origin + path, { headers: { 'Sec-Fetch-Mode': 'navigate' } });
        const response = await site.fetch(request, f.env);
        assert.equal(await response.text(), 'SPA or static asset');
        assert.equal(f.assetCalls[0], request);
        assert.equal(f.calls.length, 0);
    });
}

test('root deployment config enables the runtime and binds the existing external namespace', async () => {
    const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    assert.equal(config.name, 'kolauction');
    assert.equal(config.main, 'workers/site/index.js');
    assert.equal(config.assets.directory, './build');
    assert.equal(config.assets.binding, 'ASSETS');
    assert.equal(config.assets.not_found_handling, 'single-page-application');
    assert.deepEqual(config.assets.run_worker_first, ['/api', '/api/*']);
    assert.deepEqual(config.durable_objects.bindings, [{ name: 'PUBLIC_AUCTION_CACHE', class_name: 'PublicAuctionCache', script_name: 'khub-public-auction-cache' }]);
    assert.equal(config.migrations, undefined, 'namespace/storage ownership remains with the cache Worker');
    assert.equal(config.build.command, 'npm run build:cloudflare');
});

test('real public-cache projection stays allowlisted through the website adapter', async () => {
    const f = fixture();
    f.env.PUBLIC_AUCTION_CACHE.get = () => ({ fetch: async request => Response.json(publicProjection({
        privacy_version: 1, server_time: new Date().toISOString(), total: 1, bids: [],
        rows: [{ id: 'public-auction', status: 'active', item: 'toast', seller_id: 'PRIVATE', balance_meat: 'PRIVATE', my_reservation: 'PRIVATE' }],
    }, publicRequest(request.url))) });
    const response = await site.fetch(new Request(origin + '/api/public-auctions?view=browse'), f.env);
    assert.doesNotMatch(await response.text(), /PRIVATE|balance_meat|my_reservation|seller_id/);
});
