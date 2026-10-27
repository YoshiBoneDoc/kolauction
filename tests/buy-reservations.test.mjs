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
const readable = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const now=Date.parse('2026-10-22T12:00:00Z');
const order={id:'order',auctionNumber:'1200',auctionKind:'buy',item:'Item',quantity:100,pricePerItem:200,sellerId:'buyer',status:'active',escrowMode:true,purchasedQuantity:20,remainingQuantity:80,availableQuantity:60,reservedQuantity:20,reducedQuantity:0,deliveryMode:'immediate',endTime:now+3600000,fulfillments:[],giftMeat:0};
function harness(auction=order,user={id:'seller'},service={}){
 const h={slots:[],cursor:0,auction,now,contexts:new Map([[UserContext,{currentUser:user}],[AuctionsContext,service]]),render(){active=h;h.cursor=0;h.tree=BuyAuctionDetails({auction:h.auction,now:h.now});return h;},find(predicate){return nodes(h.tree).find(predicate);},html(){return renderToStaticMarkup(React.createElement(StaticRouter,{location:'/'},h.tree));}};
 return h.render();
}

test('a seller must reserve first; the exact reserved quantity and full command appear after saving',async()=>{
 const calls=[];const h=harness(order,{id:'seller'},{reserveBuyQuantity:async(...args)=>{calls.push(args);return {id:'reservation-code',quantity:15,expires_at:'2026-10-22T12:10:00Z'};}});
 assert.doesNotMatch(h.html(),/FILL 1200/);assert.match(h.html(),/Reserve for 10 minutes/);
 h.find(n=>n.props?.id==='reserve-quantity').props.onChange({target:{value:'15'}});h.render();
 await h.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});h.render();
 assert.deepEqual(calls,[['order',15]]);assert.match(h.html(),/FILL 1200 reservation-code/);assert.match(h.html(),/15 × Item/);assert.match(h.html(),/2026-10-22T12:10:00Z/);assert.doesNotMatch(h.html(),/Reserve for 10 minutes/);
});

test('expired reservations return to the form, closing orders honor live reservations, and unavailable orders cannot reserve',()=>{
 const r={id:'reserved',quantity:20,expires_at:'2026-10-22T12:10:00Z'};
 const h=harness({...order,myReservation:r,buyClosingReason:'cancel'});
 assert.match(h.html(),/Send within/);assert.match(h.html(),/FILL 1200 reserved/);assert.doesNotMatch(h.html(),/Reserve for 10 minutes/);
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
  assert.doesNotMatch(html,/The price applies to each item/);assert.match(readable(html),/2,000 Meat paid/);
 }
 for(const [user,auction] of [[{id:'buyer'},listing],[{id:'admin'},{...listing,buyAdmin:true}]]){
  const html=harness(auction,user).html();assert.match(html,/Tiered Fee \(5%\): 100 Meat/);assert.match(html,/Remaining escrow/);assert.match(html,/Fees range from 1–5%/);
  if(user.id==='buyer')assert.match(readable(html),/Delivery: As items are acquired/);
  else assert.doesNotMatch(html,/>Delivery:/);
 }
 assert.doesNotMatch(harness({...listing,buyAdmin:true},null).html(),/Tiered Fee|Remaining escrow|Gift expenses|>Delivery:/);
 const finished={...listing,deliveryMode:'finished'};
 assert.match(readable(harness(finished,{id:'buyer'}).html()),/Delivery: When the order is fully filled, expires, or is canceled/);
 assert.doesNotMatch(harness(finished,{id:'seller'}).html(),/>Delivery:/);
});


test('closed Buy orders show the actual outcome and concise sales without claiming queued payments were received',()=>{
 const fill={seller:'Anrath1',quantity:15,price_per_item:100,payment_meat:1500,payment_sent:true,created_at:'2026-10-22T23:17:58Z'};
 for(const [status,reason,label] of [['completed','filled','Trade completed'],['cancelled','cancel','Canceled early'],['expired','deadline','Expired'],['voided',null,'Cancelled by administrator'],['settling','cancel','Closing — cancelled']]){
  const html=harness({...order,status,buyClosingReason:reason,purchasedQuantity:15,quantity:15,fulfillments:[fill]}).html();
  assert.match(html,/100% filled/);assert.match(html,new RegExp(`>${label}</span>`));
  assert.match(html,/>Anrath1<\/p>/);assert.match(html,/15 items/);assert.match(readable(html),/1,500 Meat paid/);
  assert.match(html,/dateTime="2026-10-22T23:17:58Z"/i);
  assert.doesNotMatch(html,/The price applies to each item|Completed purchases cannot be reversed|items ×/);
  if(status!=='completed')assert.doesNotMatch(html,/Trade completed/);
 }
 const pending=harness({...order,status:'settling',buyClosingReason:'deadline',fulfillments:[{...fill,payment_sent:false}]}).html();
 assert.match(pending,/15 items/);assert.match(readable(pending),/1,500 Meat payment queued/);assert.doesNotMatch(pending,/Meat received/);
 const live=harness({...order,fulfillments:[fill]}).html();
 assert.match(live,/You receive the full listed price. The buyer covers all escrow fees./);assert.match(live,/15 items/);assert.doesNotMatch(readable(live),/100 Meat\/item/);assert.match(readable(live),/1,500 Meat paid/);
});


