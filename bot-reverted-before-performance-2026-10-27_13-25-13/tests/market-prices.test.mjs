import test from 'node:test';
import assert from 'node:assert/strict';
import { processMallPrices, fetchMallPrices, createMarketPriceRefresher, MARKET_DAY } from '../src/market-prices.mjs';
import { runWorker } from '../src/runtime.mjs';
import { EscrowWorker } from '../src/worker.mjs';
const listing = (price, limit = 0, quantity = 1) => ({ price, limit, quantity });
const snapshot = items => ({ category: 'allitems', count: 20, items });

test('select lowest unrestricted positive-stock listing; missing/extinct/limited-only are normal', () => {
    assert.deepEqual(processMallPrices(snapshot([
        {id: 1, stores: [listing(1,1),listing(100),listing(90),listing(2,0,0)]},
        {id: 2, stores: []}, {id: 3, stores: [listing(3,5)]},
    ])), [{item_id:1,price_meat:90},{item_id:2,price_meat:null},{item_id:3,price_meat:null}]);
    assert.deepEqual(processMallPrices(snapshot([])), []);
});

test('malformed and duplicate data rejects the entire snapshot rather than marking items unavailable', () => {
    for (const raw of [null, {}, {category:'food',count:20,items:[]}, {category:'allitems',count:5,items:[]},
        snapshot([{id:1,stores:[]},{id:1,stores:[]}]), snapshot([{id:1,stores:[listing(-1)]}]),
        snapshot([{id:1,stores:[listing(1,undefined,-1)]}]), snapshot([{id:1,stores:[listing(Number.MAX_SAFE_INTEGER+1)]}]),
        snapshot([{id:1,stores:[{price:1,quantity:1}]}])]) assert.throws(() => processMallPrices(raw));
});

test('bulk fetch uses one bounded authenticated raw read, no login, retries, redirects or per-item lookups', async () => {
    const calls = [];
    const transport = {transfersAllowed:()=>true,client:{session:{async raw(path,options) {
        calls.push({path,options}); return {status:200,_data:JSON.stringify(snapshot([{id:1,stores:[listing(100)]}]))};
    }}}};
    assert.deepEqual(await fetchMallPrices(transport),[{item_id:1,price_meat:100}]);
    assert.equal(calls.length,1); const {path,options}=calls[0];
    assert.equal(path,'api.php');assert.equal(options.body.get('count'),'20');assert.equal(options.body.get('what'),'mallprices');
    assert.equal(options.retry,0);assert.equal(options.redirect,'manual');assert.equal(options.timeout,20000);assert.ok(options.signal instanceof AbortSignal);
    transport.transfersAllowed=()=>false;
    await assert.rejects(fetchMallPrices(transport));assert.equal(calls.length,1);
    transport.transfersAllowed=()=>true;transport.client.session.raw=async()=>({status:302,_data:''});
    await assert.rejects(fetchMallPrices(transport));
});

function fixture({state={}, fetchPrices}={}) {
    let clock = Date.parse('2026-10-24T12:00:00Z'), downloads=0;
    const calls=[],logs=[];
    const store={async rpc(name,params,options){
        calls.push({name,params});assert.ok(options.signal);
        if(name==='bot_market_price_state')return state;
        if(name==='bot_import_market_prices')state={last_success_at:params.p_observed_at};
        if(name==='bot_market_price_failure')state={...state,next_attempt_at:new Date(clock+3600000).toISOString()};
    }};
    const make=()=>createMarketPriceRefresher({store,transport:{},now:()=>clock,log:line=>logs.push(line),
        fetchPrices:async(...args)=>{downloads++;return fetchPrices ? fetchPrices(...args) : [{item_id:1,price_meat:null}];}});
    return {make,calls,logs,advance:ms=>{clock+=ms;},get downloads(){return downloads;}};
}

test('daily schedule survives restart, shares pending work and never reads the database each cycle', async () => {
    const f=fixture();let refresher=f.make();
    await Promise.all([refresher.refresh(),refresher.refresh()]);assert.equal(f.downloads,1);
    await refresher.refresh();assert.equal(f.calls.length,2);
    refresher.stop();refresher=f.make();await refresher.refresh();assert.equal(f.downloads,1);
    f.advance(MARKET_DAY);await refresher.refresh();assert.equal(f.downloads,2);
    assert.ok(f.calls.every(call=>call.name.startsWith('bot_market')||call.name==='bot_import_market_prices'));
    refresher.stop();
});

test('failure preserves prices, persists hourly backoff and sanitizes logs', async () => {
    const f=fixture({fetchPrices:async()=>{throw new Error('pwd=private-cookie');}});let refresher=f.make();
    assert.equal(await refresher.refresh(),false);
    assert.ok(!f.calls.some(c=>c.name==='bot_import_market_prices'));
    assert.ok(!f.logs.join('').includes('private-cookie'));
    refresher.stop();refresher=f.make();await refresher.refresh();assert.equal(f.downloads,1);
    f.advance(3600000);await refresher.refresh();assert.equal(f.downloads,2);refresher.stop();
});

test('shutdown aborts the raw read and cannot publish a late snapshot', async () => {
    let release, requestSignal;
    const f=fixture({fetchPrices:async(_,options)=>{requestSignal=options.signal;return new Promise(done=>{release=done;});}});
    const refresher=f.make(), promise=refresher.refresh();await Promise.resolve();await Promise.resolve();
    refresher.stop();assert.ok(requestSignal.aborted);release([]);await promise;
    assert.ok(!f.calls.some(c=>c.name==='bot_import_market_prices'));
});

test('a slow background price refresh never delays worker cycles; read-only mode does not refresh', async t => {
    t.mock.method(EscrowWorker.prototype,'cycle',async()=>({state:'healthy'}));
    for(const live of [true,false]) {
        const controller=new AbortController();let cycles=0,refreshes=0,stopped=false;
        await runWorker({live,poll:0,reserve:0,signal:controller.signal,transport:{async connect(){}},
            store:{async rpc(){return {fetched_at:'2099-01-01T00:00:00Z'};}},log:()=>{},
            report(message){if(message.type==='cycle'&&++cycles===2)controller.abort();},
            createMarketRefresher:()=>({refresh(){refreshes++;return new Promise(()=>{});},stop(){stopped=true;}})});
        assert.equal(cycles,2);assert.equal(refreshes,live?2:0);assert.equal(stopped,live);
    }
});


test('caller shutdown also aborts the bounded bulk request signal', async () => {
    const controller = new AbortController();
    let requestSignal;
    const transport = {transfersAllowed:()=>true,client:{session:{async raw(_,options){requestSignal=options.signal;return {status:200,_data:JSON.stringify(snapshot([]))};}}}};
    await fetchMallPrices(transport,{signal:controller.signal});
    assert.equal(requestSignal.aborted,false);controller.abort();assert.equal(requestSignal.aborted,true);
});
