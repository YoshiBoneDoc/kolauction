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
    assert.match(html, /Trading Method/);
    assert.match(html, /type="button" aria-pressed="true"[^>]*>Escrow<\/button>/);
    assert.match(html, /type="button" aria-pressed="false"[^>]*>Direct<\/button>/);
    assert.doesNotMatch(html, /id="settlement-mode"/);
    assert.match(html, /mode stays fixed after publishing/);
    assert.match(html, /<option value="168">7 Days<\/option><option value="336">14 Days<\/option><option value="720">1 Month<\/option>/);
    assert.match(html, /Fees start at 5%/);
    assert.match(html, /each rate applying only to its portion of the final price/);
    assert.match(html, /rounded down to whole Meat/);
    assert.doesNotMatch(html, /7\.5%/);
    assert.match(html, /Set Buyout Price \(optional\)/);
    assert.doesNotMatch(html, /id="instantPurchasePrice"|20 billion Meat/);
    assert.match(html, /placeholder="e.g. 1000, 10b, 4.53m, 50k"/);
    assert.doesNotMatch(html, /listing-amount-help|Use whole numbers or k\/m\/b shorthand/);
});

test('personal trade cards appear above auctions on home and browse, including all pages', () => {
    for (const path of ['/', '/auctions']) {
        const html = render({path,pendingTrades:[auction],pendingTotal:15});
        assert.match(html, /Trades? awaiting your response/);
        assert.match(html, /15 pending trades/);
        assert.match(html, /Confirm Complete/);
        assert.match(html, /Private trade details and instructions/);
        assert.match(html, /Page 1 of 2/);
        assert.ok(html.indexOf('Your pending trades') < html.indexOf(path==='/' ? 'Explore Auctions' : 'Find auctions'));
        // Cards link to the full private details instead of printing identities on browse.
        assert.doesNotMatch(html, /Verified Buyer|Verified Seller|towho=/);
    }
});

