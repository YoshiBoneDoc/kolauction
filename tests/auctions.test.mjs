import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuctionService, mapAuction } from '../src/lib/auctions.js';

const row = {
    id: 'auction-1', seller_id: 'seller-id', seller_username: 'Seller', item: 'Test item',
    quantity: '5000000000', min_bid_meat: '10000000000', duration_hours: 24,
    created_at: '2026-10-18T12:00:00Z', end_time: '2026-10-19T12:00:00Z', current_bid: '10000000000',
};

test('maps persisted records, sorts bid history, and preserves large values', () => {
    const mapped = mapAuction({ ...row, highest_bidder_username: 'First', highest_bidder_id: 'buyer-1' }, [
        { id: 'b2', auction_id: row.id, bidder_id: 'buyer-2', bidder_username: 'Second', amount: '20000000000', created_at: '2026-10-18T13:00:00Z' },
        { id: 'unrelated', auction_id: 'other-auction', amount: '1' },
        { id: 'b1', auction_id: row.id, bidder_id: 'buyer-1', bidder_username: 'First', amount: '10000000000', created_at: '2026-10-18T12:30:00Z' },
    ]);
    assert.equal(mapped.sellerId, 'seller-id');
    assert.equal(mapped.owner, 'Seller');
    assert.equal(mapped.quantity, 5_000_000_000);
    assert.equal(mapped.currentBid, 20_000_000_000);
    assert.equal(mapped.highestBidderId, 'buyer-2');
    assert.equal(mapped.highestBidder, 'Second');
    assert.deepEqual(mapped.bids.map((bid) => bid.id), ['b1', 'b2']);
    assert.equal(mapped.endTime - mapped.createdAt, 24 * 60 * 60 * 1000);
});

test('short auction numbers map separately from internal UUIDs', () => {
    const auction=mapAuction({...row,auction_number:1001},[]);
    assert.equal(auction.auctionNumber,'1001');
    assert.equal(auction.id,row.id);
    assert.equal(mapAuction(row,[]).auctionNumber,null);
});

test('creation sends listing fields only; identity, time, ID, and bid state are server-owned', async () => {
    let sent;
    const service = createAuctionService({ rpc: async (name, params) => {
        assert.equal(name, 'create_auction');
        sent = params;
        return { data: 'server-id', error: null };
    } });
    assert.equal(await service.create({ item: 'Test item', quantity: 2, minBidMeat: 50, auctionTime: '24', owner: 'Spoof', endTime: 1, currentBid: 99 }), 'server-id');
    assert.deepEqual(sent, { p_item: 'Test item', p_quantity: 2, p_min_bid_meat: 50, p_duration_hours: 24, p_image: null, p_instant_purchase_price: null, p_item_id: null, p_escrow_mode: true });
});

test('database bid rejection propagates rather than changing local state', async () => {
    const service = createAuctionService({ rpc: async (name, params) => {
        assert.equal(name, 'place_bid');
        assert.deepEqual(params, { p_auction_id: row.id, p_amount: 150 });
        return { error: { code: 'P0001', message: 'This auction has ended.' } };
    } });
    await assert.rejects(service.bid(row.id, 150), /auction has ended/);
});

test('invalid bid values never reach the API', async () => {
    const service = createAuctionService(null);
    for (const amount of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(service.bid(row.id, amount), /whole Meat/);
    }
});

test('loads a filtered page without downloading all auctions or bid history', async () => {
    const requested = [];
    const service = createAuctionService({ async rpc(name, params) {
        requested.push([name, params]);
        return { error: null, data: name === 'read_auction_page' ? { privacy_version: 1, rows: [{...row,bid_count:12}], bids: [], total: 100 } : null };
    } });
    const result = await service.load({search:'hat',status:'all',sort:'price-desc',page:2});
    assert.equal(result.auctions.length, 1);
    assert.equal(result.auctions[0].bidCount, 12);
    assert.deepEqual(result.auctions[0].bids, []);
    assert.equal(result.total,100);
    assert.deepEqual(requested, [['finalize_expired_auctions', undefined], ['read_auction_page', {
        p_view:'browse',p_id:null,p_search:'hat',p_status:'all',p_sort:'price-desc',p_page:2,
    }]]);
});

