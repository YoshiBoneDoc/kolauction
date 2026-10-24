import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import * as router from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';

const {outputFiles}=buildSync({stdin:{contents:`
 export {default as BuyAuctionCard} from './src/components/BuyAuctionCard.jsx';
 export {default as CompactAuctionCard} from './src/components/CompactAuctionCard.jsx';
 export {UserContext} from './src/context/UserContext.jsx';
 export {AuctionsContext} from './src/context/AuctionsContext.jsx';
`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'jsx'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',define:{'import.meta.env':'{}'}});
let active;
function state(initial){const h=active,i=h.cursor++;if(!(i in h.slots))h.slots[i]=typeof initial==='function'?initial():initial;return[h.slots[i],next=>{h.slots[i]=typeof next==='function'?next(h.slots[i]):next;}];}
const compiled={exports:{}};const require=createRequire(import.meta.url);
new Function('require','module','exports',outputFiles[0].text)(name=>name==='react'?{...React,useState:state,useRef:initial=>state({current:initial})[0],useEffect(){},useId:()=> 'buy-card-test',useContext:context=>active.contexts.get(context)}:name==='react-router-dom'?{...router,useLocation:()=>({pathname:'/auctions',search:'?kind=buy'})}:require(name),compiled,compiled.exports);
const {BuyAuctionCard,CompactAuctionCard,UserContext,AuctionsContext}=compiled.exports;
function nodes(tree){return !tree||typeof tree!=='object'?[]:[tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)];}
const now=Date.parse('2026-10-23T12:00:00Z');
const auction={id:'order',auctionNumber:'1234',auctionKind:'buy',item:'chrome stick',image:'/item.gif',quantity:50000,pricePerItem:30,sellerId:'host',status:'active',escrowMode:true,purchasedQuantity:0,remainingQuantity:50000,availableQuantity:50000,reservedQuantity:0,reducedQuantity:0,endTime:now+3600000};
function harness({listing=auction,user={id:'seller'},service={},expanded=true}={}){
 const h={slots:[],cursor:0,props:{auction:listing,now,inlineReserve:true,expanded,onToggleReserve(){}},contexts:new Map([[UserContext,{currentUser:user}],[AuctionsContext,service]]),render(next=this.props){this.props=next;active=this;this.cursor=0;this.tree=BuyAuctionCard(this.props);return this;},find(predicate){const n=nodes(this.tree).find(predicate);assert.ok(n);return n;},html(){active=this;return renderToStaticMarkup(React.createElement(router.StaticRouter,{location:'/auctions'},this.tree));}};
 return h.render();
}
const byLabel=label=>n=>n.props?.['aria-label']===label;
const submit=h=>h.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});

test('Buy cards match Sell typography, stretch the main link and place distinct badges and timer',()=>{
 const h=harness({expanded:false});const html=h.html();
 assert.match(html,/text-base font-bold leading-5/);assert.match(html,/text-\[26px\] font-bold/);
 assert.match(html,/after:absolute after:inset-0/);assert.match(html,/href="\/auction\/order"/);
 assert.match(html,/border-red-200 bg-red-100/);assert.match(html,/>Buy<\/span>/);assert.match(html,/>Escrow<\/span>/);
 assert.match(html,/text-\[11px\] leading-3 tabular-nums/);assert.match(html,/Order fulfillment/);
 assert.match(html,/50,000 available/);assert.match(html,/Sell to this order/);
});

test('compact wrappers forward the existing one-open-card state to inline Buy reservations',()=>{
 const h=harness();active=h;h.cursor=0;
 const toggle=()=>{};const tree=CompactAuctionCard({auction,now,expanded:true,onToggleBid:toggle});
 assert.equal(tree.type,BuyAuctionCard);assert.equal(tree.props.inlineReserve,true);
 assert.equal(tree.props.expanded,true);assert.equal(tree.props.onToggleReserve,toggle);
});

test('opening replaces progress with price/availability and supports shorthand and bounded arrow controls',()=>{
 const h=harness();assert.doesNotMatch(h.html(),/Order fulfillment|purchased/);
 assert.match(h.html().replace(/<[^>]*>/g,''),/30 Meat \/ item · 50,000 available/);
 h.find(byLabel('Increase quantity')).props.onClick();h.render();assert.equal(h.find(byLabel('Quantity to sell')).props.value,'2');
 h.find(byLabel('Quantity to sell')).props.onChange({target:{value:'50k'}});h.render();
 assert.equal(h.find(byLabel('Increase quantity')).props.disabled,true);
 h.find(byLabel('Quantity to sell')).props.onKeyDown({key:'ArrowDown',preventDefault(){}});h.render();
 assert.equal(h.find(byLabel('Quantity to sell')).props.value,'49999');
 h.find(byLabel('Quantity to sell')).props.onBlur();h.render();assert.equal(h.find(byLabel('Quantity to sell')).props.value,'49,999');
});

