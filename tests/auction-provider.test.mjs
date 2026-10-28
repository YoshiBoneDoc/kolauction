import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as React from 'react';
import * as router from 'react-router-dom';

const require=createRequire(import.meta.url);
const {outputFiles}=buildSync({stdin:{contents:`
 export {AuctionsProvider,AuctionsContext} from './src/context/AuctionsContext.jsx';
 export {UserContext} from './src/context/UserContext.jsx';`,resolveDir:process.cwd(),loader:'jsx'},
 bundle:true,write:false,platform:'node',format:'cjs',packages:'external',external:['../lib/supabase'],jsx:'automatic',define:{'import.meta.env':'{}'}});
let fixture;
const equal=(a,b)=>a?.length===b?.length&&a.every((v,i)=>Object.is(v,b[i]));
function slot(initial){const i=fixture.cursor++;if(!(i in fixture.slots))fixture.slots[i]=typeof initial==='function'?initial():initial;return [fixture.slots[i],value=>{fixture.slots[i]=typeof value==='function'?value(fixture.slots[i]):value;}];}
function memo(fn,deps){const [old,set]=slot(null);if(old&&equal(old.deps,deps))return old.value;const value=fn();set({value,deps});return value;}
const compiled={exports:{}};
const client={auth:{onAuthStateChange(fn){fixture.authListener=fn;return {data:{subscription:{unsubscribe(){}}}};}},rpc(...args){return fixture.rpc(...args);}};
new Function('require','module','exports',outputFiles[0].text)(name=>name==='react'?{
 ...React,useState:slot,useRef:initial=>slot({current:initial})[0],useMemo:memo,useCallback:(fn,deps)=>memo(()=>fn,deps),
 useContext:()=>({currentUser:fixture.user,signedInUserId:fixture.user?.id??null}),
 useSyncExternalStore:(subscribe,get)=>get(),
 useEffect:(fn,deps)=>{const [old,set]=slot(null);if(old&&equal(old.deps,deps))return;fixture.effects.push(()=>{old?.cleanup?.();set({deps,setup:fn,cleanup:fn()});});},
}:name==='react-router-dom'?{...router,useLocation:()=>fixture.location}:name==='../lib/supabase'?{supabase:client,initialAuthLink:{}}:require(name),compiled,compiled.exports);
const {AuctionsProvider}=compiled.exports;
function setup(){
 const timers=new Map();let id=0;const saved={setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,document:globalThis.document};
 globalThis.setTimeout=(fn,ms)=>{timers.set(++id,{fn,ms});return id;};globalThis.clearTimeout=id=>timers.delete(id);
 globalThis.document=new EventTarget();document.hidden=false;
 fixture={cursor:0,slots:[],effects:[],user:{id:'viewer'},location:{pathname:'/',search:''},calls:[],fail:false};
 fixture.rpc=async(name,args)=>{
  fixture.calls.push([name,args]);
  if(fixture.fail&&['read_home_auctions','read_filtered_auction_page','read_auction_page'].includes(name))return {error:{code:'57014',message:'timeout'}};
  if(name==='read_pending_trades')return {data:{privacy_version:1,rows:[],total:0}};
  if(['read_home_auctions','read_filtered_auction_page','read_auction_page'].includes(name)){
   const rows=Array.from({length:25},(_,i)=>({id:`a-${i}`,seller_id:'seller',seller_username:fixture.user?'Authorized seller':'Seller',usernames_visible:!!fixture.user,
    item:`Item ${i}`,quantity:1,min_bid_meat:100,current_bid:100,status:'active',created_at:'2026-10-20',end_time:'2027-01-01',market_value_meat:200}));
   return {data:{privacy_version:1,rows:rows.slice(((args?.p_page||1)-1)*24,(args?.p_page||1)*24),bids:[],total:25, ...(name==='read_home_auctions'?{sections:{popular:rows.slice(0,24).map(r=>r.id),new:[],ending:[],highRollers:[],recent:[]}}:{})}};
  }
  return {error:null};
 };
 const render=()=>{fixture.cursor=0;fixture.effects=[];const tree=AuctionsProvider({children:null});for(const effect of fixture.effects)effect();return tree.props.value;};
 const immediate=async()=>{for(let n=0;n<20;n++){const job=[...timers].find(([,j])=>j.ms<=250);if(!job)break;timers.delete(job[0]);await job[1].fn();}};
 return {render,immediate,restore(){for(const s of fixture.slots)s?.cleanup?.();Object.assign(globalThis,saved);}};
}

