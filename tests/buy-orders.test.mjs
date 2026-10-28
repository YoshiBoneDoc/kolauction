import test from 'node:test';
import assert from 'node:assert/strict';
import { buyFee, buyFunding, buyRefundableFeeReserve } from '../src/lib/buyOrders.js';
import { createAuctionService, mapAuction } from '../src/lib/auctions.js';
import { auctionReadRequest } from '../src/lib/auctionRefresh.js';
import { browseAuctions } from '../src/lib/auctionBrowsing.js';
import { getAuctionResult } from '../src/lib/auctionLifecycle.js';
import { canSendTradeQuery } from '../src/lib/tradeQueries.js';

test('buy fees use individual item tiers, multiply before rounding and reserve enough for every split', () => {
    for (const [price, quantity, expected] of [[200,1000,10000n],[1000000,1,50000n],[10000000,1,410000n],[100000000,1,3110000n],[1000000000,1,21110000n],[2000000000,1,31110000n],[200,5000000,50000000n]]) assert.equal(buyFee(price,quantity),expected);
    assert.equal(buyFee(1,19),0n);assert.equal(buyFee(1,20),1n);assert.equal(buyFee(1,21,true),2n);
    assert.deepEqual(buyFunding(200,100),{purchase:20000,feeReserve:1000,total:21000});
    assert.deepEqual(buyFunding(1,21),{purchase:21,feeReserve:2,total:23});
    for(const price of [1,19,1234567,1234567890]) for(const qty of [1,19,100]) {
        const reserve=buyFee(price,qty,true);
        assert.ok(reserve>=buyFee(price,Math.ceil(qty/2))+ (qty>1?buyFee(price,Math.floor(qty/2)):0n));
    }
    assert.throws(()=>buyFunding(20000000000,2),/20 billion/);
    assert.throws(()=>buyFee(1.5,2),/whole/);
});

test('refundable fee reserve excludes purchase principal and historical refunds',()=>{
    assert.equal(buyRefundableFeeReserve({pricePerItem:30,remainingQuantity:49987,balanceMeat:1574591}),74981n);
    assert.equal(buyRefundableFeeReserve({pricePerItem:1,remainingQuantity:1,balanceMeat:2}),1n);
    assert.equal(buyRefundableFeeReserve({pricePerItem:1,remainingQuantity:0,balanceMeat:1}),1n);
    assert.equal(buyRefundableFeeReserve({pricePerItem:30,remainingQuantity:49987,balanceMeat:0,refundedMeat:1574591}),0n);
    assert.equal(buyRefundableFeeReserve({pricePerItem:'30',remainingQuantity:'49987',balanceMeat:'1574591'}),74981n);
    assert.equal(buyRefundableFeeReserve({pricePerItem:30,remainingQuantity:null,balanceMeat:100}),null);
});

test('buy creation uses its escrow-only RPC and ignores any sell buyout or fixed-deadline terms',async()=>{
    const calls=[];const service=createAuctionService({async rpc(name,args){calls.push([name,args]);return {data:'created-buy-order'};}});
    assert.equal(await service.create({auctionKind:'buy',itemId:364,quantity:100,minBidMeat:2000000,auctionTime:'72',deliveryMode:'finished',escrowMode:false,instantPurchasePrice:1,customEndAt:'2026-10-30'}),'created-buy-order');
    assert.deepEqual(calls,[['create_buy_auction',{p_item_id:364,p_quantity:100,p_price_per_item:2000000,p_duration_hours:72,p_delivery_mode:'finished'}]]);
});

test('buy kind filters reach the paginated database read with existing ownership and trade filters',async()=>{
    assert.equal(auctionReadRequest('/auctions','?kind=buy&mine=others','viewer').kind,'buy');
    const calls=[];const service=createAuctionService({async rpc(name,args){calls.push([name,args]);return {data:{privacy_version:1,rows:[],bids:[],total:0}};}});
    await service.load({kind:'buy',excludeOwn:true,page:2,trade:'escrow'});
    assert.deepEqual(calls[0],['read_filtered_auction_page',{p_view:'others',p_id:null,p_search:'',p_status:'active',p_trade:'escrow',p_kind:'buy',p_min_price:null,p_max_price:null,p_sort:'ending',p_page:2}]);
});

test('buy projections distinguish per-item prices, partial fills, no single winning bidder and participant support',()=>{
    const a=mapAuction({id:'buy',auction_kind:'buy',item:'Item',quantity:100,min_bid_meat:200,purchased_quantity:20,remaining_quantity:80,escrow_mode:true,status:'completed',end_time:'2026-10-22T12:00:00Z',created_at:'2026-10-21T12:00:00Z',fulfilled_by_me:true,my_sale_meat:4000,my_sale_quantity:20,viewer_is_highest_bidder:true},[]);
    assert.equal(a.pricePerItem,200);assert.equal(a.remainingQuantity,80);assert.equal(a.mySaleMeat,4000);
    assert.equal(a.mySaleQuantity,20);
    assert.equal(a.viewerIsHighestBidder,true);
    assert.equal(getAuctionResult(a).hasWinner,false);assert.equal(canSendTradeQuery(a,{id:'seller'}),true);
    assert.equal(canSendTradeQuery({...a,fulfilledByMe:false},{id:'outsider'}),false);
    assert.deepEqual(browseAuctions([a,{...a,id:'sell',auctionKind:'sell'}],{status:'all',kind:'buy'}).map(a=>a.id),['buy']);
});
