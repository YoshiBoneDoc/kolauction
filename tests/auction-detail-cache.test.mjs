import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRequest, publicProjection, originRequest } from '../workers/public-auction-cache/protocol.js';
const id = '11111111-1111-1111-1111-111111111111';
test('detail queries accept only a public auction ID and fixed view', () => {
    const query = publicRequest(`https://cache/public-auctions?view=detail-live&id=${id}`);
    assert.deepEqual(originRequest(query), { rpc: 'read_public_auction_detail_state', args: { p_id: id } });
    assert.throws(() => publicRequest(`https://cache/public-auctions?view=detail-live&id=${id}&token=secret`));
});
test('live snapshots exclude identities, descriptions and bundles while keeping the deadline', () => {
    const data = publicProjection({ privacy_version: 1, rows: [{ id, status: 'active', current_bid: 42,
        bid_deadline: '2026-10-30T12:00:00Z', seller_id: 'private', item: 'static', bundle_items: [{ name: 'static' }],
        highest_bidder_id: 'private', description: 'private' }], bids: [], total: 1, server_time: new Date().toISOString() }, { view: 'detail-live' });
    assert.deepEqual(data.rows[0], { id, status: 'active', current_bid: 42, bid_deadline: '2026-10-30T12:00:00Z' });
});

import { PublicAuctionCache } from '../workers/public-auction-cache/index.js';
import { createPublicAuctionReader } from '../src/lib/publicAuctionReader.js';

test('featured cache shares reads, expires at 30 seconds, and refreshes at the deadline', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        let ready;
        const store = new Map();
        const cache = new PublicAuctionCache({
            blockConcurrencyWhile(fn) { ready = fn(); }, waitUntil() {},
            storage: { get: async key => store.get(key), put: async (key, value) => store.set(key, value) },
        }, {});
        await ready;
        let reads = 0;
        let deadline = now + 100000;
        cache.readOrigin = async query => {
            reads++;
            return { ...publicProjection({ id, status: 'active', giveaway_title: 'Title', current_bid: reads,
                end_time: new Date(deadline).toISOString(), seller_id: 'secret', highest_bidder_id: 'secret' }, query), server_time: new Date(now).toISOString() };
        };
        const get = () => cache.fetch(new Request('https://cache/public-auctions?view=featured'));
        assert.throws(() => publicRequest('https://cache/public-auctions?view=featured&id=secret'));
        assert.deepEqual(originRequest({ view: 'featured' }), { rpc: 'read_featured_giveaway', args: {} });
        const responses = await Promise.all(Array.from({ length: 30 }, get));
        assert.equal(reads, 1);
        assert.doesNotMatch(JSON.stringify(await responses[0].json()), /secret/);
        now += 29000;
        await get(); assert.equal(reads, 1);
        now += 1001;
        deadline = now + 1500;
        await get(); assert.equal(reads, 2);
        now += 1501;
        deadline = now + 100000;
        await get(); assert.equal(reads, 3);
        cache.readOrigin = async () => { reads++; throw new Error('unavailable'); };
        now += 31000;
        assert.equal((await get()).status, 503);
        assert.equal((await get()).status, 503);
        assert.equal(reads, 4);
    } finally { Date.now = realNow; }
});

test('recurring detail reads use narrow context, preserve static data and refresh transitions authoritatively', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        const calls = [];
        let ended = false, blocked = false;
        const client = {
            auth: { getSession: async () => ({ data: { session: null } }) },
            rpc: async name => {
                calls.push(name);
                const row = name === 'read_auction_page'
                    ? { id, status: ended ? 'completed' : 'active', auction_kind: 'sell', item: 'Static item', giveaway_title: 'Title' }
                    : { id, _detail_full_required: ended, viewer_is_highest_bidder: true };
                return { data: { privacy_version: 1, rows: blocked ? [] : [row], bids: [{ id: 'bid' }], total: 1, server_time: new Date(now).toISOString() } };
            },
        };
        const reader = createPublicAuctionReader(client, { enabled: true, fetch: async () => Response.json({
            privacy_version: 1, shared_cache_version: 1, rows: [{ id, status: ended ? 'completed' : 'active', current_bid: 100 }],
            server_time: new Date(now).toISOString(), public_snapshot: { captured_at: new Date(now).toISOString() },
        }) });
        const request = { view: 'detail', id };
        await reader.load(request);
        now += 6000;
        const result = await reader.load(request);
        assert.equal(result.rows[0].item, 'Static item');
        assert.equal(result.rows[0].current_bid, 100);
        assert.equal(result.rows[0].viewer_is_highest_bidder, true);
        assert.deepEqual(calls, ['read_auction_page', 'read_auction_detail_context']);
        now += 6000; ended = true;
        await reader.load(request);
        assert.deepEqual(calls.slice(-2), ['read_auction_detail_context', 'read_auction_page']);
        now += 6000; blocked = true;
        assert.deepEqual((await reader.load(request)).rows, [], 'private denial cannot resurrect cached public details');
        assert.equal(await reader.accepts({ ...request, fresh: true }), false);
    } finally { Date.now = realNow; }
});

 test('giveaway condition is public static cache information', () => {
    const data = publicProjection({ privacy_version: 1, rows: [{ id, status: 'completed', giveaway_title: 'Fixture',
        giveaway_win_condition: 'split', seller_id: 'private' }], bids: [], total: 1, server_time: new Date().toISOString() }, { view: 'detail-static' });
    assert.equal(data.rows[0].giveaway_win_condition, 'split');
    assert.equal(data.rows[0].giveaway_title, 'Fixture');
    assert.equal(data.rows[0].seller_id, undefined);
});
