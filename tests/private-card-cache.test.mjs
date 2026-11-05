import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateCardCache } from '../src/lib/privateCardCache.js';
const row = id => ({ id, status:'active' });
const response = ids => ({ privacy_version:1, rows:ids.map(id => ({ id,status:'active',seller_username:'private' })),server_time:new Date().toISOString() });
test('overlapping pages reuse individual private cards, batch misses and refresh transitions',async()=>{
 const calls=[];const cache=createPrivateCardCache(async ids=>{calls.push(ids);return response(ids);});
 await cache.load('one',[row('a'),row('b')]);await cache.load('one',[row('b'),row('c')]);
 assert.deepEqual(calls,[['a','b'],['c']]);
 await cache.load('two',[row('b')]);assert.deepEqual(calls.at(-1),['b']);
 cache.clear();await cache.load('two',[row('b')]);assert.equal(calls.length,4);
});
test('overlapping in-flight card reads coalesce and authorization changes discard old data',async()=>{
 let resolve,calls=0;const cache=createPrivateCardCache(ids=>{calls++;return new Promise(done=>{resolve=()=>done(response(ids));});});
 const first=cache.load('one',[row('a')]);const second=cache.load('one',[row('a')]);await Promise.resolve();
 assert.equal(calls,1);cache.clear();resolve();await assert.rejects(first,/authorization changed/);await assert.rejects(second,/authorization changed/);
});
test('permission failures invalidate all cards; response IDs cannot inject another auction',async()=>{
 let denied=false;const cache=createPrivateCardCache(async ids=>{if(denied)throw Object.assign(new Error('denied'),{code:'42501'});return response(ids);});
 await cache.load('one',[row('a')]);denied=true;await assert.rejects(cache.load('one',[row('b')]),/denied/);
 await assert.rejects(cache.load('one',[row('a')]),/denied/);
 const injected=createPrivateCardCache(async()=>response(['private-other']));await assert.rejects(injected.load('one',[row('a')]),/Invalid/);
});
test('state transitions and reservation expiry cannot reuse cached actions',async()=>{
 let now=0,calls=0,state='active';const cache=createPrivateCardCache(async ids=>{calls++;return {...response(ids),rows:ids.map(id=>({id,status:state,my_reservation:{expires_at:new Date(1000).toISOString()}}))};},{now:()=>now});
 await cache.load('one',[row('a')]);now=1001;await cache.load('one',[row('a')]);assert.equal(calls,2);
 state='completed';await cache.load('one',[{id:'a',status:'completed'}]);assert.equal(calls,3);
});

test('the public reader reuses overlapping private cards without overriding newer shared prices',async()=>{
 const { createPublicAuctionReader }=await import('../src/lib/publicAuctionReader.js');
 const calls=[];let ids=['a','b'];
 const reader=createPublicAuctionReader({auth:{getSession:async()=>({data:{session:{access_token:'one'}}})},rpc:async(name,args)=>{
  assert.equal(name,'read_auction_card_context');calls.push(args.p_ids);
  return {data:{privacy_version:1,rows:args.p_ids.map(id=>({id,status:'active',current_bid:100,seller_username:'private',viewer_is_highest_bidder:true})),server_time:new Date().toISOString()}};
 }},{enabled:true,fetch:async()=>Response.json({privacy_version:1,shared_cache_version:1,rows:ids.map(id=>({id,status:'active',current_bid:200})),bids:[],total:2,server_time:new Date().toISOString(),public_snapshot:{live_mode:true}})});
 await reader.load({view:'browse'});ids=['b','c'];const data=await reader.load({view:'browse'});
 assert.deepEqual(calls,[['a','b'],['c']]);assert.ok(data.rows.every(row=>row.current_bid===200&&row.viewer_is_highest_bidder===null));
});
