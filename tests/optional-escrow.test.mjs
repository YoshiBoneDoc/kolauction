import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as router from 'react-router-dom';
import { createAuctionService } from '../src/lib/auctions.js';

const { outputFiles } = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { StaticRouter } from 'react-router-dom';
    import App from './src/App.jsx';
    import { UserContext } from './src/context/UserContext.jsx';
    import { AuctionsContext } from './src/context/AuctionsContext.jsx';
    export function render({ path='/', user={id:'seller'}, ...context }) {
        return renderToStaticMarkup(<StaticRouter location={path}><UserContext.Provider value={{currentUser:user}}>
            <AuctionsContext.Provider value={{auctions:[],...context}}><App /></AuctionsContext.Provider>
        </UserContext.Provider></StaticRouter>);
    }`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env': '{}' }, loader: { '.gif': 'dataurl' },
});
const compiled = { exports: {} };
const requireModule = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react-router-dom' ? router : requireModule(name), compiled, compiled.exports);
const { render } = compiled.exports;
const auction = { id:'direct', auctionNumber:'1234', sellerId:'seller', owner:'Seller', item:'Test item', quantity:2,
    minBidMeat:100, currentBid:500, endTime:1, bids:[], escrowMode:false, status:'awaiting_trade',
    hasWinner:true, winnerId:'buyer', winner:'Buyer', finalPrice:500,
    settlementContacts:{ seller:{username:'Seller',kol_name:'Verified Seller',kol_player_id:777}, buyer:{username:'Buyer',kol_name:'Verified Buyer',kol_player_id:888} } };

test('listing form defaults to escrow and offers direct settlement before publishing', () => {
    const html = render({path:'/auction-item'});
    assert.match(html, /Settlement mode/);
    assert.match(html, /value="escrow" selected=""/);
    assert.match(html, /Direct settlement \(no escrow\)/);
    assert.match(html, /mode stays fixed after publishing/);
    assert.match(html, /7.5%/);
    assert.match(html, /Set Buyout Price \(optional\)/);
    assert.doesNotMatch(html, /id="instantPurchasePrice"|20 billion Meat/);
    assert.match(html, /placeholder="e.g. 1000, 10b, 4.53m, 50k"/);
    assert.doesNotMatch(html, /listing-amount-help|Use whole numbers or k\/m\/b shorthand/);
});

test('personal trade cards appear above auctions on home and browse, including all pages', () => {
    for (const path of ['/', '/auctions']) {
        const html = render({path,pendingTrades:[auction],pendingTotal:15});
        assert.match(html, /Trade awaiting your confirmation/);
        assert.match(html, /15 pending trades/);
        assert.match(html, /Yes, I received my side/);
        assert.match(html, /Private trade details and instructions/);
        assert.match(html, /Page 1 of 2/);
        assert.ok(html.indexOf('Your pending trades') < html.indexOf(path==='/' ? 'Popular Items' : 'Find auctions'));
        // Cards link to the full private details instead of printing identities on browse.
        assert.doesNotMatch(html, /Verified Buyer|Verified Seller|towho=/);
    }
});

test('a saved response hides the reminder only for the participant who confirmed', () => {
    const html = render({pendingTrades:[{...auction,sellerConfirmedAt:'2026-10-20'}],pendingTotal:1});
    assert.doesNotMatch(html, /Your pending trades|Your confirmation is saved. Waiting for the other party/);
    assert.doesNotMatch(html, /Yes, I received my side/);
    const buyer = render({user:{id:'buyer'},pendingTrades:[{...auction,sellerConfirmedAt:'2026-10-20'}],pendingTotal:1});
    assert.match(buyer, /You are the winning buyer/);
    assert.match(buyer, /Yes, I received my side/);
    const confirmedBuyer=render({user:{id:'buyer'},pendingTrades:[{...auction,buyerConfirmedAt:'2026-10-20'}],pendingTotal:1});
    assert.doesNotMatch(confirmedBuyer,/Your pending trades/);
    const waitingSeller=render({pendingTrades:[{...auction,buyerConfirmedAt:'2026-10-20'}],pendingTotal:1});
    assert.match(waitingSeller,/Yes, I received my side/);
});

test('anonymous and completed accounts see no personal cards; pending failures are visible', () => {
    assert.doesNotMatch(render({user:null,pendingTrades:[auction],pendingTotal:1}), /Your pending trades/);
    assert.doesNotMatch(render({pendingTrades:[],pendingTotal:0}), /Your pending trades/);
    assert.match(render({pendingError:'Private trades unavailable'}), /Private trades unavailable.*Retry/);
});

test('direct participation discloses unfunded bids and optional tips; escrow retains KMail', () => {
    const active={...auction,status:'active',currentBid:0,hasWinner:false,endTime:Date.now()+3600000,instantPurchasePrice:600};
    const html=render({path:'/auction/direct',user:{id:'buyer'},auctions:[active]});
    assert.match(html, /does not hold or verify the assets, enforce funding, or guarantee completion/);
    assert.match(html, /Bids are promises to pay/);
    assert.match(html, /tips are optional/);
    assert.match(html, /Buy Now/);
    assert.match(html, /Your bid \(Meat\)/);
    assert.doesNotMatch(html, /Direct settlement \(legacy\)/);
    const escrow=render({path:'/auction/direct',user:{id:'buyer'},auctions:[{...active,escrowMode:true,feeBps:750}]});
    assert.match(escrow, /7.5%/);
    assert.match(escrow, /BID 1234/);
    assert.doesNotMatch(escrow, /Buy Now|Your bid \(Meat\)/);
});

test('closed direct details include exact private counterparty, trade reference and contact link', () => {
    const html=render({path:'/auction/direct',auctions:[auction]});
    assert.match(html, /Verified Buyer.*#888/);
    assert.match(html, /sendmessage.php\?towho=888/);
    assert.match(html, /Use auction #1234/);
    assert.match(html, /secured in-game trade/);
    assert.match(html, /Both participants must confirm/);
    assert.match(html, /Awaiting settlement/);
});

test('direct creation explicitly sends false while old callers retain escrow by default', async () => {
    const modes=[];
    const service=createAuctionService({async rpc(name,params) { modes.push(params.p_escrow_mode); return {data:'created'}; }});
    await service.create({item:'a',quantity:1,minBidMeat:100,auctionTime:24,escrowMode:false});
    await service.create({item:'a',quantity:1,minBidMeat:100,auctionTime:24});
    assert.deepEqual(modes,[false,true]);
});

test('pending read is paginated, projects contacts and refuses old or failing responses', async () => {
    const calls=[];
    const service=createAuctionService({async rpc(name,params) {
        calls.push([name,params]);
        return {data:{privacy_version:1,total:15,rows:[{id:'a',quantity:2,current_bid:500,final_price:500,settlement_contacts:auction.settlementContacts}]}};
    }});
    const data=await service.pendingTrades(2);
    assert.deepEqual(calls,[['read_pending_trades',{p_page:2}]]);
    assert.equal(data.total,15);
    assert.equal(data.auctions[0].settlementContacts.buyer.kol_player_id,888);
    await assert.rejects(createAuctionService({async rpc() {return {data:{rows:[]}};}}).pendingTrades(),/temporarily unavailable/);
    await assert.rejects(createAuctionService({async rpc() {return {error:{code:'PGRST202'}};}}).pendingTrades(),/pending auction SQL migrations/);
});

test('unconfirmed participants can open a trade-problem form, while reported and unrelated accounts cannot',()=>{
    const closed={...auction,finalizedAt:'2026-10-20T12:00:00Z'};
    const cards=render({pendingTrades:[closed],pendingTotal:1});
    assert.match(cards,/href="\/auction\/direct\/report-trade"[^>]*>👎 No, report a problem/);
    const form=render({path:'/auction/direct/report-trade',auctions:[closed]});
    assert.match(form,/<textarea[^>]*maxLength="2000"/);
    assert.match(form,/Submit thumbs down/);
    assert.doesNotMatch(form,/<textarea[^>]*(?:required|minLength)/);
    assert.doesNotMatch(render({path:'/auction/direct/report-trade',user:{id:'stranger'},auctions:[closed]}),/<textarea/);
    assert.doesNotMatch(render({path:'/auction/direct/report-trade',auctions:[{...closed,sellerConfirmedAt:'2026-10-20'}]}),/<textarea/);
    assert.doesNotMatch(render({pendingTrades:[{...closed,ownTradeReport:'B-1234'}],pendingTotal:1}),/Your pending trades/);
    const reported=render({path:'/auction/direct',auctions:[{...closed,ownTradeReport:'B-1234',tradeReported:true}]});
    assert.match(reported,/Your thumbs-down response B-1234 is saved/);
    assert.doesNotMatch(reported,/Confirm my trade is complete|No, report a problem/);
});

test('a reported trade offers author withdrawal and a participant-only administrator query',()=>{
    const trade={...auction,finalizedAt:'2026-10-20T12:00:00Z',ownTradeReport:'B-1234',tradeReported:true};
    const html=render({path:'/auction/direct',auctions:[trade]});
    assert.match(html,/Withdraw thumbs down/);
    assert.match(html,/Ask an administrator about this trade/);
    const withdrawn=render({path:'/auction/direct',auctions:[{...trade,ownTradeReportWithdrawn:true,tradeReported:false}]});
    assert.match(withdrawn,/Confirm my trade is complete/);
    assert.doesNotMatch(withdrawn,/Withdraw thumbs down|No, report a problem/);
    assert.match(render({path:'/auction/direct/trade-query',auctions:[trade]}),/<textarea[^>]*minLength="10"/);
    assert.doesNotMatch(render({path:'/auction/direct/trade-query',auctions:[trade],user:{id:'outsider'}}),/<textarea/);
});