test('a saved response switches the reminder to experience feedback only for that participant', () => {
    const html = render({pendingTrades:[{...auction,sellerConfirmedAt:'2026-10-20'}],pendingTotal:1});
    assert.match(html, /Your pending trades/);assert.match(html,/How was your experience trading with this player/);assert.match(html,/Thumbs up for this buyer/);
    assert.doesNotMatch(html, /Confirm Complete/);
    const buyer = render({user:{id:'buyer'},pendingTrades:[{...auction,sellerConfirmedAt:'2026-10-20'}],pendingTotal:1});
    assert.match(buyer, /#1234 · Buyer ·/);
    assert.match(buyer, /Confirm Complete/);
    const confirmedBuyer=render({user:{id:'buyer'},pendingTrades:[{...auction,buyerConfirmedAt:'2026-10-20'}],pendingTotal:1});
    assert.match(confirmedBuyer,/How was your experience trading with this player/);assert.doesNotMatch(confirmedBuyer,/Confirm Complete/);
    const waitingSeller=render({pendingTrades:[{...auction,buyerConfirmedAt:'2026-10-20'}],pendingTotal:1});
    assert.match(waitingSeller,/Confirm Complete/);
});

test('anonymous and completed accounts see no personal cards; pending failures are visible', () => {
    assert.doesNotMatch(render({user:null,pendingTrades:[auction],pendingTotal:1}), /Your pending trades/);
    assert.doesNotMatch(render({pendingTrades:[],pendingTotal:0}), /Your pending trades/);
    assert.match(render({pendingError:'Private trades unavailable'}), /Private trades unavailable.*Retry/);
});

test('direct participation discloses unfunded bids and optional tips; escrow retains KMail', () => {
    const active={...auction,status:'active',currentBid:0,hasWinner:false,endTime:Date.now()+3600000,instantPurchasePrice:600};
    const html=render({path:'/auction/direct',user:{id:'buyer'},auctions:[active]});
    assert.match(html, /Direct Trade — How It Works/);
    assert.match(html, /does not guarantee payment or delivery/);
    assert.doesNotMatch(html, /Direct settlement: trade with the other player after closing/);
    assert.match(html, /Bids are promises to pay/);
    assert.match(html, /within 48 hours, unless both agree to an extension/);
    assert.match(html, /Tips are entirely optional/);
    assert.match(html, /Buy Now/);
    assert.match(html, /Your bid \(Meat\)/);
    assert.doesNotMatch(html, /Direct settlement \(legacy\)/);
    const escrow=render({path:'/auction/direct',user:{id:'buyer'},auctions:[{...active,escrowMode:true,feeBps:750}]});
    assert.doesNotMatch(escrow, /7.5%|seller commission|Seller fee:/);
    assert.match(escrow, /Escrow Protection — How It Works/);
    assert.doesNotMatch(escrow, /Your bids are secured by kHub, with up to 1M Meat in loss protection during early access/);
    assert.match(escrow, /Fast Delivery:[\s\S]*Early Access Escrow Guarantee:[\s\S]*up to 1,000,000 Meat per affected user\.[\s\S]*<\/details>/);
    assert.doesNotMatch(html, /Early Access Escrow Guarantee:/);
    assert.match(escrow, /BID 1234/);
    assert.doesNotMatch(escrow, /Buy Now|Your bid \(Meat\)/);
});

test('closed direct details show a compact summary and private trade instructions', () => {
    const html=render({path:'/auction/direct',auctions:[{...auction,instantPurchasedAt:'2026-10-20T19:56:10Z'}]});
    assert.match(html, /Verified Buyer.*#888/);
    assert.match(html, /<strong>Verified Buyer \(#888\)<\/strong>/);
    assert.match(html, /href="https:\/\/www.kingdomofloathing.com\/sendmessage.php\?towho=888"[^>]*>in-game trade<\/a>/);
    assert.match(html, /send <strong>2 × Test item<\/strong> in exchange for <strong>500 Meat/);
    assert.match(html, /Confirm below only after you have received your side/);
    assert.match(html, /text-lg font-bold text-\[#476A91\][^>]*>Awaiting settlement<\/p>/);
    assert.ok(html.indexOf('Sold by:') < html.indexOf('Winning bidder:'));
    assert.ok(html.indexOf('Buyout accepted for 500 Meat') < html.indexOf('Sold by:'));
    assert.match(html.replace(/<[^>]*>/g, ''), /Auction #1234 · Min Bid: 100 Meat/);
    assert.ok(html.indexOf('Buyout accepted for 500 Meat') < html.indexOf('Trade instructions'));
    assert.doesNotMatch(html, /Full reference|Use auction|Direct settlement:|Bidding ended early/);
    assert.match(html, /Awaiting settlement/);
    assert.doesNotMatch(html, /At least one party reported the trade incomplete/);
    for (const [changes, color, label] of [
        [{status:'completed'}, '15803D', 'Trade completed'],
        [{tradeReported:true}, 'DC2626', 'Reported Incomplete'],
        [{sellerReportedIncomplete:true}, 'DC2626', 'Reported Incomplete'],
        [{buyerReportedIncomplete:true}, 'DC2626', 'Reported Incomplete'],
        [{status:'cancelled'}, '64748B', 'Cancelled'],
    ]) {
        const statusHtml=render({path:'/auction/direct',auctions:[{...auction,...changes}]});
        assert.ok(statusHtml.includes(`text-lg font-bold text-[#${color}]">${label}</p>`));
        if (changes.tradeReported) {
            assert.match(statusHtml, /text-xs leading-4 text-gray-500">At least one party reported the trade incomplete\.<\/p>/);
            assert.doesNotMatch(statusHtml, /Issue reported|Disputed/);
        }
    }
});

test('closed cards keep a consistent trade badge and summary across modes and viewer roles', () => {
    const trade={...auction,owner:'Public Seller',winner:'Public Buyer',publicWinner:true,
        finalizedAt:'2026-10-20T12:00:00Z',instantPurchasedAt:'2026-10-20T12:00:00Z',
        feeMeat:37,feeBps:750,tradeReported:true,ownTradeReport:'B-5678'};
    for (const escrowMode of [false,true]) {
        for (const user of [{id:'seller'},{id:'buyer'},{id:'other'},null,{id:'seller',isBanned:true}]) {
            const html=render({path:'/auction/direct',user,auctions:[{...trade,escrowMode}]});
            const top=html.split('aria-label="Auction outcome"')[0].split('aria-label="Auction escrow"')[0];
            const participant=Boolean(user && !user.isBanned && ['seller','buyer'].includes(user.id));
            assert.match(top,escrowMode ? />Escrow<\/span>/ : />Direct trade<\/span>/);
            assert.match(top,/Final price:/);
            assert.match(top,/Winning bidder:/);
            assert.ok(top.indexOf('Buyout accepted for') < top.indexOf('Sold by:'));
            if (user && !user.isBanned) {
                assert.match(top,/href="\/seller\/seller"[^>]*>Public Seller/);
                assert.match(top,/href="\/seller\/buyer"[^>]*>Public Buyer/);
            } else {
                assert.doesNotMatch(html,/Public Seller|Public Buyer|Verified Buyer|Verified Seller/);
            }
            if (!escrowMode && participant) {
                assert.match(html,/Your trading partner:/);
                assert.match(html,/Reference: B-5678/);
                assert.match(top,/At least one party reported the trade incomplete/);
                assert.match(html,/Mark Trade Complete<\/button>/);
                assert.match(html,/Contact an Administrator/);
                assert.match(html,user.id === 'seller'
                    ? /send <strong>2 × Test item<\/strong> in exchange for <strong>500 Meat/
                    : /send <strong>500 Meat<\/strong> in exchange for <strong>2 × Test item/);
            } else {
                assert.doesNotMatch(html,/Your trading partner:|Verified Buyer|Verified Seller|Reference: B-5678|Withdraw Incomplete Report|Trade instructions/);
                if (escrowMode && participant) assert.match(html,/Contact an Administrator/);
                else assert.doesNotMatch(html,/Contact an Administrator/);
            }
            if (!escrowMode) assert.match(top,/At least one party reported the trade incomplete/);
            assert.doesNotMatch(html,/Confirm Complete|Report Incomplete/);
        }
    }
    const masked=render({path:'/auction/direct',user:{id:'seller'},auctions:[{...trade,usernamesVisible:false}]});
    assert.doesNotMatch(masked,/Public Seller|Public Buyer|Verified Buyer|Verified Seller|Your trading partner:|Withdraw Incomplete Report|Contact an Administrator|B-5678/);
});

test('active cards show only the appropriate bidding, buyout and cancellation actions', () => {
    const active={...auction,status:'active',hasWinner:false,currentBid:0,highestBidderId:null,
        winnerId:null,bidCount:0,endTime:Date.now()+3600000,instantPurchasePrice:600};
    for (const escrowMode of [false,true]) {
        for (const user of [{id:'seller'},{id:'buyer'},{id:'other'},null,{id:'buyer',isBanned:true}]) {
            const html=render({path:'/auction/direct',user,auctions:[{...active,escrowMode}]});
            assert.match(html,escrowMode ? />Escrow<\/span>/ : />Direct trade<\/span>/);
            if (user?.id === 'seller') {
                assert.match(html,/This is your listing/);
                assert.match(html,/Cancel this listing/);
                assert.doesNotMatch(html,/Your bid \(Meat\)|>Buy Now<|Log in to bid/);
            } else if (!user) {
                assert.match(html,/Log in to bid/);
                assert.doesNotMatch(html,/Your bid \(Meat\)|Cancel this listing/);
            } else if (user.isBanned) {
                assert.match(html,/Bidding is unavailable for this account/);
                assert.doesNotMatch(html,/Your bid \(Meat\)|>Buy Now<|Cancel this listing|BID 1234/);
            } else {
                assert.match(html,escrowMode ? /BID 1234/ : /Your bid \(Meat\)/);
                assert.doesNotMatch(html,/Cancel this listing/);
            }
        }
    }
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
    assert.match(cards,/href="\/auction\/direct\/report-trade"[^>]*>Report Incomplete/);
    const form=render({path:'/auction/direct/report-trade',auctions:[closed]});
    assert.match(form,/<textarea[^>]*maxLength="2000"/);
    assert.match(form,/Report Incomplete/);
    assert.doesNotMatch(form,/<textarea[^>]*(?:required|minLength)/);
    assert.doesNotMatch(render({path:'/auction/direct/report-trade',user:{id:'stranger'},auctions:[closed]}),/<textarea/);
    assert.doesNotMatch(render({path:'/auction/direct/report-trade',auctions:[{...closed,sellerConfirmedAt:'2026-10-20'}]}),/<textarea/);
    assert.match(render({pendingTrades:[{...closed,ownTradeReport:'B-1234'}],pendingTotal:1}),/How was your experience trading with this player/);
    const reported=render({path:'/auction/direct',auctions:[{...closed,ownTradeReport:'B-1234',tradeReported:true}]});
    assert.match(reported,/Reported Incomplete/);
    assert.doesNotMatch(reported,/Negative Feedback Submitted/);
    assert.match(reported,/Reference: B-1234/);
    assert.doesNotMatch(reported,/Confirm below only after you have received your side/);
    assert.doesNotMatch(reported,/Confirm Complete|Report Incomplete/);
});

test('a reported trade offers author withdrawal and a participant-only administrator query',()=>{
    const trade={...auction,finalizedAt:'2026-10-20T12:00:00Z',ownTradeReport:'B-1234',tradeReported:true};
    const html=render({path:'/auction/direct',auctions:[trade]});
    assert.match(html,/<h3 class="mb-2 font-bold text-black">Trade status:<\/h3>/);
    assert.match(html,/Reported Incomplete<\/span><span class="text-xs text-black">by seller/);
    assert.match(html,/Awaiting response<\/span><span class="text-xs text-black">by buyer/);
    assert.match(html,/You reported this trade as incomplete/);
    assert.match(html,/Everything sorted out\?/);
    assert.match(html,/Mark Trade Complete<\/button>/);
    assert.match(html,/Contact an Administrator/);
    const buyer=render({path:'/auction/direct',user:{id:'buyer'},auctions:[{...trade,sellerConfirmedAt:'2026-10-20'}]});
    assert.match(buyer,/Confirmed Complete<\/span><span class="text-xs text-black">by seller/);
    assert.match(buyer,/Reported Incomplete<\/span><span class="text-xs text-black">by buyer/);
    const withdrawn=render({path:'/auction/direct',auctions:[{...trade,ownTradeReportWithdrawn:true,tradeReported:false}]});
    assert.match(withdrawn,/Confirm Complete/);
    assert.doesNotMatch(withdrawn,/Withdraw Incomplete Report|Negative Feedback Submitted|Report Incomplete/);
    assert.match(render({path:'/auction/direct/trade-query',auctions:[trade]}),/<textarea[^>]*minLength="10"/);
    assert.doesNotMatch(render({path:'/auction/direct/trade-query',auctions:[trade],user:{id:'outsider'}}),/<textarea/);
});

test('Escrow queries reuse the existing form for sellers and finalized winners only', () => {
    for (const status of ['pending_escrow', 'active', 'settling', 'completed', 'ended_no_bids', 'cancelled']) {
        const closedSale = ['settling', 'completed'].includes(status);
        const lot = { ...auction, escrowMode: true, status, endTime: Date.now() + 86400000,
            finalizedAt: closedSale ? '2026-10-21' : null, winnerId: closedSale ? 'buyer' : null,
            hasWinner: closedSale, finalPrice: closedSale ? 500 : null, feeMeat: 0,
            currentBid: closedSale ? 500 : 0 };
        for (const user of [{ id: 'seller' }, { id: 'buyer' }, { id: 'outsider' }, { id: 'seller', isBanned: true }, null]) {
            const allowed = user && !user.isBanned && (user.id === 'seller' || (closedSale && user.id === 'buyer'));
            const query = render({ path: '/auction/direct/trade-query', auctions: [lot], user });
            assert.equal(/<textarea/.test(query), Boolean(allowed), `${status}: ${user?.id}`);
            if (allowed) {
                assert.match(query, /Escrow/);
                assert.match(query, /KMail or delivery details/);
                assert.doesNotMatch(query, /try to resolve the trade with the other party first/);
            }
            // App replaces the whole site for banned users; test other viewers here.
            if (!user?.isBanned) {
                const detail = render({ path: '/auction/direct', auctions: [lot], user });
                assert.equal(/Contact an Administrator/.test(detail), Boolean(allowed), `${status} link: ${user?.id}`);
            }
        }
    }
    const leading = { ...auction, escrowMode: true, status: 'active', endTime: Date.now() + 86400000,
        highestBidderId: 'buyer', winnerId: null, finalizedAt: null };
    assert.doesNotMatch(render({ path: '/auction/direct/trade-query', auctions: [leading], user: { id: 'buyer' } }), /<textarea/);
});

test('dismissed reports explain administrator action and the cleared mark publicly without completing the trade', () => {
    for (const role of ['seller', 'buyer']) {
        const target = role === 'seller' ? 'buyer' : 'seller';
        const lot = { ...auction, finalizedAt: '2026-10-21', [`${role}ReportExcluded`]: true,
            [`${target}ConfirmedAt`]: '2026-10-21', tradeReported: false };
        for (const user of [{ id: 'seller' }, { id: 'buyer' }, { id: 'outsider' }, null]) {
            const html = render({ path: '/auction/direct', auctions: [lot], user });
            const top = html.split('aria-label="Auction outcome"')[0];
            assert.match(top, /Awaiting settlement/);
            assert.match(top, new RegExp(`The ${role}’s incomplete report was dismissed by an administrator`));
            assert.match(html, new RegExp(`An administrator dismissed the ${role}’s incomplete report`));
            assert.match(html, new RegExp(`No incomplete mark is counted against the ${target} for this report`));
            assert.doesNotMatch(html, /Both parties confirmed|Trade completed/);
        }
        const mixed = render({ path: '/auction/direct', auctions: [{ ...lot, [`${target}ReportedIncomplete`]: true,
            [`${target}ConfirmedAt`]: null, tradeReported: true }] });
        assert.match(mixed, /Reported Incomplete/);
        assert.match(mixed, /dismissed by an administrator/);
    }
    const both = render({ path: '/auction/direct', auctions: [{ ...auction, sellerReportExcluded: true, buyerReportExcluded: true }] });
    assert.match(both, /Both incomplete reports were dismissed by an administrator/);
    assert.match(both, /No incomplete mark is counted against the buyer for this report/);
    assert.match(both, /No incomplete mark is counted against the seller for this report/);
});

test('both participants see matching response badges and the neutral withdrawal dialog', () => {
    const trade={...auction,finalizedAt:'2026-10-20',sellerReportedIncomplete:true,buyerReportedIncomplete:false,buyerConfirmedAt:'2026-10-20',tradeReported:true};
    for (const user of [{id:'seller'},{id:'buyer'}]) {
        const html=render({path:'/auction/direct',user,auctions:[{...trade,ownTradeReport:user.id==='seller'?'B-1234':null}]});
        assert.match(html,/border-red-200 bg-red-50 text-red-700">Reported Incomplete<\/span><span class="text-xs text-black">by seller/);
        assert.match(html,/border-green-200 bg-green-50 text-green-800">Confirmed Complete<\/span><span class="text-xs text-black">by buyer/);
        if (user.id==='seller') {
            assert.match(html,/aria-haspopup="dialog"/);
            assert.match(html,/<dialog[^>]*aria-labelledby="withdraw-title-direct"/);
            assert.match(html,/<strong>trade was successfully completed<\/strong>/);
            assert.doesNotMatch(html,/No positive rating will be added/);
            assert.match(html,/Everything&#x27;s good now/);
            assert.doesNotMatch(html,/<dialog[^>]*\sopen(?:\s|=|>)/);
        }
        assert.doesNotMatch(html,/negative feedback|Negative Feedback|Give thumbs down|Submit thumbs down/);
    }
    const stranger=render({path:'/auction/direct',user:{id:'other'},auctions:[trade]});
    assert.match(stranger,/>Reported Incomplete<\/span><span class="text-xs text-black">by seller \(Seller\)/);
    assert.match(stranger,/>Confirmed Complete<\/span><span class="text-xs text-black">by buyer \(Buyer\)/);
    assert.doesNotMatch(stranger,/Withdraw Incomplete Report|Trade instructions|Verified Buyer|Verified Seller|Reference: B-/);
    const awaiting=render({path:'/auction/direct',auctions:[auction]});
    assert.match(awaiting,/border-slate-200 bg-slate-50 text-slate-500">Awaiting response<\/span>/);
});

test('neutral completion never offers another confirmation or pending reminder', () => {
    const neutral={...auction,sellerResolvedAt:'2026-10-20',ownTradeReport:'B-1234',ownTradeReportWithdrawn:true};
    const html=render({path:'/auction/direct',auctions:[neutral]});
    assert.match(html,/Confirmed Complete<\/span><span class="text-xs text-black">by seller/);
    assert.match(html,/Your incomplete report was withdrawn/);
    assert.doesNotMatch(html,/no positive rating was added/i);
    assert.doesNotMatch(html,/>Confirm Complete<|Withdraw Incomplete Report|Confirm below only after/);
    const pending=render({pendingTrades:[neutral],pendingTotal:1});
    assert.match(pending,/How was your experience trading with this player/);assert.doesNotMatch(pending,/>Confirm Complete</);
});

test('a confirmed participant is not told to wait after the other party responded', () => {
    for (const [id, ownRole, otherRole] of [['buyer','buyer','seller'],['seller','seller','buyer']]) {
        const trade={...auction,finalizedAt:'2026-10-20',tradeReported:true,
            [`${ownRole}ConfirmedAt`]:'2026-10-20',[`${otherRole}ReportedIncomplete`]:true};
        const html=render({path:'/auction/direct',user:{id},auctions:[trade]});
        assert.match(html,/You confirmed this trade as complete, but the other party reported it as incomplete\./);
        assert.doesNotMatch(html,/Awaiting the other party’s response/);
        assert.match(html,/Need to clarify something\?/);
        assert.match(html,/Contact an Administrator/);
        const both=render({path:'/auction/direct',user:{id},auctions:[{...trade,tradeReported:false,
            [`${otherRole}ReportedIncomplete`]:false,[`${otherRole}ConfirmedAt`]:'2026-10-20'}]});
        assert.match(both,/Both you and the other party confirmed this trade as complete\./);
        assert.doesNotMatch(both,/Awaiting the other party’s response/);
    }
    const oldSnapshot=render({path:'/auction/direct',user:{id:'buyer'},auctions:[{...auction,buyerConfirmedAt:'2026-10-20',tradeReported:true}]});
    assert.match(oldSnapshot,/the other party reported it as incomplete/);
    assert.doesNotMatch(oldSnapshot,/Awaiting the other party’s response/);
    const stranger=render({path:'/auction/direct',user:{id:'other'},auctions:[auction]});
    assert.doesNotMatch(stranger,/Need to clarify something\?|Contact an Administrator/);
});

test('public response badges name players only for unrestricted signed-in viewers', () => {
    const trade={...auction,owner:'Named Seller',winner:'Named Buyer',publicWinner:true,
        sellerReportedIncomplete:true,buyerReportedIncomplete:false,buyerConfirmedAt:'2026-10-20',tradeReported:true,
        ownTradeReport:'B-1234',finalizedAt:'2026-10-20'};
    for (const user of [{id:'seller'},{id:'buyer'},{id:'other'},null,{id:'other',isBanned:true}]) {
        const html=render({path:'/auction/direct',user,auctions:[trade]});
        assert.match(html,/Reported Incomplete<\/span><span class="text-xs text-black">by seller/);
        assert.match(html,/Confirmed Complete<\/span><span class="text-xs text-black">by buyer/);
        assert.match(html,/At least one party reported the trade incomplete/);
        if (user && !user.isBanned) {
            assert.match(html,/by seller \(Named Seller\)<\/span>/);
            assert.match(html,/by buyer \(Named Buyer\)<\/span>/);
        } else {
            assert.match(html,/by seller<\/span>/);
            assert.match(html,/by buyer<\/span>/);
            assert.doesNotMatch(html,/Named Seller|Named Buyer/);
        }
        if (!user || user.isBanned || user.id==='other') {
            assert.doesNotMatch(html,/Your trading partner|Verified Buyer|Verified Seller|Reference: B-|Withdraw Incomplete Report|>Confirm Complete<|>Report Incomplete<|Contact an Administrator/);
        }
    }
    const masked=render({path:'/auction/direct',user:{id:'other'},auctions:[{...trade,usernamesVisible:false}]});
    assert.doesNotMatch(masked,/Named Seller|Named Buyer/);
    assert.match(masked,/Reported Incomplete/);
});

test('buyout history labels do not depend on private bidder IDs', () => {
    const purchasedAt='2026-10-20T19:56:10Z';
    const trade={...auction,publicWinner:true,instantPurchasePrice:500,instantPurchasedAt:purchasedAt,
        bids:[{id:'earlier',bidder:'Bidder 1',bidderId:null,amount:100,timestamp:Date.parse(purchasedAt)-1000},
            {id:'buyout',bidder:'Bidder 2',bidderId:null,amount:500,timestamp:Date.parse(purchasedAt)+1}]};
    for (const user of [{id:'seller'},{id:'buyer'},{id:'other'},null]) {
        const html=render({path:'/auction/direct',user,auctions:[trade]});
        assert.match(html,/500 Meat<\/p><p class="text-xs font-semibold text-green-700">Buyout<\/p><p class="text-xs text-gray-600">/);
        assert.equal((html.match(/>Buyout<\/p>/g)||[]).length,1);
        assert.doesNotMatch(html,/>Winning bid<\/p>/);
    }
    const unpurchased=render({path:'/auction/direct',auctions:[{...trade,instantPurchasedAt:null}]});
    assert.doesNotMatch(unpurchased,/>Buyout<\/p>/);
    assert.match(unpurchased,/500 Meat<\/p><p class="text-xs font-semibold text-green-700">Winning bid<\/p><p class="text-xs text-gray-600">/);
    assert.equal((unpurchased.match(/>Winning bid<\/p>/g)||[]).length,1);
    for (const status of ['active','cancelled','ended_no_bids']) {
        const unfinished=render({path:'/auction/direct',auctions:[{...trade,status,hasWinner:false,instantPurchasedAt:null,endTime:Date.now()+3600000}]});
        assert.doesNotMatch(unfinished,/>Winning bid<\/p>|>Buyout<\/p>/);
    }
});


test('completed escrow fees appear in seller settlement details rather than buyer or public views', () => {
    const settled = { ...auction, escrowMode: true, status: 'completed', feeMeat: 37 };
    assert.match(render({ path: '/auction/direct', user: { id: 'seller' }, auctions: [settled] }), /Tiered Fee \([0-9.]+%\): 37 Meat/);
    for (const user of [{ id: 'buyer' }, { id: 'outsider' }, null]) {
        const html = render({ path: '/auction/direct', user, auctions: [settled] });
        assert.doesNotMatch(html, /Tiered Fee|Seller fee:|seller commission|7.5%/);
    }
});


test('creation sends starting bids above 1M for default Escrow, explicit Escrow and Direct', async () => {
    const calls = [];
    const service = createAuctionService({ async rpc(name, args) { calls.push({ name, args }); return { data: 'created-id' }; } });
    const listing = { item: 'Test item', itemId: 1, quantity: 2500, minBidMeat: 1000001, auctionTime: 24 };
    await service.create(listing);
    await service.create({ ...listing, escrowMode: true });
    await service.create({ ...listing, escrowMode: false });
    await service.create({ ...listing, minBidMeat: 10000000000, escrowMode: true });
    assert.deepEqual(calls.map(call=>call.args.p_escrow_mode),[true,true,false,true]);
    assert.deepEqual(calls.map(call=>call.args.p_min_bid_meat),[1000001,1000001,1000001,10000000000]);
});


test('experience reminders follow either completion response and disappear after a saved vote',()=>{
 for(const path of ['/', '/auctions'])for(const userId of ['seller','buyer']){
  for(const response of [{[`${userId}ConfirmedAt`]:'2026-10-23'},{ownTradeReport:'B-1'},{[`${userId}ResolvedAt`]:'2026-10-23',ownTradeReport:'B-1',ownTradeReportWithdrawn:true}]){
   const trade={...auction,...response};
   const html=render({path,user:{id:userId},pendingTrades:[trade],pendingTotal:1});
   assert.match(html,/bg-amber-50/);assert.match(html,/How was your experience trading with this player\?/);
   assert.match(html,/Thumbs up for/);assert.match(html,/Thumbs down for/);
   assert.doesNotMatch(html,/Was this trade completed|Confirm Complete|Report Incomplete|Rate This/);
   for(const ownFeedback of [1,-1])assert.doesNotMatch(render({path,user:{id:userId},pendingTrades:[{...trade,ownFeedback}],pendingTotal:1}),/Your pending trades/);
  }
 }
 const complete={...auction,status:'completed',sellerConfirmedAt:'2026-10-23',buyerConfirmedAt:'2026-10-23'};
 assert.match(render({pendingTrades:[complete],pendingTotal:1}),/How was your experience/);
 for(const user of [null,{id:'other'},{id:'seller',isBanned:true}])assert.doesNotMatch(render({user,pendingTrades:[complete],pendingTotal:1}),/How was your experience/);
});

test('concluded auction overview shows actual bidding end time, including early buyouts',()=>{
    const endTime=Date.parse('2026-10-20T18:00:00Z');
    const closed={...auction,endTime,finalizedAt:'2026-10-21T19:00:00Z'};
    const regular=render({path:'/auction/direct',auctions:[closed]});
    assert.match(regular,/Auction ended: <time dateTime="2026-10-20T18:00:00\.000Z"/);
    const buyout=render({path:'/auction/direct',auctions:[{...closed,instantPurchasedAt:'2026-10-20T17:00:00Z'}]});
    assert.match(buyout,/Auction ended: <time dateTime="2026-10-20T17:00:00\.000Z"/);
    const live=render({path:'/auction/direct',auctions:[{...auction,status:'active',endTime:Date.now()+3600000}]});
    assert.doesNotMatch(live,/Auction ended:/);
});