test('Buy summary distinguishes partial purchases, final outcomes and active reservation availability',()=>{
 for(const [status,label,color] of [['completed','Trade completed','text-green-700'],['cancelled','Canceled early','text-purple-700'],['expired','Expired','text-amber-700']]){
  const h=harness({...order,status,quantity:20,purchasedQuantity:5,remainingQuantity:15});
  const html=h.html();assert.match(html,/>5 <span[^>]*>\/ 20<\/span>/);
  const outcome=h.find(n=>n.props?.['aria-label']==='Auction status');
  assert.equal(outcome.props.children,label);assert.match(outcome.props.className,new RegExp(color));
  const progress=h.find(n=>n.type==='progress');assert.equal(progress.props.value,5);assert.equal(progress.props.max,20);assert.equal(progress.props['data-status'],status);
  assert.doesNotMatch(html,/Still requested:|Available to reserve:|Reserved:|Adjusted quantity:|Quantity removed from order:/);
 }
 const full=harness({...order,status:'completed',quantity:20,purchasedQuantity:20}).html();
 assert.match(full,/>20 <span[^>]*>\/ 20<\/span>/);assert.match(full,/100% filled/);
 const activeOrder=harness({...order,reducedQuantity:2});
 const live=activeOrder.html();
 assert.equal(activeOrder.find(n=>n.props?.['aria-label']==='Auction status').props.children,'In Progress');
 assert.match(activeOrder.find(n=>n.props?.['aria-label']==='Auction status').props.className,/text-\[#B7791F\]/);
 assert.match(activeOrder.find(n=>n.type==='progress').props.className,/accent-blue-500/);
 assert.match(live,/60 available · 20 reserved/);assert.doesNotMatch(live,/Quantity removed from order|Reduced for delivery expenses/);
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
   assert.match(html,/>Seller<\/p>/);
  }
 }
 const legacy=harness({...order,fulfillments:[{...fill,seller_id:null}]}).html();
 assert.match(legacy,/Real KoL Seller/);assert.doesNotMatch(legacy,/seller-profile-id/);
});

