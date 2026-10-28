import test from 'node:test';
import assert from 'node:assert/strict';
import { auctionReadRequest, auctionRefreshDelay, startAuctionRefresh } from '../src/lib/auctionRefresh.js';

test('routes scope auction reads and preserve browsing filters/page', () => {
    assert.equal(auctionReadRequest('/info'),null);
    assert.equal(auctionReadRequest('/auction-item'),null);
    assert.deepEqual(auctionReadRequest('/auction/abc'),{view:'detail',id:'abc'});
    assert.deepEqual(auctionReadRequest('/profile'),{view:'profile'});
    assert.deepEqual(auctionReadRequest('/profile/'),{view:'profile'});
    assert.deepEqual(auctionReadRequest('/auctions/', '?q=hat&page=2'),auctionReadRequest('/auctions', '?q=hat&page=2'));
    assert.equal(auctionReadRequest('/does-not-exist'),null);
    assert.deepEqual(auctionReadRequest('/auctions','?q=hat&status=completed&sort=price-desc&page=3'),{
        view:'browse',search:'hat',status:'completed',sort:'price-desc',page:3,
    });
    assert.equal(auctionReadRequest('/auctions','?page=-2').page,1);
    assert.equal(auctionRefreshDelay(auctionReadRequest('/')),60000);
    assert.equal(auctionRefreshDelay(auctionReadRequest('/auction/abc')),10000);
});

function fixture(hidden=false) {
    const document=new EventTarget();document.hidden=hidden;
    const window=new EventTarget();
    const queue=new Map();let id=0;
    const timers={setTimeout(fn,ms){queue.set(++id,{fn,ms});return id;},clearTimeout(id){queue.delete(id);}};
    async function tick() {
        const [id,job]=queue.entries().next().value;
        queue.delete(id);await job.fn();
    }
    return {document,window,timers,queue,tick};
}

test('public dataset polling stays at one minute even with imminent deadlines; auction details remain fast',()=>{
    const now=1000000;
    for(const remaining of [500,30000,60000,120000,-1000]) {
        const auctions=[{status:'active',auctionKind:'sell',endTime:now+remaining}];
        for(const view of ['home','browse']) assert.equal(auctionRefreshDelay({view},auctions,now),60000);
    }
    assert.equal(auctionRefreshDelay({view:'detail'},[{status:'active',endTime:now+30000}],now),5000);
});

test('final-minute Sell auctions poll every five seconds and revert after an extension or settlement', () => {
    const request = {view: 'seller'};
    const now = 1000000;
    const auction = {status: 'active', auctionKind: 'sell', endTime: now + 60000};
    assert.equal(auctionRefreshDelay(request, [auction], now), 5000);
    assert.equal(auctionRefreshDelay({view: 'detail'}, [auction], now), 5000);
    assert.equal(auctionRefreshDelay(request, [{...auction, endTime: now + 75000}], now), 15000);
    assert.equal(auctionRefreshDelay(request, [{...auction, endTime: now + 120000}], now), 30000);
    assert.equal(auctionRefreshDelay(request, [{...auction, endTime: now - 1000}], now), 30000);
    assert.equal(auctionRefreshDelay(request, [{...auction, endTime: now + 1200}], now), 1200);
    for (const status of ['completed', 'cancelled', 'settling', 'pending_escrow']) {
        assert.equal(auctionRefreshDelay(request, [{...auction, status}], now), 30000);
    }
    assert.equal(auctionRefreshDelay(request, [{...auction, auctionKind: 'buy'}], now), 30000);
    assert.equal(auctionRefreshDelay(request, [{...auction, biddingRestricted: true}], now), 30000);
});

test('simultaneous deadlines trigger one shared refresh and an extension restores normal timing', async () => {
    const f = fixture();
    let now = 100000;
    let auctions = ['a', 'b', 'c'].map(id => ({id, status: 'active', endTime: now + 1200}));
    let calls = 0;
    const stop = startAuctionRefresh({...f,
        delay: () => auctionRefreshDelay({view: 'seller'}, auctions, now),
        refresh: async () => {
            calls++;
            if (calls === 2) auctions = auctions.map(a => ({...a, endTime: now + 120000}));
        },
    });
    await f.tick();
    assert.equal([...f.queue.values()][0].ms, 1200);
    now += 1200;
    await f.tick();
    assert.equal(calls, 2);
    assert.equal(f.queue.size, 1);
    assert.equal([...f.queue.values()][0].ms, 30000);
    stop();
});

test('focus does not duplicate visibility refreshes and leaving during a read cannot restart polling', async () => {
    const f = fixture(true);
    let calls = 0;
    let finish;
    const stop = startAuctionRefresh({...f, delay: 5000,
        refresh: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    });
    f.document.hidden = false;
    f.document.dispatchEvent(new Event('visibilitychange'));
    f.window.dispatchEvent(new Event('focus'));
    assert.equal(calls, 1);
    stop();
    finish();
    await Promise.resolve();
    assert.equal(f.queue.size, 0);
    f.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(calls, 1);
});

test('polling recalculates its delay after each response without starting overlapping loops', async () => {
    const f = fixture();
    let nextDelay = 30000;
    const stop = startAuctionRefresh({...f, delay: () => nextDelay, refresh: async () => {}});
    await f.tick();
    assert.equal([...f.queue.values()][0].ms, 30000);
    nextDelay = 5000;
    await f.tick();
    assert.equal(f.queue.size, 1);
    assert.equal([...f.queue.values()][0].ms, 5000);
    nextDelay = 30000;
    await f.tick();
    assert.equal([...f.queue.values()][0].ms, 30000);
    stop();
});

