import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketPriceService,createCompletedMarketPriceService,marketPriceDisplay} from '../src/lib/marketPrices.js';
const row=(id=1)=>({item_id:id,available:true,price_meat:1250000,observed_at:'2026-10-24T12:00:00Z',checked_at:'2026-10-24T12:00:00Z'});

test('concurrent lookups batch, deduplicate and cache prices across page mounts',async()=>{
    let reads=0,clock=1;
    const service=createMarketPriceService({async rpc(name,params){assert.equal(name,'read_market_prices');reads++;return {data:params.p_item_ids.map(row)};}},()=>clock);
    const [a,b]=await Promise.all([service.load([1,2,1]),service.load([2,3])]);
    assert.equal(reads,1);assert.equal(a.size,2);assert.equal(b.get(3).price_meat,1250000);
    await service.load([1]);assert.equal(reads,1);
    clock+=300000;await service.load([1]);assert.equal(reads,2);
});

test('batch limit stays bounded and unknown/extinct items are negatively cached',async()=>{
    const batches=[];
    const service=createMarketPriceService({async rpc(_,params){batches.push(params.p_item_ids.length);return {data:params.p_item_ids.map(id=>({item_id:id,available:false,price_meat:null,checked_at:null,observed_at:null}))};}});
    const ids=Array.from({length:501},(_,i)=>i+1);
    const result=await service.load(ids);assert.equal(result.size,501);assert.deepEqual(batches,[500,1]);
    await service.load([1]);assert.equal(batches.length,2);
    assert.equal(marketPriceDisplay(result.get(1)).text,'Market price unavailable');
});

test('invalid data and read failures do not invent prices; previous values are explicitly stale',async()=>{
    let clock=1,fail=false,reads=0;
    const service=createMarketPriceService({async rpc(){reads++;return fail ? {error:{message:'private details'}} : {data:[row()]};}},()=>clock);
    await service.load([1]);clock+=300000;fail=true;
    const failed=(await service.load([1])).get(1);
    assert.equal(failed.price_meat,1250000);assert.equal(failed.readFailed,true);
    assert.equal(marketPriceDisplay(failed,Date.parse(row().checked_at)).stale,true);
    await service.load([1]);assert.equal(reads,2);
    for(const data of [[{...row(),price_meat:0}],[{...row(),observed_at:'broken'}],[],[row(2)]]) {
        const bad=createMarketPriceService({async rpc(){return {data};}});
        assert.equal(marketPriceDisplay((await bad.load([1])).get(1)).text,'Market price unavailable');
    }
});

test('per-item display handles multiple-item listings without unsafe multiplication; age and availability differ',()=>{
    assert.equal(marketPriceDisplay(row(),Date.parse(row().checked_at)).text,'Market Value: 1,250,000 Meat per item');
    assert.equal(marketPriceDisplay(row(),Date.parse(row().checked_at)+86400000).stale,true);
    assert.equal(marketPriceDisplay({...row(),available:false}).text,'Market price unavailable');
    assert.equal(marketPriceDisplay(null).text,'Market price unavailable');
});

test('invalid item IDs and unconfigured clients never make requests',async()=>{
    const service=createMarketPriceService({rpc(){throw new Error('Should not run');}});
    for(const id of [null,undefined,0,-1,1.5,'1'])assert.equal((await service.load([id])).get(id).available,false);
    assert.equal((await createMarketPriceService(null).load([1])).get(1).available,false);
});


test('completed auction snapshots use the shared batch cache and their completion time for age', async () => {
    const id='10000000-0000-0000-0000-000000000001';
    let reads=0;
    const record={...row(),auction_id:id,has_snapshot:true,captured_at:'2026-10-24T12:01:00Z'};
    const service=createCompletedMarketPriceService({async rpc(name,params){
        reads++;assert.equal(name,'read_completed_market_prices');assert.deepEqual(params.p_auction_ids,[id]);return {data:[record]};
    }});
    const [a,b]=await Promise.all([service.load([id]),service.load([id])]);
    assert.equal(reads,1);assert.deepEqual(a.get(id),b.get(id));
    assert.equal(marketPriceDisplay(a.get(id),Date.parse('2027-01-01T00:00:00Z')).stale,false);
    const old=createCompletedMarketPriceService({async rpc(){return {data:[{auction_id:id,has_snapshot:false,available:false,checked_at:null,observed_at:null,captured_at:null}]};}});
    assert.equal((await old.load([id])).get(id).has_snapshot,false);
});
