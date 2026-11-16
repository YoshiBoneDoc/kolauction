import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/game-login.js';
import site from '../workers/site/index.js';
import { createGameLoginBridge } from '../src/lib/gameLogin.js';

const id = '12345678-1234-1234-1234-123456789abc';
const origin = 'https://khub.test';
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const privateKey = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key',
    GAME_FIREBASE_CLIENT_EMAIL: 'game@mmo7-5864a.iam.gserviceaccount.com',
    GAME_FIREBASE_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(privateKey))) };
const request = (options = {}) => new Request(`${origin}/api/game-login`, {
    method: 'POST', headers: { Authorization: 'Bearer signed.user.token', Origin: origin }, ...options,
});
const user = { id, user_metadata: { khub_username: 'FORGED' } };
const profile = { id, khub_username: 'KoL Player', is_banned: false, access_version: 1, is_admin: false };
function upstream({ account = profile, identity = user, userStatus = 200, profileStatus = 200 } = {}) {
    const calls = [];
    return { calls, fetcher: async (url, options) => {
        calls.push({ url, options });
        assert.equal(options.redirect, 'manual');
        assert.equal(options.headers.apikey, 'public-test-key');
        assert.equal(options.headers.Authorization, 'Bearer signed.user.token');
        return url.endsWith('/auth/v1/user') ? Response.json(identity, { status: userStatus }) : Response.json(account, { status: profileStatus });
    } };
}