test('missing migration produces setup guidance rather than an empty listing', async () => {
    const service = createAuctionService({ rpc: async (name) => ({ error: name === 'read_auction_page' ? { code: 'PGRST202' } : null }) });
    await assert.rejects(service.load(), /Apply any pending auction SQL migrations/);
});


test('loads finalize expired auctions before reading rows', async () => {
    const calls = [];
    const service = createAuctionService({
        async rpc(name) { calls.push(name); return { error: null, data: {privacy_version:1,rows:[],bids:[],total:0} }; },
    });
    await service.load();
    assert.deepEqual(calls, ['finalize_expired_auctions', 'read_auction_page']);
});

test('lifecycle actions send only the listing ID and propagate rejections', async () => {
    const calls = [];
    const service = createAuctionService({ async rpc(name, params) {
        calls.push([name, params]);
        return { error: name === 'cancel_auction' ? { message: 'An auction with bids cannot be cancelled.' } : null };
    } });
    await service.confirmTrade(row.id);
    await assert.rejects(service.cancel(row.id), /with bids cannot be cancelled/);
    assert.deepEqual(calls, [
        ['confirm_auction_trade', { p_auction_id: row.id }],
        ['cancel_auction', { p_auction_id: row.id }],
    ]);
});

test('recorded winner and final price are preserved separately from current bids', () => {
    const mapped = mapAuction({ ...row, status: 'completed', winner_id: 'winner', winner_username: 'Historic name', final_price: '12345678901', seller_confirmed_at: 'first', buyer_confirmed_at: 'second', completed_at: 'done' }, []);
    assert.equal(mapped.status, 'completed');
    assert.equal(mapped.winner, 'Historic name');
    assert.equal(mapped.finalPrice, 12_345_678_901);
    assert.equal(mapped.completedAt, 'done');
});

test('instant purchase listing terms and outcome survive database mapping', () => {
    const mapped = mapAuction({ ...row, instant_purchase_price: '20000000000', instant_purchased_at: 'accepted', status: 'awaiting_trade', winner_id: 'buyer', final_price: '20000000000' }, []);
    assert.equal(mapped.instantPurchasePrice, 20000000000);
    assert.equal(mapped.instantPurchasedAt, 'accepted');
    assert.equal(mapped.finalPrice, 20000000000);
    assert.equal(mapAuction(row, []).instantPurchasePrice, null);
});

test('creation sends optional instant purchase price and does not fall back if migration is missing', async () => {
    const calls = [];
    const service = createAuctionService({ async rpc(name, params) {
        calls.push([name, params]);
        return { error: { code: 'PGRST202' } };
    } });
    await assert.rejects(service.create({ item: 'item', quantity: 2, minBidMeat: 100, auctionTime: 24, instantPurchasePrice: 500 }), /pending auction SQL migrations/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].p_instant_purchase_price, 500);
});

test('instant purchase sends only listing ID and preserves server rejection messages', async () => {
    const calls = [];
    const service = createAuctionService({ async rpc(name, params) {
        calls.push([name, params]);
        return { error: { message: 'This auction has ended or was cancelled.' } };
    } });
    await assert.rejects(service.purchase(row.id), /has ended/);
    assert.deepEqual(calls, [['purchase_auction', { p_auction_id: row.id }]]);
});


test('website bids above the former 20-billion limit retain their exact amount', async () => {
    const calls=[];
    const service=createAuctionService({async rpc(name,params){calls.push([name,params]);return {error:null};}});
    await service.bid(row.id,50000000001);
    assert.deepEqual(calls,[['place_bid',{p_auction_id:row.id,p_amount:50000000001}]]);
});

