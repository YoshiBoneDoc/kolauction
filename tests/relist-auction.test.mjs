import { browseAuctions } from '../src/lib/auctionBrowsing.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canRelist, relistDraft, relistSnapshot } from '../src/lib/relistAuction.js';
import { auctionQuantityLabel, bundleCover } from '../src/lib/bundles.js';
import { auctionReadRequest } from '../src/lib/auctionRefresh.js';
import { normalizeAuctionBrowseParams } from '../src/lib/auctionBrowseSession.js';
import { publicRequest, originRequest } from '../workers/public-auction-cache/protocol.js';
import { createAuctionService } from '../src/lib/auctions.js';

const now = Date.now();
const base = { id: 'old', sellerId: 'owner', item: 'seal tooth', itemId: 2, quantity: 50, minBidMeat: 100,
    instantPurchasePrice: 500, auctionTime: 72, escrowMode: true, status: 'expired', endTime: now - 1000,
    createdAt: now - 72 * 3600000, currentBid: 300, winnerId: 'winner', balanceMeat: 5000 };
test('Relist is restricted to the owner and final outcomes; a local deadline does not prove closure', () => {
    for (const status of ['expired', 'ended_no_bids', 'cancelled', 'voided', 'completed']) {
        assert.equal(canRelist({ ...base, status }, { id: 'owner' }, now), true);
        assert.equal(canRelist({ ...base, status }, { id: 'other' }, now), false);
        assert.equal(canRelist({ ...base, status }, null, now), false);
    }
    for (const status of ['active', 'pending_escrow', 'on_hold', 'settling', 'awaiting_trade'])
        assert.equal(canRelist({ ...base, status }, { id: 'owner' }, now), false);
    assert.equal(canRelist(base, { id: 'owner', isBanned: true }, now), false);
});
test('Relist copies listing terms, not old bids, deadlines, IDs or escrow funding', () => {
    const snapshot = relistSnapshot(base);
    assert.equal(snapshot.id, 'old');
    assert.equal(Object.hasOwn(snapshot, 'balanceMeat'), false);
    assert.equal(Object.hasOwn(snapshot, 'winnerId'), false);
    const draft = relistDraft(snapshot);
    assert.deepEqual([draft.kind, draft.itemId, draft.quantity, draft.minimum, draft.buyout, draft.hours, draft.escrow], ['sell', '2', '50', '100', '500', 72, true]);
    for (const key of ['id', 'currentBid', 'winnerId', 'balanceMeat', 'customEndAt', 'endTime']) assert.equal(Object.hasOwn(draft, key), false);
    const buy = relistDraft({ ...base, auctionKind: 'buy', pricePerItem: 30, deliveryMode: 'finished' });
    assert.deepEqual([buy.kind, buy.minimum, buy.delivery], ['buy', '30', 'finished']);
    assert.equal(relistDraft({ ...base, customEndAt: new Date(base.createdAt + 12.5 * 3600000).toISOString() }).hours, 12.5);
});
test('bundle relisting preserves exact contents, custom name and cover; totals count components', () => {
    const bundleItems = [{ id: 2, name: 'seal tooth', quantity: 5000000000, image: 'tooth.gif' }, { id: 364, name: 'ore', quantity: 5, image: 'ore.gif' }];
    const source = { ...base, item: 'Bundle: Collection', quantity: 1, bundleItems, image: 'ore.gif' };
    const draft = relistDraft(source);
    assert.equal(draft.kind, 'bundle'); assert.equal(draft.title, 'Collection'); assert.equal(draft.cover, 364);
    assert.deepEqual(draft.entries, [{ id: 2, quantity: '5000000000' }, { id: 364, quantity: '5' }]);
    assert.equal(auctionQuantityLabel(source), '(5,000,000,005 items)');
    assert.equal(auctionQuantityLabel(base), '×50');
    assert.equal(relistDraft({ ...source, item: 'Bundle: seal tooth + 1 more item types' }).title, '');
});
test('cover selection uses highest available unit quote, honoring explicit cover and stable fallback', () => {
    const items = [{ id: 2, quantity: 5000 }, { id: 364, quantity: 1 }];
    const prices = new Map([[2, { available: true, price_meat: 10 }], [364, { available: true, price_meat: 500 }]]);
    assert.equal(bundleCover(items, null, prices).id, 364);
    assert.equal(bundleCover(items, 2, prices).id, 2);
    assert.equal(bundleCover([...items].reverse(), null).id, 2);
    assert.equal(bundleCover(items, 999, prices).id, 364);
});
test('buyout filter persists and reaches private RPCs and distinct shared cache keys', async () => {
    assert.equal(normalizeAuctionBrowseParams('buyout=with&sort=recommended').toString(), 'sort=recommended&buyout=with');
    assert.equal(normalizeAuctionBrowseParams('buyout=any').toString(), '');
    const request = auctionReadRequest('/auctions', '?buyout=without&mine=others', 'owner');
    assert.equal(request.buyout, 'without'); assert.equal(request.excludeOwn, true);
    assert.equal(auctionReadRequest('/seller/owner', '?buyout=with').buyout, undefined);
    let actual;
    const service = createAuctionService({ rpc(name, args) { actual = { name, args }; return Promise.resolve({ data: { privacy_version: 1, rows: [], bids: [], total: 0 } }); } });
    await service.load(request);
    assert.equal(actual.args.p_buyout, 'without'); assert.equal(actual.args.p_view, 'others');
    const withBuyout = publicRequest('https://test/api/public-auctions?buyout=with');
    const withoutBuyout = publicRequest('https://test/api/public-auctions?buyout=without');
    assert.notEqual(JSON.stringify(withBuyout), JSON.stringify(withoutBuyout));
    assert.equal(originRequest(withBuyout).args.p_buyout, 'with');
    assert.throws(() => publicRequest('https://test/api/public-auctions?buyout=invalid'));
});