test('polling pauses while hidden, refreshes on return, and cleans up timers/listeners',async()=>{
    const f=fixture();let calls=0;
    const stop=startAuctionRefresh({...f,delay:30000,refresh:async()=>{calls++;}});
    await f.tick();assert.equal(calls,1);
    assert.equal([...f.queue.values()][0].ms,30000);
    f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(f.queue.size,0);
    f.window.dispatchEvent(new Event('focus'));assert.equal(calls,1);
    f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();assert.equal(calls,2);
    stop();assert.equal(f.queue.size,0);
    f.window.dispatchEvent(new Event('focus'));assert.equal(calls,2);
});

test('slow requests cannot overlap and an initially hidden page waits until visible',async()=>{
    const f=fixture(true);let calls=0;let finish;
    const stop=startAuctionRefresh({...f,delay:10000,refresh:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
    assert.equal(f.queue.size,0);
    f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));
    f.window.dispatchEvent(new Event('focus'));assert.equal(calls,1);assert.equal(f.queue.size,0);
    finish();await Promise.resolve();
    assert.equal([...f.queue.values()][0].ms,10000);
    stop();
});

test('My Auctions binds the listing filter to the signed-in viewer while retaining search, status, sort and page', () => {
    const query = '?mine=1&q=hat&status=all&sort=price-desc&page=3';
    assert.deepEqual(auctionReadRequest('/auctions', query, 'signed-in-owner'), {
        view: 'browse', sellerId: 'signed-in-owner', search: 'hat', status: 'all', sort: 'price-desc', page: 3,
    });
    assert.equal(auctionReadRequest('/auctions', query, 'another-owner').sellerId, 'another-owner');
    assert.equal(auctionReadRequest('/auctions', query).sellerId, undefined);
    assert.equal(auctionReadRequest('/auctions', '?mine=0', 'signed-in-owner').sellerId, undefined);
    assert.equal(auctionReadRequest('/seller/public-player', query, 'signed-in-owner').id, 'public-player');
});


test('new browse controls survive URL routing with pagination and My Auctions', () => {
    assert.deepEqual(auctionReadRequest('/auctions', '?sort=activity&trade=escrow&q=hat&mine=1&page=2', 'owner'), {
        view: 'browse', sellerId: 'owner', search: 'hat', status: 'active', sort: 'activity', trade: 'escrow', page: 2,
    });
    for (const sort of ['bids-desc', 'bids-asc', 'price-desc', 'price-asc']) assert.equal(auctionReadRequest('/auctions', '?sort=' + sort).sort, sort);
});


test('Others requests exclude the authenticated viewer while preserving combined browse controls', () => {
    assert.deepEqual(auctionReadRequest('/auctions','?mine=others&q=hat&status=all&sort=price-desc&trade=direct&page=3','viewer'),{
        view:'browse',excludeOwn:true,search:'hat',status:'all',sort:'price-desc',trade:'direct',page:3,
    });
    assert.equal(auctionReadRequest('/auctions','?mine=others').excludeOwn,undefined);
    assert.equal(auctionReadRequest('/seller/someone','?mine=others','viewer').excludeOwn,undefined);
});

test('closed auction filters request newest endings before pagination on browse and seller pages', () => {
    for (const path of ['/auctions', '/seller/example']) {
        for (const status of ['ended', 'completed']) {
            assert.equal(auctionReadRequest(path, `?status=${status}`).sort, 'ended-desc');
            assert.equal(auctionReadRequest(path, `?status=${status}&sort=invalid`).sort, 'ended-desc');
            assert.equal(auctionReadRequest(path, `?status=${status}&sort=price-desc`).sort, 'price-desc');
        }
        assert.equal(auctionReadRequest(path).sort, path === '/auctions' ? 'recommended' : 'ending');
    }
});

test('public polling adds bounded positive jitter without delaying initial reads or speeding up retries',async()=>{
    const f=fixture();let random=0;
    const stop=startAuctionRefresh({...f,delay:60000,jitter:.2,random:()=>random,refresh:async()=>{}});
    assert.equal([...f.queue.values()][0].ms,0);
    await f.tick();assert.equal([...f.queue.values()][0].ms,60000);
    random=.5;await f.tick();assert.equal([...f.queue.values()][0].ms,66000);
    random=1;await f.tick();assert.equal([...f.queue.values()][0].ms,72000);
    stop();
});


test('public browse default prioritizes urgent auctions while preserving explicit sorts and profile defaults', async () => {
    const {browseAuctions} = await import('../src/lib/auctionBrowsing.js');
    const now=100000000;
    const lot=(id,hours,created) => ({id,item:'fixture',status:'active',endTime:now+hours*3600000,createdAt:created});
    const rows=[lot('older',48,1),lot('later',20,2),lot('newer',72,4),lot('soon',1,3)];
    assert.deepEqual(browseAuctions(rows,{sort:'recommended',now}).map(a=>a.id),['soon','later','newer','older']);
    assert.equal(auctionReadRequest('/auctions').sort,'recommended');
    assert.equal(auctionReadRequest('/auctions','?sort=newest').sort,'newest');
    assert.equal(auctionReadRequest('/seller/seller').sort,'ending');
});
