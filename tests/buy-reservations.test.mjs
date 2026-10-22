import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { StaticRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAuctionService } from '../src/lib/auctions.js';

const {outputFiles}=buildSync({stdin:{contents:`export {default as BuyAuctionDetails} from './src/components/BuyAuctionDetails.jsx';export {UserContext} from './src/context/UserContext.jsx';export {AuctionsContext} from './src/context/AuctionsContext.jsx';`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'jsx'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',define:{'import.meta.env':'{}'}});
let active;
function state(initial){const h=active,i=h.cursor++;if(!(i in h.slots))h.slots[i]=initial;return [h.slots[i],next=>{h.slots[i]=typeof next==='function'?next(h.slots[i]):next;}];}
const compiled={exports:{}};const require=createRequire(import.meta.url);
new Function('require','module','exports',outputFiles[0].text)(name=>name==='react'?{...React,useState:state,useRef:initial=>state({current:initial})[0],useEffect(){},useContext:context=>active.contexts.get(context)}:require(name),compiled,compiled.exports);
const {BuyAuctionDetails,UserContext,AuctionsContext}=compiled.exports;
function nodes(tree){return !tree||typeof tree!=='object'?[]:[tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)];}
const now=Date.parse('2026-10-22T12:00:00Z');
const order={id:'order',auctionNumber:'1200',auctionKind:'buy',item:'Item',quantity:100,pricePerItem:200,sellerId:'buyer',status:'active',escrowMode:true,purchasedQuantity:20,remainingQuantity:80,availableQuantity:60,reservedQuantity:20,reducedQuantity:0,deliveryMode:'immediate',endTime:now+3600000,fulfillments:[],giftMeat:0};
function harness(auction=order,user={id:'seller'},service={}){
 const h={slots:[],cursor:0,auction,contexts:new Map([[UserContext,{currentUser:user}],[AuctionsContext,service]]),render(){active=h;h.cursor=0;h.tree=BuyAuctionDetails({auction:h.auction,now});return h;},find(predicate){return nodes(h.tree).find(predicate);},html(){return renderToStaticMarkup(React.createElement(StaticRouter,{location:'/'},h.tree));}};
 return h.render();
}

test('a seller must reserve first; the exact reserved quantity and full command appear after saving',async()=>{
 const calls=[];const h=harness(order,{id:'seller'},{reserveBuyQuantity:async(...args)=>{calls.push(args);return {id:'reservation-code',quantity:15,expires_at:'2026-10-22T12:10:00Z'};}});
 assert.doesNotMatch(h.html(),/FILL 1200/);assert.match(h.html(),/Reserve for 10 minutes/);
 h.find(n=>n.props?.id==='reserve-quantity').props.onChange({target:{value:'15'}});h.render();
 await h.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});h.render();
 assert.deepEqual(calls,[['order',15]]);assert.match(h.html(),/FILL 1200 reservation-code/);assert.match(h.html(),/15 × Item/);assert.match(h.html(),/2026-10-22T12:10:00Z/);assert.doesNotMatch(h.html(),/Reserve for 10 minutes/);
});

test('expired reservations await safe release, closing orders honor existing reservations, and unavailable orders cannot reserve',()=>{
 const r={id:'reserved',quantity:20,expires_at:'2026-10-22T11:59:00Z'};
 const h=harness({...order,myReservation:r,buyClosingReason:'cancel'});
 assert.match(h.html(),/checking timely incoming mail/);assert.match(h.html(),/FILL 1200 reserved/);assert.doesNotMatch(h.html(),/Reserve for 10 minutes/);
 const unavailable=harness({...order,availableQuantity:0});assert.match(unavailable.html(),/No quantity is currently available/);assert.doesNotMatch(unavailable.html(),/reserve-quantity/);
});

test('gift reductions are separate from purchases and buyers can see an explicit safe top-up instruction',()=>{
 const h=harness({...order,purchasedQuantity:8,quantity:10,reducedQuantity:2,remainingQuantity:0,availableQuantity:0,giftFundingNeeded:true,giftMeat:50},{id:'buyer'});
 const html=h.html();assert.match(html,/Originally requested/);assert.match(html,/Reduced for delivery expenses/);assert.match(html,/value="8" max="8"/);assert.match(html,/FUND 1200/);assert.match(html,/funds reserved for sellers cannot be used/i);
 assert.doesNotMatch(harness(order,null).html(),/FILL 1200|Reserve for 10 minutes/);
});

test('reservation service sends only the signed-in account RPC inputs and refuses invalid quantities',async()=>{
 const calls=[];const service=createAuctionService({async rpc(name,args){calls.push([name,args]);return {data:{id:'reservation'}};}});
 assert.deepEqual(await service.reserveBuy('order',20),{id:'reservation'});
 assert.deepEqual(calls,[['reserve_buy_quantity',{p_auction_id:'order',p_quantity:20}]]);
 await assert.rejects(service.reserveBuy('order',0),/positive whole/);assert.equal(calls.length,1);
});

test('canceling releases the seller reservation and hides stale fulfillment instructions after success',async()=>{
 const r={id:'cancel-me',quantity:15,expires_at:'2026-10-22T12:10:00Z'};const calls=[];
 const h=harness({...order,myReservation:r},{id:'seller'},{cancelBuyReservation:async id=>{calls.push(id);return {id,state:'cancelled'};}});
 assert.match(h.html(),/Cancel reservation/);
 await h.find(n=>n.type==='button' && n.props.children==='Cancel reservation').props.onClick();h.render();
 assert.deepEqual(calls,['cancel-me']);assert.doesNotMatch(h.html(),/FILL 1200 cancel-me|Cancel reservation/);
 assert.match(h.html(),/reserved quantity has been released/);assert.match(h.html(),/Reserve for 10 minutes/);
});

test('failed reservation cancellation retains the command, while an already fulfilled reservation cannot be reversed',async()=>{
 const r={id:'already-arrived',quantity:5,expires_at:'2026-10-22T12:10:00Z'};
 const service={cancelBuyReservation:async()=>{throw Error('Items have already arrived.');}};
 const h=harness({...order,myReservation:r},{id:'seller'},service);
 await h.find(n=>n.type==='button' && n.props.children==='Cancel reservation').props.onClick();h.render();
 assert.match(h.html(),/Items have already arrived/);assert.match(h.html(),/FILL 1200 already-arrived/);
 service.cancelBuyReservation=async()=>({id:r.id,state:'fulfilled'});h.render();
 await h.find(n=>n.type==='button' && n.props.children==='Cancel reservation').props.onClick();h.render();
 assert.match(h.html(),/already been fulfilled/);assert.doesNotMatch(h.html(),/reserved quantity has been released|FILL 1200 already-arrived/);
});

test('reservation cancellation service uses the ownership-checked RPC and propagates failures',async()=>{
 const calls=[];const client={async rpc(...args){calls.push(args);return {data:{id:'reservation',state:'cancelled'}};}};
 const service=createAuctionService(client);
 assert.deepEqual(await service.cancelBuyReservation('reservation'),{id:'reservation',state:'cancelled'});
 assert.deepEqual(calls,[['cancel_buy_reservation',{p_reservation_id:'reservation'}]]);
 client.rpc=async()=>({error:{message:'Reservation not found for your account.'}});
 await assert.rejects(service.cancelBuyReservation('other'),/not found for your account/);
});
