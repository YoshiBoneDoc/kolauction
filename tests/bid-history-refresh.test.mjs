import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
const require=createRequire(import.meta.url);
// Inject the client at the module boundary; execute the actual hook, pagination
// and refresh scheduler rather than a parallel implementation of those rules.
const {outputFiles}=buildSync({stdin:{contents:"export { default } from './src/hooks/useBidHistory.js';",resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',define:{'import.meta.env':'{}'}});
let active;
const compiled={exports:{}};
const state=initial=>{const h=active,i=h.cursor++;if(!(i in h.slots))h.slots[i]=typeof initial==='function'?initial():initial;return [h.slots[i],next=>{h.slots[i]=typeof next==='function'?next(h.slots[i]):next;}];};
new Function('require','module','exports',outputFiles[0].text)(name=>name==='react'?{...React,useState:state,useRef:initial=>state({current:initial})[0],useEffect:(fn,deps)=>{const h=active,i=h.cursor++,old=h.effects.get(i);if(!old || deps.some((v,j)=>v!==old.deps[j])){old?.cleanup?.();h.effects.set(i,{deps,fn});h.pending.push(i);}}}:name==='@supabase/supabase-js'?{createClient:()=>globalThis.__historyClient}:require(name),compiled,compiled.exports);
const useHistory=compiled.exports.default;
const settle=()=>new Promise(r=>setTimeout(r,10));
const bid=(id,amount)=>({id,amount,auction_id:'auction',bidder_username:'Bidder 1',...(id==='recent'?{amount:80000000,payment_meat:2000000,payment_mr_a:1}:{}),created_at:'2026-11-01T00:00:00Z'});

test('history preserves loaded pages, refreshes on bids and clears private rows on auth changes',async()=>{
    const previous={window:globalThis.window,document:globalThis.document};
    globalThis.window=new EventTarget();globalThis.document=new EventTarget();globalThis.document.hidden=false;
    const calls=[];let callback, pending;
    globalThis.__historyClient={auth:{onAuthStateChange:fn=>{callback=fn;queueMicrotask(()=>fn('INITIAL_SESSION',{access_token:'a'}));return {data:{subscription:{unsubscribe(){}}}};}},rpc:(name,args)=>({abortSignal:async()=>{
        calls.push([name,args]);if(pending)return await pending;
        return {data:{privacy_version:1,visible:true,bids:[bid(args.p_before_id?'older':'recent',args.p_before_id?1:2)],has_more:!args.p_before_id,next_cursor:{id:'recent',amount:'2'}}};
    }})};
    const h={slots:[],effects:new Map(),auction:{id:'auction',bidCount:1,status:'active',currentBid:2},render(){active=h;h.cursor=0;h.pending=[];h.result=useHistory(h.auction,globalThis.__historyClient);for(const i of h.pending){const effect=h.effects.get(i);effect.cleanup=effect.fn();}return h.result;}};
    try {
        h.render();await settle();h.render();assert.equal(h.result.bids.length,1);
        assert.equal(h.result.bids[0].paymentMeat,2000000);
        assert.equal(h.result.bids[0].paymentMrA,1);
        assert.equal(h.result.bids[0].amount,80000000);
        assert.equal(calls.length,1,'initial effect and scheduler coalesce');
        h.result.loadOlder();await settle();h.render();assert.equal(h.result.bids.length,2);
        assert.equal(calls[1][1].p_before_id,'recent');
        const legacy=h.result.bids.find(b=>b.id==='older');
        assert.equal(legacy.paymentMeat,1);assert.equal(legacy.paymentMrA,0);
        h.auction={...h.auction,bidCount:2,currentBid:3};h.render();await settle();h.render();
        assert.equal(h.result.bids.length,2,'new bids do not discard already loaded history');
        let resolve;pending=new Promise(r=>{resolve=r;});h.result.refresh();await settle();
        callback('SIGNED_OUT',null);h.render();assert.equal(h.result.bids.length,0,'private rows clear immediately');
        resolve({data:{privacy_version:1,visible:true,bids:[bid('old-private',5)],has_more:false}});
        pending=null;await settle();h.render();assert.ok(!h.result.bids.some(b=>b.id==='old-private'));
    } finally {
        for(const effect of h.effects.values())effect.cleanup?.();
        globalThis.window=previous.window;globalThis.document=previous.document;delete globalThis.__historyClient;
    }
});
