import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuctionService } from '../src/lib/auctions.js';

const row = {id:'one',seller_username:'Authorized seller',item:'Item',quantity:1,min_bid_meat:100,
    current_bid:100,created_at:'2026-10-20',end_time:'2027-01-01',status:'active'};
const sections = {popular:['one'],new:['one'],ending:['one'],highRollers:[],recent:[]};
const data = () => ({privacy_version:1,rows:[row],bids:[],total:90000,sections});

test('homepage bounds are independent of total: one read, exact sections, no historic paging',async()=>{
    let calls=0;
    const service=createAuctionService({rpc:async name=>{calls++;assert.equal(name,'read_home_auctions');return {data:data()};}});
    const result=await service.load({view:'home'});
    assert.equal(calls,1);assert.equal(result.auctions.length,1);assert.equal(result.total,90000);
    assert.equal(result.homeSections.popular[0].owner,'Authorized seller');
});

test('invalid/outdated/oversized homepage responses fail instead of publishing partial sections',async()=>{
    for(const response of [ {...data(),privacy_version:0}, {...data(),sections:null},
        {...data(),sections:{...sections,new:['missing']}}, {...data(),sections:{...sections,new:Array(25).fill('one')}},
        {...data(),rows:Array(121).fill(row)}, {...data(),total:NaN}, {...data(),total:-1}]) {
        const service=createAuctionService({rpc:async()=>({data:response})});
        await assert.rejects(service.load({view:'home'}));
    }
});

test('a server-filtered browse page preserves global totals/bounds and does not fetch other pages',async()=>{
    const calls=[];
    const service=createAuctionService({rpc:async(name,args)=>{calls.push([name,args]);return {data:{...data(),price_bounds:{min:'1',max:'90000'}}};}});
    const result=await service.load({view:'browse',page:7,search:'needle',kind:'buy',trade:'escrow',minPrice:100,maxPrice:1000});
    assert.equal(calls.length,1);assert.equal(calls[0][1].p_page,7);assert.equal(calls[0][1].p_search,'needle');
    assert.equal(result.total,90000);assert.deepEqual(result.priceBounds,{min:1,max:90000});
    assert.equal(calls[0][1].p_kind,'buy');assert.equal(calls[0][1].p_min_price,100);
});

test('a canceled read cannot return an old viewer response even if the client ignores abortSignal',async()=>{
    const controller=new AbortController();
    const service=createAuctionService({rpc:async()=>{controller.abort();return {data:data()};}});
    await assert.rejects(service.load({view:'home',signal:controller.signal}),{name:'AbortError'});
});

test('empty verified sections are successful and an initial RPC error is not an empty result',async()=>{
    const empty=createAuctionService({rpc:async()=>({data:{privacy_version:1,rows:[],bids:[],total:0,sections:{popular:[],new:[],ending:[],highRollers:[],recent:[]}}})});
    assert.equal((await empty.load({view:'home'})).auctions.length,0);
    const failed=createAuctionService({rpc:async()=>({error:{code:'57014',message:'timeout'}})});
    await assert.rejects(failed.load({view:'home'}),/timeout/);
});
