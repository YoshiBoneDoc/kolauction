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

test('Buy details never ask for packaging top-ups or show packaging deductions',()=>{
 const html=harness({...order,giftFundingNeeded:true,giftMeat:50},{id:'buyer'}).html();
 assert.doesNotMatch(html,/Gift delivery funding|FUND 1200|Reduced for delivery expenses|Quantity removed from order|Gift expenses|50 Meat|top-up/i);
 assert.match(html,/Free gift packaging is used only while in Hardcore\/Ronin/);
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

test('Buy fees and cost explanations are private to the creator and administrator',()=>{
 const listing={...order,status:'completed',buyClosingReason:'filled',balanceMeat:0,purchaseMeat:2000,buyCommissionMeat:100,giftMeat:50,refundedMeat:0,heldQuantity:0,
  fulfillments:[{seller:'Vendor',quantity:10,price_per_item:200,payment_meat:2000,commission_meat:100,payment_sent:true,created_at:'2026-10-22T12:00:00Z'}]};
 for(const user of [null,{id:'other'},{id:'seller'},{id:'buyer',isBanned:true}]){
  const html=harness(listing,user).html();
  assert.doesNotMatch(html,/Tiered Fee|commission|Remaining escrow|Gift expenses|Fees start|Gift Delivery:|>Delivery:/i);
  assert.doesNotMatch(html,/The price applies to each item/);assert.match(html,/2,000 Meat received/);
 }
 for(const [user,auction] of [[{id:'buyer'},listing],[{id:'admin'},{...listing,buyAdmin:true}]]){
  const html=harness(auction,user).html();assert.match(html,/Tiered Fee \(5%\): 100 Meat/);assert.match(html,/Remaining escrow/);assert.match(html,/Fees range from 1–5%/);
  if(user.id==='buyer')assert.match(html,/Delivery: As items are acquired/);
  else assert.doesNotMatch(html,/>Delivery:/);
 }
 assert.doesNotMatch(harness({...listing,buyAdmin:true},null).html(),/Tiered Fee|Remaining escrow|Gift expenses|>Delivery:/);
 const finished={...listing,deliveryMode:'finished'};
 assert.match(harness(finished,{id:'buyer'}).html(),/Delivery: When the order is fully filled, expires, or is canceled/);
 assert.doesNotMatch(harness(finished,{id:'seller'}).html(),/>Delivery:/);
});


test('closed Buy orders show the actual outcome and concise sales without claiming queued payments were received',()=>{
 const fill={seller:'Anrath1',quantity:15,price_per_item:100,payment_meat:1500,payment_sent:true,created_at:'2026-10-22T23:17:58Z'};
 for(const [status,reason,label] of [['completed','filled','Trade completed'],['cancelled','cancel','Canceled early'],['expired','deadline','Expired'],['voided',null,'Cancelled by administrator'],['settling','cancel','Closing — cancelled']]){
  const html=harness({...order,status,buyClosingReason:reason,purchasedQuantity:15,quantity:15,fulfillments:[fill]}).html();
  assert.match(html,/100% filled/);assert.match(html,new RegExp(`>${label}</span>`));
  assert.match(html,/Anrath1 · Sold 15 items · 1,500 Meat received/);
  assert.match(html,/dateTime="2026-10-22T23:17:58Z"/i);
  assert.doesNotMatch(html,/The price applies to each item|Completed purchases cannot be reversed|items ×/);
  if(status!=='completed')assert.doesNotMatch(html,/Trade completed/);
 }
 const pending=harness({...order,status:'settling',buyClosingReason:'deadline',fulfillments:[{...fill,payment_sent:false}]}).html();
 assert.match(pending,/Sold 15 items · 1,500 Meat payment queued/);assert.doesNotMatch(pending,/Meat received/);
 const live=harness({...order,fulfillments:[fill]}).html();
 assert.match(live,/Any associated Escrow fees are paid by the buyer/);assert.match(live,/<strong>Sellers receive the full listed price\.<\/strong>/);assert.match(live,/15 items × 100 Meat \/ item · 1,500 Meat paid/);
});


test('Buy summary distinguishes partial purchases, final outcomes and active reservation availability',()=>{
 for(const [status,label,color] of [['completed','Trade completed','text-green-700'],['cancelled','Canceled early','text-purple-700'],['expired','Expired','text-amber-700']]){
  const h=harness({...order,status,quantity:20,purchasedQuantity:5,remainingQuantity:15});
  const html=h.html();assert.match(html,/Purchased: <strong>5\/20<\/strong>/);
  const outcome=h.find(n=>n.props?.['aria-label']==='Auction status');
  assert.equal(outcome.props.children,label);assert.match(outcome.props.className,new RegExp(color));
  const progress=h.find(n=>n.type==='progress');assert.match(progress.props.className,new RegExp(color.replace('text-', 'accent-')));
  assert.doesNotMatch(html,/Still requested:|Available to reserve:|Reserved:|Adjusted quantity:|Quantity removed from order:/);
 }
 const full=harness({...order,status:'completed',quantity:20,purchasedQuantity:20}).html();
 assert.match(full,/Purchased: <strong>20<\/strong>/);assert.doesNotMatch(full,/20\/20/);
 const activeOrder=harness({...order,reducedQuantity:2});
 const live=activeOrder.html();
 assert.equal(activeOrder.find(n=>n.props?.['aria-label']==='Auction status').props.children,'In Progress');
 assert.match(activeOrder.find(n=>n.props?.['aria-label']==='Auction status').props.className,/text-yellow-700/);
 assert.match(activeOrder.find(n=>n.type==='progress').props.className,/accent-yellow-500/);
 assert.match(live,/Available to reserve:/);assert.match(live,/Reserved:/);assert.doesNotMatch(live,/Quantity removed from order|Reduced for delivery expenses/);
 assert.doesNotMatch(live,/Adjusted quantity/);
 assert.doesNotMatch(harness({...order,buyClosingReason:'cancel'}).html(),/Available to reserve:/);
});


test('Buy support link is available only to the creator or a verified fulfillment seller',()=>{
 for(const status of ['active','completed','cancelled','expired']){
  const listing={...order,status};
  assert.match(harness(listing,{id:'buyer'}).html(),/Contact an administrator about this order/);
  assert.match(harness({...listing,fulfilledByMe:true},{id:'seller'}).html(),/Contact an administrator about this order/);
  for(const [auction,user] of [[listing,null],[listing,{id:'other'}],[{...listing,buyAdmin:true},{id:'admin'}],[{...listing,myReservation:{id:'r',quantity:1,expires_at:'2026-10-22T12:10:00Z'}},{id:'seller'}],[{...listing,fulfilledByMe:true},{id:'seller',isBanned:true}],[{...listing,usernamesVisible:false},{id:'buyer'}],[{...listing,fulfilledByMe:'false'},{id:'other'}]])
   assert.doesNotMatch(harness(auction,user).html(),/Contact an administrator about this order/);
 }
});


test('signed-in unrestricted viewers see Buy seller links; guests and restricted views hide names and IDs',()=>{
 const fill={seller:'Real KoL Seller',seller_id:'seller-profile-id',quantity:5,price_per_item:200,payment_meat:1000,payment_sent:true,created_at:'2026-10-22T12:00:00Z'};
 for(const status of ['active','completed']) {
  for(const user of [{id:'outsider'},{id:'seller-profile-id'}]) {
   const html=harness({...order,status,fulfillments:[fill]},user).html();
   assert.match(html,/href="\/seller\/seller-profile-id"[^>]*>Real KoL Seller<\/a>/);
   assert.match(html,/1,000 Meat/);
  }
  for(const [user,extra] of [[null,{}],[{id:'banned',isBanned:true},{}],[{id:'outsider'},{usernamesVisible:false}]]) {
   const html=harness({...order,status,...extra,fulfillments:[fill]},user).html();
   assert.doesNotMatch(html,/Real KoL Seller|seller-profile-id/);
   assert.match(html,/Seller ·/);
  }
 }
 const legacy=harness({...order,fulfillments:[{...fill,seller_id:null}]}).html();
 assert.match(legacy,/Real KoL Seller/);assert.doesNotMatch(legacy,/seller-profile-id/);
});
