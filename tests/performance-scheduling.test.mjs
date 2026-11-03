import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginScheduler } from '../workers/public-auction-cache/scheduler.js';
import { runMaintenance } from '../workers/site/maintenance.js';
import { itemCatalog } from '../workers/site/itemCatalog.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('single origin scheduler prioritizes live reads and bounds catalogue starvation', async()=>{
    const schedule=createOriginScheduler(), first=deferred(), order=[];
    let running=0, maximum=0;
    const job=(name,hold)=>async()=>{maximum=Math.max(maximum,++running);order.push(name);if(hold)await hold.promise;running--;};
    const jobs=[schedule(job('first',first),false),schedule(job('catalogue'),false),
        ...['a','b','c','d'].map(name=>schedule(job(name),true))];
    await settle();assert.deepEqual(order,['first']);first.resolve();await Promise.all(jobs);
    assert.deepEqual(order,['first','a','b','c','catalogue','d']);assert.equal(maximum,1);
});

test('Site cron is gated, uses separate RPC transactions and preserves scoped credentials',async()=>{
    const calls=[];
    const env={SITE_MAINTENANCE_ENABLED:'true',SUPABASE_URL:'https://db.example',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SITE_MAINTENANCE_TOKEN:'scoped'};
    const fetcher=async(url,options)=>{calls.push([url.pathname,options]);return Response.json({state:'ok'});};
    await runMaintenance({scheduledTime:0},{...env,SITE_MAINTENANCE_ENABLED:'false'},fetcher);assert.equal(calls.length,0);
    await runMaintenance({scheduledTime:4*60000},env,fetcher);
    assert.deepEqual(calls.map(c=>c[0]),['/rest/v1/rpc/site_refresh_discovery','/rest/v1/rpc/site_refresh_totals']);
    assert.ok(calls.every(([,o])=>o.headers.Authorization==='Bearer scoped' && o.redirect==='manual' && o.signal));
    calls.length=0;await runMaintenance({scheduledTime:2*60000},env,fetcher);
    assert.deepEqual(calls.map(c=>c[0]),['/rest/v1/rpc/site_refresh_discovery','/rest/v1/rpc/site_cleanup_activity']);
    calls.length=0;await runMaintenance({scheduledTime:4*60000},env,async()=>{calls.push('failure');return Response.json({}, {status:503});});
    assert.equal(calls.length,1);
    await runMaintenance({scheduledTime:4*60000},env,fetcher);assert.equal(calls.length,1,'transport failure cooldown prevents further requests');
});

test('versioned catalogue bodies reuse edge cache and support conditional requests',async()=>{
    const store=new Map(),waits=[];let calls=0;
    const cache={match:async req=>store.get(req.url)?.clone(),put:async(req,res)=>store.set(req.url,res)};
    const version='a'.repeat(64);
    const env={SUPABASE_URL:'https://db.example',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture'};
    const ctx={waitUntil:p=>waits.push(p)};
    const fetcher=async()=>{calls++;return Response.json({ready:true,items:[{id:1}]});};
    const url=`https://site.example/api/item-catalog?version=${version}`;
    const first=await itemCatalog(new Request(url),env,ctx,fetcher,cache);await Promise.all(waits);
    assert.match(first.headers.get('Cache-Control'),/immutable/);
    const second=await itemCatalog(new Request(url,{headers:{'If-None-Match':`"${version}"`}}),env,ctx,fetcher,cache);
    assert.equal(second.status,304);assert.equal(calls,1);
    assert.equal((await itemCatalog(new Request('https://site.example/api/item-catalog?version=bad'),env,ctx,fetcher,cache)).status,400);
});
