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
    assert.equal(auctionRefreshDelay(auctionReadRequest('/')),30000);
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