test('provider reads Home once and each selected browse page once, retaining independent pending pagination and cached navigation',async()=>{
 const f=setup();try{
  f.render();await f.immediate();let value=f.render();assert.equal(value.auctions.length,24);
  assert.deepEqual(fixture.calls.map(([n])=>n),['read_home_auctions','read_pending_trades']);
  fixture.location={pathname:'/auctions',search:'?q=item&sort=price-desc&page=2&minPrice=10'};
  value=f.render();assert.equal(value.auctions.length,0);await f.immediate();value=f.render();
  assert.equal(value.auctions.length,1);assert.equal(value.total,25);assert.equal(fixture.calls.length,3);
  assert.equal(fixture.calls.at(-1)[0],'read_filtered_auction_page');
  assert.equal(fixture.calls.at(-1)[1].p_page,2);assert.equal(fixture.calls.at(-1)[1].p_search,'item');
  value.setPendingPage(2);f.render();await f.immediate();
  assert.equal(fixture.calls.at(-1)[0],'read_pending_trades');assert.equal(fixture.calls.length,4);
  fixture.location={pathname:'/',search:''};value=f.render();await f.immediate();assert.equal(value.auctions.length,24);assert.equal(fixture.calls.length,4);
 }finally{f.restore();}
});

test('writes still call the server and force fresh selected-resource reads; failed refresh retains cards',async()=>{
 const f=setup();try{
  f.render();await f.immediate();let value=f.render();await value.placeBid('a-0',200);
  value=f.render();assert.equal(value.auctions.length,24);assert.ok(fixture.calls.some(([n,a])=>n==='place_bid'&&a.p_amount===200));
  assert.equal(fixture.calls.filter(([n])=>n==='read_home_auctions').length,2);
  fixture.fail=true;await value.refreshAuctions();value=f.render();
  assert.equal(value.auctions.length,24);assert.equal(value.hasLoaded,true);assert.equal(value.isLoading,false);assert.equal(value.error,'timeout');
 }finally{f.restore();}
});

test('sign-out immediately hides the authenticated snapshot and reloads only anonymous projections',async()=>{
 const f=setup();try{
  f.render();await f.immediate();assert.equal(f.render().auctions[0].owner,'Authorized seller');
  fixture.authListener('SIGNED_OUT');fixture.user=null;
  let value=f.render();assert.equal(value.auctions.length,0);assert.equal(value.hasLoaded,false);
  await f.immediate();value=f.render();assert.equal(value.auctions[0].owner,'Seller');assert.equal(value.pendingTrades.length,0);
 }finally{f.restore();}
});


test('development StrictMode effect cleanup/setup can restart the cache and polling safely',async()=>{
 const f=setup();try{
  f.render();
  const effects=fixture.slots.filter(s=>s?.setup);
  for(const effect of effects)effect.cleanup?.();
  for(const effect of effects)effect.cleanup=effect.setup();
  await f.immediate();
  const value=f.render();assert.equal(value.auctions.length,24);assert.equal(value.hasLoaded,true);
  assert.equal(fixture.calls.filter(([name])=>name==='read_home_auctions').length,1);
 }finally{f.restore();}
});

test('duplicate signed-in announcements reuse data; a new authorization token clears it',async()=>{
 const f=setup();try{
  f.render();fixture.authListener('INITIAL_SESSION',{access_token:'test-one'});
  await f.immediate();assert.equal(f.render().auctions.length,24);
  fixture.authListener('SIGNED_IN',{access_token:'test-one'});
  assert.equal(f.render().auctions.length,24);await f.immediate();assert.equal(fixture.calls.length,2);
  fixture.authListener('TOKEN_REFRESHED',{access_token:'test-two'});
  assert.equal(f.render().auctions.length,0);await f.immediate();assert.equal(f.render().auctions.length,24);
 }finally{f.restore();}
});

test('rapid price changes wait for the final selection and retain stable global slider bounds',async()=>{
 const f=setup();try{
  const original=fixture.rpc;
  fixture.rpc=async(...args)=>{
   const result=await original(...args);
   if(result.data)result.data.price_bounds={min:'1',max:'100000'};
   return result;
  };
  fixture.location={pathname:'/auctions',search:''};f.render();await f.immediate();
  assert.deepEqual(f.render().priceBounds,{min:1,max:100000});
  const count=fixture.calls.length;
  for(let i=1;i<=10;i++){
   fixture.location.search=`?minPrice=${i}`;
   const value=f.render();assert.deepEqual(value.priceBounds,{min:1,max:100000});
  }
  assert.equal(fixture.calls.length,count);
  await f.immediate();f.render();
  assert.equal(fixture.calls.length,count+1);
  assert.equal(fixture.calls.at(-1)[1].p_min_price,10);
 }finally{f.restore();}
});

test('a bid completing after navigation refreshes the selected page rather than reloading Home',async()=>{
 const f=setup();try{
  f.render();await f.immediate();const home=f.render();
  let finish;
  const original=fixture.rpc;
  fixture.rpc=(name,...args)=>name==='place_bid'?new Promise(resolve=>{finish=()=>resolve({error:null});}):original(name,...args);
  const write=home.placeBid('a-0',200);
  fixture.location={pathname:'/auctions',search:'?page=2'};f.render();await f.immediate();f.render();
  const before=fixture.calls.filter(([n])=>n==='read_home_auctions').length;
  finish();await write;const value=f.render();
  assert.equal(value.auctions.length,1);
  assert.equal(fixture.calls.filter(([n])=>n==='read_home_auctions').length,before);
  assert.equal(fixture.calls.filter(([n])=>n==='read_filtered_auction_page').length,2);
 }finally{f.restore();}
});
