import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuctionReadCache } from '../src/lib/auctionReadCache.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const settle = async () => { for(let i=0;i<8;i++) await Promise.resolve(); };

test('Home and All Auctions reuse one complete dataset without refetching for navigation or local controls', async () => {
    let calls=0, now=100;
    const cache=createAuctionReadCache(async key => { calls++; assert.equal(key,'dataset'); return {auctions:[{id:'a'}]}; },{now:()=>now});
    await cache.load('dataset');
    const snapshot=cache.snapshot('dataset');
    for(let i=0;i<30;i++) await cache.load('dataset');
    assert.equal(calls,1);assert.equal(cache.snapshot('dataset'),snapshot);
    now+=30000;await cache.load('dataset');assert.equal(calls,2);
});

test('coalesces identical requests and serializes dataset, detail and pending reads', async () => {
    let running=0, maximum=0; const jobs=[];
    const cache=createAuctionReadCache(async key => {
        maximum=Math.max(maximum,++running);const job=deferred();jobs.push({key,...job});
        const result=await job.promise;running--;return result;
    });
    const first=cache.load('dataset');assert.equal(cache.load('dataset'),first);
    const pending=cache.load('pending:1');await settle();
    assert.deepEqual(jobs.map(x=>x.key),['dataset']);
    jobs[0].resolve({auctions:[]});await first;await settle();
    assert.deepEqual(jobs.map(x=>x.key),['dataset','pending:1']);
    jobs[1].resolve({auctions:[]});await pending;assert.equal(maximum,1);
});

test('timeout retains the previous complete data, distinguishes failed initial load, and backs off retries', async () => {
    let fail=false,calls=0,now=100;
    const data={auctions:[{id:'known'}]};
    const cache=createAuctionReadCache(async()=>{calls++;if(fail)throw new Error('timeout');return data;},{now:()=>now});
    await cache.load('dataset');fail=true;now+=30000;await cache.load('dataset');
    assert.equal(cache.snapshot('dataset').data,data);assert.equal(cache.snapshot('dataset').error,'timeout');
    assert.equal(cache.snapshot('dataset').refreshing,false);
    await cache.load('dataset');assert.equal(calls,2);
    await cache.load('new-detail');assert.equal(cache.snapshot('new-detail').data,null);
    assert.equal(cache.snapshot('new-detail').error,'timeout');
    fail=false;await cache.load('dataset',{force:true});assert.equal(cache.snapshot('dataset').error,'');
});

test('write invalidation discards a pre-write response and queues a new read',async()=>{
    const jobs=[];const cache=createAuctionReadCache(async()=>{const d=deferred();jobs.push(d);return d.promise;});
    const old=cache.load('dataset');await settle();cache.invalidate();
    const fresh=cache.load('dataset',{force:true});jobs[0].resolve({auctions:[{id:'old'}]});
    assert.equal(await old,undefined);await settle();assert.equal(cache.snapshot('dataset').data,null);
    jobs[1].resolve({auctions:[{id:'new'}]});await fresh;
    assert.equal(cache.snapshot('dataset').data.auctions[0].id,'new');
});

test('authorization changes abort, erase all snapshots and suppress late old-viewer responses',async()=>{
    const late=deferred();let signal;
    const cache=createAuctionReadCache(async(key,s)=>{if(key==='slow'){signal=s;return late.promise;}return {privateViewer:'A'};});
    await cache.load('dataset');const request=cache.load('slow');await settle();cache.pause();
    assert.equal(signal.aborted,true);assert.equal(cache.snapshot('dataset').data,null);
    late.resolve({privateViewer:'A'});assert.equal(await request,undefined);
    assert.equal(cache.snapshot('slow').data,null);
    cache.resume();await cache.load('dataset');assert.equal(cache.snapshot('dataset').data.privateViewer,'A');
});

test('authorization/privacy errors erase other formerly authorized resources too',async()=>{
    for(const code of ['42501','PGRST301','KHUB_PRIVACY']) {
        const cache=createAuctionReadCache(async key=>{if(key==='denied')throw Object.assign(new Error('denied'),{code});return {sensitive:true};});
        await cache.load('dataset');await cache.load('pending:1');await cache.load('denied');
        assert.equal(cache.snapshot('dataset').data,null);assert.equal(cache.snapshot('pending:1').data,null);
        assert.equal(cache.snapshot('denied').error,'denied');
    }
});