test('bundle filter combines with buyout filtering and propagates to pagination and cache requests', async () => {
    const single = { ...base, status: 'active', endTime: now + 600000, createdAt: now };
    const bundle = { ...single, id: 'bundle', bundleItems: [{id: 2, quantity: 1}, {id: 364, quantity: 2}] };
    const noBuyout = { ...bundle, id: 'no-buyout', instantPurchasePrice: null };
    assert.deepEqual(browseAuctions([single, bundle, noBuyout], { bundle: 'with', buyout: 'with', now }).map(a => a.id), ['bundle']);
    assert.deepEqual(browseAuctions([single, bundle, noBuyout], { bundle: 'without', now }).map(a => a.id), ['old']);
    assert.equal(browseAuctions([single, bundle, noBuyout], { bundle: 'any', now }).length, 3);
    assert.equal(normalizeAuctionBrowseParams('bundle=with&buyout=without').toString(), 'buyout=without&bundle=with');
    assert.equal(normalizeAuctionBrowseParams('bundle=any').toString(), '');
    const request = auctionReadRequest('/auctions', '?bundle=with&buyout=without&page=2');
    assert.equal(request.bundle, 'with'); assert.equal(request.page, 2);
    assert.equal(auctionReadRequest('/seller/owner', '?bundle=with').bundle, undefined);
    let args;
    const service = createAuctionService({ rpc(_, parameters) { args = parameters; return Promise.resolve({ data: { privacy_version: 1, rows: [], bids: [], total: 0 } }); } });
    await service.load(request);
    assert.equal(args.p_bundle, 'with'); assert.equal(args.p_buyout, 'without');
    await service.load({ view: 'browse', bundle: 'with' });
    assert.equal(args.p_buyout, 'any'); assert.equal(args.p_bundle, 'with');
    const yes = publicRequest('https://test/api/public-auctions?bundle=with');
    const no = publicRequest('https://test/api/public-auctions?bundle=without');
    assert.notEqual(JSON.stringify(yes), JSON.stringify(no));
    assert.equal(originRequest(yes).args.p_bundle, 'with'); assert.equal(originRequest(yes).args.p_buyout, 'any');
    assert.throws(() => publicRequest('https://test/api/public-auctions?bundle=invalid'));
});
