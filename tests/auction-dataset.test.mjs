import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuctionService } from '../src/lib/auctions.js';
import { auctionPriceBounds } from '../src/lib/auctionPriceRange.js';
import { browseAuctions, highRollerAuctions } from '../src/lib/auctionBrowsing.js';

const row = i => ({id:`id-${i}`,seller_id:i%2?'viewer':'other',seller_username:'Authorized seller',
    item:`Item ${i}`,quantity:1,min_bid_meat:100,current_bid:i+100,price_per_item:100,
    created_at:'2026-10-20T12:00:00Z',end_time:'2027-01-01T12:00:00Z',status:'active',
    market_value_meat:i===40?'210000000':'500',bid_count:i});
const pageData=(rows,total=rows.length)=>({privacy_version:1,rows,bids:[],total});

test('cached counts and price bounds exclude closed unfunded escrow drafts', async () => {
    const rows = [
        { ...row(0), status:'cancelled', escrow_mode:true, item_escrowed_at:null, current_bid:0, bid_count:0, market_value_meat:'9000000000' },
        { ...row(1), status:'cancelled', escrow_mode:true, item_escrowed_at:'2026-10-27T12:00:00Z', current_bid:0, bid_count:0 },
        { ...row(2), status:'pending_escrow', escrow_mode:true, item_escrowed_at:null, current_bid:0, bid_count:0 },
    ];
    let calls = 0;
    const service = createAuctionService({ async rpc() { calls++; return { data:pageData(rows) }; } });
    const data = await service.loadDataset();
    assert.deepEqual(data.auctions.map(auction => auction.id), ['id-1','id-2']);
    assert.equal(data.total, 2);
    assert.equal(data.priceBounds.max, 500);
    assert.equal(calls, 1);
});

test('fetches the full authorized dataset sequentially with server market values, without filtered or financial RPCs',async()=>{
    const rows=Array.from({length:51},(_,i)=>row(i)),calls=[];let running=0,max=0;
    const service=createAuctionService({async rpc(name,args){
        assert.equal(name,'read_auction_page');calls.push(args);max=Math.max(max,++running);
        await Promise.resolve();running--;
        return {data:pageData(rows.slice((args.p_page-1)*24,args.p_page*24),rows.length)};
    }});
    const data=await service.loadDataset();assert.equal(data.auctions.length,51);assert.equal(max,1);
    assert.deepEqual(calls.map(x=>x.p_page),[1,2,3]);
    for(const args of calls)assert.deepEqual({...args,p_page:1},{p_view:'browse',p_id:null,p_search:'',p_status:'all',p_sort:'newest',p_page:1,p_trade:'all',p_kind:'all'});
    assert.equal(data.priceBounds.max,210000000);
    assert.equal(highRollerAuctions(data.auctions,new Date('2026-10-26')).length,1);
    // All controls, counts and pagination operate on the already fetched array.
    for(const sort of ['ending','newest','price-desc','bids-desc','activity']) {
        const matches=browseAuctions(data.auctions,{sort,status:'all',search:'item'});
        assert.equal(matches.length,51);assert.equal(matches.slice(24,48).length,24);
    }
    assert.equal(calls.length,3);
});

test('a later failed or unverified page rejects the entire refresh instead of publishing partial data',async()=>{
    for(const second of [{error:{code:'57014',message:'timeout'}},{data:{privacy_version:0,rows:[],bids:[],total:25}}]) {
        const service=createAuctionService({async rpc(name,args){return args.p_page===1?{data:pageData(Array.from({length:24},(_,i)=>row(i)),25)}:second;}});
        await assert.rejects(service.loadDataset());
    }
});

test('a shifting page retries once and persistent inconsistency never becomes a truncated success',async()=>{
    let calls=0;
    const service=createAuctionService({async rpc(name,args){calls++;return {data:args.p_page===1?pageData(Array.from({length:24},(_,i)=>row(i)),25):pageData([row(0)],25)};}});
    await assert.rejects(service.loadDataset(),/changed while refreshing/);assert.equal(calls,4);
});

test('empty results are a verified success; malformed totals and oversized datasets fail clearly',async()=>{
    const empty=createAuctionService({rpc:async()=>({data:pageData([])})});
    assert.deepEqual(await empty.loadDataset(),{auctions:[],total:0,priceBounds:{min:0,max:0}});
    for(const total of [6001,NaN,-1,1.5]) {
        const service=createAuctionService({rpc:async()=>({data:pageData([],total)})});
        await assert.rejects(service.loadDataset());
    }
});

test('cancellation prevents old-session pages from being returned, even when the client ignores abortSignal',async()=>{
    const controller=new AbortController();
    const service=createAuctionService({async rpc(){controller.abort();return {data:pageData([row(0)])};}});
    await assert.rejects(service.loadDataset({signal:controller.signal}),{name:'AbortError'});
});

test('bounds include both prices and market values but exclude authorized private deposit drafts',()=>{
    const auctions=[{status:'active',currentBid:7000000,marketValueMeat:210000000},
        {status:'pending_escrow',currentBid:1,marketValueMeat:900000000}];
    assert.deepEqual(auctionPriceBounds(auctions),{min:7000000,max:210000000});
    auctions[0].currentBid=400000000;
    assert.deepEqual(auctionPriceBounds(auctions),{min:210000000,max:400000000});
});