test('reserving inline makes one request, shows the exact FILL command and expiry, and avoids duplicate submits',async()=>{
 const calls=[];let finish;
 const h=harness({service:{reserveBuyQuantity:(...args)=>{calls.push(args);return new Promise(resolve=>{finish=resolve;});}}});
 h.find(byLabel('Quantity to sell')).props.onChange({target:{value:'20'}});h.render();
 const pending=submit(h);await submit(h);assert.deepEqual(calls,[['order',20]]);
 h.render();assert.match(h.html(),/Reserving/);
 finish({id:'reservation-uuid',quantity:20,expires_at:new Date(now+600000).toISOString()});await pending;h.render();
 assert.match(h.html(),/20 × chrome stick/);assert.match(h.html(),/FILL 1234 reservation-uuid/);
 assert.match(h.html(),/2026-10-23T12:10:00.000Z/);assert.match(h.html(),/without Meat or other items/);
 assert.match(h.html(),/Cancel reservation/);assert.doesNotMatch(h.html(),/aria-label="Quantity to sell"/);
});

test('bad or newly unavailable quantities do not call the API; backend failures keep the editable form',async()=>{
 const calls=[];const h=harness({service:{reserveBuyQuantity:async(...args)=>{calls.push(args);throw Error('Only 10 remain.');}}});
 h.find(byLabel('Quantity to sell')).props.onChange({target:{value:'50001'}});h.render();await submit(h);h.render();
 assert.equal(calls.length,0);assert.match(h.html(),/available whole quantity/);
 h.find(byLabel('Quantity to sell')).props.onChange({target:{value:'20'}});h.render();await submit(h);h.render();
 assert.equal(calls.length,1);assert.match(h.html(),/Only 10 remain/);
 h.render({...h.props,auction:{...auction,availableQuantity:10}});await submit(h);assert.equal(calls.length,1);
});

test('ownership, bans, guests, closed orders and unavailable quantities never expose a reservation submission',()=>{
 for(const options of [{user:{id:'host'}},{user:{id:'seller',isBanned:true}},{user:null},{listing:{...auction,status:'completed'}},{listing:{...auction,buyClosingReason:'cancel'}},{listing:{...auction,availableQuantity:0}}]){
  const h=harness(options);assert.doesNotMatch(h.html(),/aria-label="Quantity to sell"/);
 }
 assert.match(harness({user:null}).html(),/Log in/);
});

test('cancellation uses the existing API, failure preserves instructions and a successful cancel releases the form',async()=>{
 const calls=[];let fail=true;
 const r={id:'cancel-me',quantity:5,expires_at:new Date(now+600000).toISOString()};
 const h=harness({listing:{...auction,myReservation:r},service:{cancelBuyReservation:async id=>{calls.push(id);if(fail)throw Error('Delivery already under review.');return {state:'cancelled'};}}});
 await h.find(n=>n.type==='button'&&n.props.children==='Cancel reservation').props.onClick();h.render();
 assert.match(h.html(),/Delivery already under review/);assert.match(h.html(),/FILL 1234 cancel-me/);
 fail=false;await h.find(n=>n.type==='button'&&n.props.children==='Cancel reservation').props.onClick();h.render();
 assert.deepEqual(calls,['cancel-me','cancel-me']);assert.doesNotMatch(h.html(),/FILL 1234 cancel-me/);assert.match(h.html(),/Reservation canceled/);
 assert.match(h.html(),/aria-label="Quantity to sell"/);
});

test('fresh server data removes completed local reservations and preserves expired reservations awaiting safe release',async()=>{
 const r={id:'saved',quantity:5,expires_at:new Date(now+600000).toISOString()};
 const h=harness({service:{reserveBuyQuantity:async()=>r}});await submit(h);h.render();assert.match(h.html(),/FILL 1234 saved/);
 h.render({...h.props,auction:{...auction,purchasedQuantity:5,myReservation:null}});assert.doesNotMatch(h.html(),/FILL 1234 saved/);
 h.render({...h.props,auction:{...auction,myReservation:{...r,expires_at:new Date(now-1000).toISOString()},buyClosingReason:'deadline'}});
 assert.match(h.html(),/checking timely incoming mail/);assert.match(h.html(),/FILL 1234 saved/);assert.doesNotMatch(h.html(),/aria-label="Quantity to sell"/);
});
