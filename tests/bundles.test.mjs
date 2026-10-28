import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBundle, bundleTitle, bundleConfirmation } from '../src/lib/bundles.js';
import { createAuctionService, mapAuction } from '../src/lib/auctions.js';

const catalog = [
    {id:2,name:'seal tooth',image:'tooth.gif',tradeable:true},
    {id:364,name:'asbestos ore',image:'ore.gif',tradeable:true},
    {id:900,name:'Giftable fixture',image:'gift.gif',tradeable:false,giftable:true},
    {id:901,name:'Package fixture',image:'gift.gif',tradeable:true,is_gift_package:true},
];
test('bundle contents preserve exact quantities, enforce distinct eligible items and canonical order', () => {
    const entries=prepareBundle([{id:364,quantity:'5b'},{id:2,quantity:'3'}],catalog);
    assert.deepEqual(entries.map(({id,quantity})=>({id,quantity})),[{id:2,quantity:3},{id:364,quantity:5000000000}]);
    assert.match(bundleTitle(entries),/^Bundle: seal tooth \+ 1 more item types$/);
    for (const bad of [[],[{id:2,quantity:1}],[{id:2,quantity:1},{id:2,quantity:3}],
        [{id:2,quantity:1},{id:364,quantity:0}],[{id:2,quantity:1},{id:364,quantity:5000000001}],
        [{id:2,quantity:1},{id:901,quantity:1}]]) assert.throws(()=>prepareBundle(bad,catalog));
    assert.equal(prepareBundle([{id:2,quantity:1},{id:900,quantity:2}],catalog).length,2);
});
test('bundle RPC sends only item IDs/quantities and lot terms; server owns names, images and identities',async()=>{
    let request;
    const service=createAuctionService({async rpc(name,params){request={name,params};return {data:'bundle-id'};}});
    const bundleItems=prepareBundle([{id:2,quantity:3},{id:364,quantity:5}],catalog);
    assert.equal(await service.create({bundleItems,minBidMeat:100,auctionTime:'24',escrowMode:true,item:'Spoof',owner:'Spoof'}),'bundle-id');
    assert.equal(request.name,'create_bundle_auction');
    assert.deepEqual(request.params,{p_items:[{id:2,quantity:3},{id:364,quantity:5}],p_min_bid_meat:100,p_duration_hours:24,p_instant_purchase_price:null,p_escrow_mode:true,p_custom_end_at:null});
    const mapped=mapAuction({id:'bundle-id',quantity:1,bundle_items:bundleItems},[]);
    assert.equal(mapped.isBundle,true);assert.deepEqual(mapped.bundleItems,bundleItems);
    assert.equal(mapAuction({quantity:3},[]).isBundle,false);
});

test('bundle confirmations enumerate every item and quantity, single items stay unchanged',()=>{
    const bundleItems=prepareBundle([{id:2,quantity:3},{id:364,quantity:5}],catalog);
    const text=bundleConfirmation({isBundle:true,bundleItems});
    assert.match(text,/3 × seal tooth/);assert.match(text,/5 × asbestos ore/);
    assert.equal(bundleConfirmation({item:'seal tooth'}),'');
});