test('homepage loads every active page beyond four and 24 cards using existing privacy-filtered reads', async () => {
    const requests = [];
    const service = createAuctionService({ async rpc(name, args) {
        requests.push([name, args]);
        if (name === 'finalize_expired_auctions') return { error: null };
        if (args.p_status === 'completed') {
            assert.equal(args.p_sort, 'completed'); assert.equal(args.p_page, 1);
            return { data: { privacy_version: 1, rows: [{ ...row, id: 'completed', status: 'completed', completed_at: '2026-10-22T12:00:00Z' }], bids: [], total: 99 }, error: null };
        }
        assert.equal(args.p_view, 'browse'); assert.equal(args.p_status, 'active');
        assert.equal(args.p_search, ''); assert.equal(args.p_sort, 'newest');
        const offset = (args.p_page - 1) * 24;
        return { data: { privacy_version: 1, rows: Array.from({ length: Math.min(24, 53-offset) }, (_, i) => ({ ...row, id: `active-${offset+i}` })), bids: [], total: 53 }, error: null };
    } });
    const data = await service.load({ view: 'home' });
    assert.equal(data.auctions.length, 54);
    assert.equal(data.total, 53);
    assert.equal(new Set(data.auctions.map(auction => auction.id)).size, 54);
    assert.deepEqual(requests.filter(([name]) => name === 'read_auction_page').map(([,args]) => args.p_page), [1,2,3,1]);
    assert.equal(requests.filter(([name]) => name === 'finalize_expired_auctions').length, 1);
});

test('home page scans deduplicate shifting rows and reject a later failed or outdated privacy response', async () => {
    for (const failure of [null, 'network', 'privacy']) {
        const service = createAuctionService({ async rpc(name, args) {
            if (name === 'finalize_expired_auctions') return { error: null };
            if (args.p_page === 2 && failure === 'network') return { error: { message: 'Could not load page two' } };
            return { error: null, data: { privacy_version: args.p_page === 2 && failure === 'privacy' ? 0 : 1,
                rows: [{ ...row, id: 'same-row' }], bids: [], total: 25 } };
        } });
        if (failure) await assert.rejects(service.load({ view: 'home' }), failure === 'network' ? /page two/ : /privacy update/);
        else assert.equal((await service.load({ view: 'home' })).auctions.length, 1);
    }
});

test('My Auctions uses server-side seller filtering before pagination and preserves returned totals', async () => {
    const requests = [];
    const service = createAuctionService({ async rpc(name, args) {
        requests.push([name,args]);
        return { error: null, data: { privacy_version: 1, rows: [{ ...row, seller_id: 'owner' }], bids: [], total: 57 } };
    } });
    const result = await service.load({ view: 'browse', sellerId: 'owner', search: 'hat', status: 'all', sort: 'price-desc', page: 3 });
    assert.deepEqual(requests[1], ['read_auction_page', { p_view: 'seller', p_id: 'owner', p_search: 'hat', p_status: 'all', p_sort: 'price-desc', p_page: 3 }]);
    assert.equal(result.total, 57);
    assert.equal(result.auctions[0].sellerId, 'owner');
});

test('hot-card eligibility comes from the global server ranking, never from the current page or bid amount', () => {
    assert.equal(mapAuction({ ...row, is_hot: true, bid_count: 40 }, []).isHot, true);
    assert.equal(mapAuction({ ...row, is_hot: false, bid_count: 400 }, []).isHot, false);
    assert.equal(mapAuction(row, []).isHot, false);
});


test('method filtering and activity sort are sent to the paginated reader, mapping latest accepted bid metadata', async () => {
    const requests = [];
    const service = createAuctionService({ async rpc(name, args) {
        requests.push([name,args]);
        return { error: null, data: name === 'read_auction_page' ? { privacy_version: 1, total: 32, rows: [{ ...row, latest_bid_at: '2026-10-22T01:00:00Z' }], bids: [] } : null };
    }});
    const result = await service.load({ trade: 'escrow', sort: 'activity', page: 2, sellerId: 'owner' });
    assert.equal(requests[1][1].p_trade, 'escrow'); assert.equal(requests[1][1].p_sort, 'activity');
    assert.equal(requests[1][1].p_page, 2); assert.equal(requests[1][1].p_id, 'owner');
    assert.equal(result.auctions[0].latestBidAt, Date.parse('2026-10-22T01:00:00Z'));
    assert.equal(mapAuction(row, []).latestBidAt, null);
});


test('bid mapping preserves server-authorized message references and defaults to none for public reads', () => {
    const bid = {id:'b',auction_id:row.id,amount:100,created_at:'2026-10-22T12:00:00Z'};
    const references = [{reference:'D-1001',label:'Accepted',state:'sent'}, {reference:'D-1002',label:'Bid refund',state:'pending'}];
    assert.deepEqual(mapAuction(row,[{...bid,admin_delivery_references:references}]).bids[0].adminDeliveryReferences,references);
    assert.deepEqual(mapAuction(row,[bid]).bids[0].adminDeliveryReferences,[]);
});