test('compact Buy layout keeps sub-percent progress, exact timing, outlined resources and collapsed history',()=>{
 const listing={...order,itemId:2,quantity:50000,purchasedQuantity:13,availableQuantity:49987,reservedQuantity:0,
  fulfillments:[{seller:'Vendor',seller_id:'vendor-id',quantity:13,price_per_item:200,payment_meat:2600,payment_sent:true,created_at:'2026-10-22T12:00:00Z',delivery_references:[{reference:'mail-123',state:'sent'}]}]};
 const h=harness(listing);const html=h.html();
 assert.match(html,/&lt;1% filled/);assert.match(html,/49,987 available · 0 reserved/);
 for(const heading of ['Offer Price','Order Progress','Time Remaining'])assert.match(html,new RegExp(heading));
 assert.match(html,/dateTime="2026-10-22T13:00:00.000Z"/);
 const history=h.find(n=>n.type==='details'&&n.props['aria-label']==='Fulfillment history');
 assert.ok(history);assert.ok(!history.props.open);assert.match(html,/Fulfillment History \(1\)/);
 assert.doesNotMatch(html,/Latest 100 accepted fulfillments/);assert.match(readable(html),/2,600 Meat paid/);assert.match(html,/mail-123 \(sent\)/);
 assert.match(html,/href="https:\/\/wiki.kingdomofloathing.com\/Item"/);assert.match(html,/href="https:\/\/pricegun.loathers.net\/item\/2"/);
 assert.match(html,/border-\[#E8D9D2\]/);
 const guest=harness(listing,null).html();
 assert.match(guest,/Log in to sell items →/);assert.doesNotMatch(guest,/reserve-quantity|vendor-id|>Vendor</);
 for(const [purchasedQuantity,expected] of [[0,'0% filled'],[500,'1% filled'],[50000,'100% filled']])assert.ok(harness({...listing,purchasedQuantity}).html().includes(expected));
});

test('pending funding and owner controls survive the Buy layout redesign',()=>{
 const listing={...order,status:'pending_escrow',fundingRequired:21000,balanceMeat:0,purchaseMeat:0,buyCommissionMeat:0,refundedMeat:0,heldQuantity:0};
 const owner=harness(listing,{id:'buyer'}).html();
 assert.match(owner,/Starts after funding/);assert.match(owner,/FUND 1200/);assert.match(owner,/Cancel remaining order/);
 assert.match(readable(owner),/Send 21,000 Meat to kHub \(#3888760\) via KMail\. Include the command below in the message body\. Attach no items\./);
 assert.match(readable(owner),/Purchase funds: 20,000 Meat · Fee reserve \(5%\): 1,000 Meat/);
 assert.match(owner,/<h2 class="mb-4 text-2xl font-bold leading-tight">Fund your order<\/h2>/);
 assert.match(readable(owner),/Deposit within 24 hours\. Your auction starts once funding is accepted\./);
 assert.doesNotMatch(owner,/Commission reserve|Remaining escrow|Purchased items still held/);
 for(const user of [null,{id:'other'},{id:'buyer',isBanned:true}])assert.doesNotMatch(harness(listing,user).html(),/FUND 1200|Cancel remaining order|reserve-quantity/);
});

test('reservation confirmation is compact, copies the full command and highlights the two-minute deadline',()=>{
 for(const [milliseconds,color] of [[600000,'text-[#B7791F]'],[120000,'text-[#B7791F]'],[119999,'text-red-700']]){
  const reservation={id:'12345678-abcd-1234-abcd-123456789012',quantity:15,expires_at:new Date(now+milliseconds).toISOString()};
  const h=harness({...order,myReservation:reservation});
  const panel=h.find(n=>n.type==='section'&&n.props['aria-label']==='Fulfill buy auction');
  const html=renderToStaticMarkup(React.createElement(StaticRouter,{location:'/'},panel));
  assert.match(html,/✓ Reservation confirmed/);assert.match(html,/15 × Item/);
  assert.match(html,/<strong class="buy-detail-title font-bold[^"]*">15 × Item<\/strong>/);
  assert.doesNotMatch(html,/Sell Item|Receive |per item|Up to |buyer covers/);
  assert.match(html,/via KMail, with no Meat or other items. Include the command below:/);
  assert.match(html,/Late or incorrect deposits will be returned/);assert.match(html,/Only cancel if you haven’t sent the items/);
  assert.match(html,/aria-label="Copy reserved fulfillment command"/);assert.match(html,/font-mono/);
  const deadline=h.find(n=>n.props?.className?.includes('buy-reservation-deadline'));
  assert.ok(deadline.props.className.includes(color));
  assert.ok(html.includes(`dateTime="${reservation.expires_at}"`));
  assert.match(html,/Send within/);
  const command=h.find(n=>n.props?.label==='reserved fulfillment command');
  assert.equal(command.props.text,`FILL 1200 ${reservation.id}`);assert.equal(command.props.compact,true);
 }
});

test('fulfillment history groups seller and date with inline quantity and payment',()=>{
 const fill={seller:'Anrath1',seller_id:'vendor-id',quantity:13,price_per_item:30,payment_meat:390,payment_sent:true,created_at:'2026-10-24T19:25:00Z',delivery_references:[{reference:'delivery-1',state:'sent'}]};
 for(const status of ['active','completed','cancelled','expired']){
  const h=harness({...order,status,fulfillments:[fill]});
  const history=h.find(n=>n.type==='ul'&&n.props['aria-label']==='Buy auction fulfillments');assert.ok(history);
  const html=h.html();
  assert.match(html,/Oct 24, 2026, \d{1,2}:25 [AP]M/);assert.match(html,/dateTime="2026-10-24T19:25:00Z"/);
  assert.match(html,/href="\/seller\/vendor-id"[^>]*>Anrath1<\/a>/);
  assert.match(html,/13 items/);assert.doesNotMatch(readable(html),/30 Meat\/item/);
  assert.match(html,/class="font-semibold">390 Meat<\/span> paid/);
  assert.match(html,/delivery-1 \(sent\)/);assert.doesNotMatch(html,/Latest 100 accepted fulfillments/);
 }
});


test('the live countdown restores the reservation form at expiry without cancelling or releasing server availability',async()=>{
 const reservation={id:'expiring',quantity:15,expires_at:new Date(now+1000).toISOString()};
 const calls=[];
 const h=harness({...order,myReservation:reservation},{id:'seller'},{cancelBuyReservation:async()=>{calls.push('cancel');},reserveBuyQuantity:async()=>({id:'new-reservation',quantity:1,expires_at:new Date(now+600000).toISOString()})});
 assert.match(h.html(),/Reservation confirmed/);assert.match(h.html(),/FILL 1200 expiring/);
 h.now=now+1000;h.render();
 assert.match(h.html(),/Sell Item/);assert.match(h.html(),/Reserve for 10 minutes/);
 assert.doesNotMatch(h.html(),/Reservation confirmed|FILL 1200 expiring|Cancel reservation|Deadline passed/);
 assert.deepEqual(calls,[]);
 assert.equal(h.find(n=>n.props?.id==='reserve-quantity').props['aria-valuemax'],60);
 await h.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});h.render();
 assert.match(h.html(),/FILL 1200 new-reservation/);
 const unavailable=harness({...order,availableQuantity:0,myReservation:{...reservation,expires_at:new Date(now).toISOString()}});
 assert.match(unavailable.html(),/No quantity is currently available/);assert.doesNotMatch(unavailable.html(),/Reserve for 10 minutes|FILL 1200/);
});