test('khub login verifies the live user and account, then signs only authoritative username claims', async () => {
    const f = upstream();
    const response = await onRequest({ request: request({ body: JSON.stringify({ username: 'FORGED', admin: true }) }), env }, f.fetcher);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const { customToken } = await response.json();
    const [header, payload, signature] = customToken.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claims.uid, `khub:${id}`);
    assert.equal(claims.aud, 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit');
    assert.equal(claims.exp - claims.iat, 300);
    assert.deepEqual(claims.claims, { khub_user_id: id, khub_username: 'KoL Player', khub_is_admin: false });
    assert(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keyPair.publicKey, Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${payload}`)));
    assert.equal(f.calls.length, 2);
    assert(f.calls[1].url.endsWith('/rest/v1/rpc/read_my_account_access'));
});

test('invalid methods, missing sessions, wrong origin, and missing secrets fail closed without Supabase reads', async () => {
    const noFetch = () => assert.fail('must reject before upstream');
    for (const [req, config, status] of [
        [new Request(`${origin}/api/game-login`), env, 405],
        [request({ headers: {} }), env, 401],
        [request({ headers: { Authorization: 'Bearer signed.user.token', Origin: 'https://evil.test' } }), env, 403],
        [request(), { ...env, GAME_FIREBASE_PRIVATE_KEY: '' }, 503],
    ]) assert.equal((await onRequest({ request: req, env: config }, noFetch)).status, status);
});

for (const [description, options, status] of [
    ['expired session', { userStatus: 401 }, 401],
    ['Supabase failure', { userStatus: 500 }, 503],
    ['banned account', { account: { ...profile, is_banned: true } }, 403],
    ['missing ban decision', { account: { id, khub_username: 'Player' } }, 503],
    ['another user profile', { account: { ...profile, id: '00000000-0000-0000-0000-000000000000' } }, 503],
    ['invalid username', { account: { ...profile, khub_username: 'not\na name' } }, 409],
    ['account RPC failure', { profileStatus: 503 }, 503],
]) test(`game login rejects ${description} without issuing a token`, async () => {
    const f = upstream(options);
    const response = await onRequest({ request: request(), env }, f.fetcher);
    assert.equal(response.status, status);
    const body = await response.json();
    assert(!body.customToken);
    assert(!JSON.stringify(body).includes('signed.user.token'));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

function bridgeFixture({ session = { access_token: 'private-supabase-session', user: { id } }, expectedId = id, fetcher } = {}) {
    let listener;
    const messages = [], reads = [], requests = [];
    const child = { postMessage: (...args) => messages.push(args) };
    const host = { addEventListener: (_type, receive) => { listener = receive; }, removeEventListener: () => { listener = null; } };
    const dispose = createGameLoginBridge({ frame: { contentWindow: child }, gameOrigin: 'https://game.test', userId: expectedId, host,
        getSession: async () => { reads.push(1); return { data: { session } }; },
        fetcher: fetcher || (async (url, options) => { requests.push({ url, options }); return Response.json({ customToken: 'firebase-custom-token' }); }),
    });
    const event = { source: child, origin: 'https://game.test', data: { type: 'khub:game-login', requestId: crypto.randomUUID() } };
    return { receive: event => listener(event), event, messages, reads, requests, dispose };
}

test('only the expected frame and exact origin can request a game token', async () => {
    const f = bridgeFixture();
    await f.receive({ ...f.event, source: {} });
    await f.receive({ ...f.event, origin: 'https://evil.test' });
    await f.receive({ ...f.event, data: { ...f.event.data, requestId: null } });
    assert.equal(f.reads.length, 0);
    await f.receive(f.event);
    assert.equal(f.requests[0].options.headers.Authorization, 'Bearer private-supabase-session');
    assert.equal(f.messages[0][1], 'https://game.test');
    assert.equal(f.messages[0][0].customToken, 'firebase-custom-token');
    assert(!JSON.stringify(f.messages).includes('private-supabase-session'));
    f.dispose();
});

test('signed-out and switched website accounts cannot use a stale session', async () => {
    for (const config of [{ session: null }, { expectedId: null }, { session: { access_token: 'secret', user: { id: 'different-user' } } }]) {
        const f = bridgeFixture(config);
        await f.receive(f.event);
        assert.equal(f.requests.length, 0);
        assert.equal(f.messages[0][0].error, 'Login on khub first');
        f.dispose();
    }
});

test('duplicate in-flight requests are coalesced and disposed frames never receive tokens', async () => {
    let finish;
    const f = bridgeFixture({ fetcher: () => new Promise(resolve => { finish = resolve; }) });
    const active = f.receive(f.event);
    await Promise.resolve();
    await f.receive(f.event);
    assert.equal(f.reads.length, 1);
    f.dispose();
    finish(Response.json({ customToken: 'do-not-deliver' }));
    await active;
    assert.equal(f.messages.length, 0);
});

test('the website Worker serves the game login API instead of SPA HTML', async () => {
    const assets = { fetch() { assert.fail('private API must never fall back to assets'); } };
    const get = await site.fetch(new Request(`${origin}/api/game-login`), { ASSETS: assets });
    assert.equal(get.status, 405);
    const post = await site.fetch(request({ headers: {} }), { ASSETS: assets });
    assert.equal(post.status, 401);
    assert.equal(post.headers.get('Content-Type'), 'application/json');
});

test('login accepts a JSON-quoted key and reports signing failures without revealing secrets', async () => {
    const f = upstream();
    const quoted = await onRequest({ request: request(), env: { ...env, GAME_FIREBASE_PRIVATE_KEY: JSON.stringify(env.GAME_FIREBASE_PRIVATE_KEY) } }, f.fetcher);
    assert.equal(quoted.status, 200);
    const failed = await onRequest({ request: request(), env: { ...env, GAME_FIREBASE_PRIVATE_KEY: 'not-a-valid-private-key' } }, f.fetcher);
    assert.equal(failed.status, 503);
    const body = await failed.json();
    assert.match(body.error, /firebase-signing/);
    assert(!JSON.stringify(body).includes('not-a-valid-private-key'));
});


test('redirected Supabase requests fail without forwarding credentials', async () => {
    let calls = 0;
    const response = await onRequest({ request: request(), env }, async (_url, options) => {
        calls++;
        assert.equal(options.redirect, 'manual');
        return new Response(null, { status: 302, headers: { Location: 'https://other.example/' } });
    });
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
});


test('only the authoritative account response can grant game admin', async () => {
    for (const isAdmin of [true, false]) {
        const f = upstream({ account: { ...profile, is_admin: isAdmin } });
        const response = await onRequest({ request: request({ body: JSON.stringify({ is_admin: !isAdmin }) }), env }, f.fetcher);
        assert.equal(response.status, 200);
        const { customToken } = await response.json();
        assert.equal(JSON.parse(Buffer.from(customToken.split('.')[1], 'base64url')).claims.khub_is_admin, isAdmin);
    }
});
