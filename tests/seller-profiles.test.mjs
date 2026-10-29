import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as router from 'react-router-dom';
import { auctionReadRequest } from '../src/lib/auctionRefresh.js';
import { createAuctionService } from '../src/lib/auctions.js';
import { getAuctionResult } from '../src/lib/auctionLifecycle.js';

const { outputFiles } = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { StaticRouter } from 'react-router-dom';
    import App from './src/App.jsx';
    import { UserContext } from './src/context/UserContext.jsx';
    import { AuctionsContext } from './src/context/AuctionsContext.jsx';
    export function render({path='/seller/seller',user=null,...context}) {
        return renderToStaticMarkup(<StaticRouter location={path}><UserContext.Provider value={{currentUser:user}}>
            <AuctionsContext.Provider value={context}><App /></AuctionsContext.Provider>
        </UserContext.Provider></StaticRouter>);
    }`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env': '{}' }, loader: { '.gif': 'dataurl' },
});
const compiled = { exports: {} };
const requireModule = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react-router-dom' ? router : requireModule(name), compiled, compiled.exports);
const { render } = compiled.exports;

// Scope assertions to a card or feedback group, so another card's value cannot
// accidentally satisfy a regression check. Handle nested elements explicitly.
function groupWithHeading(html, heading, tag = 'section') {
    const headingAt = html.indexOf(`>${heading}</h`);
    assert.ok(headingAt >= 0, `Missing heading: ${heading}`);
    const start = html.lastIndexOf(`<${tag} `, headingAt);
    assert.ok(start >= 0, `Missing ${tag} for ${heading}`);
    const elements = new RegExp(`</?${tag}\\b[^>]*>`, 'g');
    elements.lastIndex = start;
    let depth = 0;
    for (let match; (match = elements.exec(html));) {
        depth += match[0].startsWith('</') ? -1 : 1;
        if (depth === 0) return html.slice(start, elements.lastIndex);
    }
    assert.fail(`Unclosed ${tag} for ${heading}`);
}
function expectStat(card, label, value) {
    const rows = [...card.matchAll(/<dt>([^<]+)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)];
    assert.equal(rows.find(([, name]) => name === label)?.[2], value, label);
}

const auction = { id: 'lot', sellerId: 'seller', owner: 'Seller', item: 'Test lot', quantity: 2,
    minBidMeat: 100, currentBid: 300, escrowMode: true, feeMeat: 22, feeBps: 750,
    status: 'completed', hasWinner: true, winnerId: null, highestBidderId: null,
    winner: 'Bidder 1', finalPrice: 300, endTime: 1, bids: [] };
const seller = { id: 'seller', username: 'Seller', stats: { escrow_buys:0,direct_bought_value:'20000000',escrow_bought_value:'0',seller_confirmed:1,buyer_confirmed:0,seller_incomplete:0,buyer_incomplete:0,seller_positive:0,seller_negative:0,buyer_positive:0,buyer_negative:0,escrow_sales: 2, escrow_value: '9007199254740993', escrow_units: '4', active: 0, pending: 1, unsold: 3, cancelled: 0, legacy_sales: 1, legacy_value: '300', buy_order_sales: 2, buy_order_units: 1326, buy_order_value: '561200' } };

test('seller profile back link goes to the owner account only for the signed-in owner', () => {
    for (const path of ['/seller/seller', '/seller/seller?view=stats']) {
        const state = { path, seller, auctions: [], total: 0 };
        assert.match(render({ ...state, user: { id: 'seller' } }), /href="\/profile"[^>]*>← Back to Account Profile<\/a>/);
        assert.match(render({ ...state, user: { id: 'viewer', khubUsername: 'Seller' } }), /href="\/auctions"[^>]*>← Back to Auctions<\/a>/);
        assert.match(render(state), /href="\/auctions"[^>]*>← Back to Auctions<\/a>/);
    }
});

test('public seller route renders history, separate sale evidence and compact large totals without login', () => {
    const html = render({ seller, auctions: [auction], total: 25 });
    assert.match(html, /Escrow Trades/);
    assert.match(html, /9,007,199\.3b[\s\S]*?Sold/);
    assert.match(html, /Trade History/);
    assert.match(html, /Direct Trades/);
    assert.match(html, /aria-label="0 thumbs up"/);
    assert.ok(html.indexOf('Direct Trades') < html.indexOf('Escrow Trades'));
    assert.ok(html.indexOf('Escrow Trades') < html.indexOf('Buy Orders'));
    assert.match(html, /2[\s\S]*?orders filled ·[\s\S]*?1,326[\s\S]*?items sold/);
    assert.match(html, /561\.2k Meat[\s\S]*?earned/);
    assert.doesNotMatch(html, /Sales to Buy Orders|fulfillments ·|Meat paid to seller/);
    assert.doesNotMatch(html, /Listing activity|Feedback score/);
    assert.match(html, /300[\s\S]*?Sold/);
    assert.match(html, /<summary class="cursor-pointer">How this works<\/summary>/);
    assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|=|>)/);
    assert.doesNotMatch(html, /Reported Incomplete means/);
    assert.match(html, /href="\/seller\/seller\?view=stats"/);
    assert.match(html, /Test lot/);
    assert.match(html, /Page 1 of 2/);
    assert.match(html, /Seller auction pages/);
    assert.doesNotMatch(html, /Change password|Get verification code|Confirm my trade/);
});

test('escrow-only sellers have no direct-settlement track record', () => {
    const html = render({ seller: { ...seller, stats: { ...seller.stats, escrow_sales: 200, legacy_sales: 0, legacy_value: '0', seller_confirmed: 0 } }, auctions: [], total: 0 });
    assert.match(html, /<span class="font-medium text-gray-500">Sales: 0<\/span>/);
    assert.match(html, /0[\s\S]*?Sold/);
    assert.match(html, /Sales: 200/);
    assert.match(html, /aria-label="0 thumbs up"/);
    assert.doesNotMatch(html, /Escrow sales do not establish a direct-settlement track record/);
    assert.doesNotMatch(html, /100%|positive ratings: 200/i);
});

test('detailed seller view explains metrics while preserving listing filters', () => {
    const html = render({ path: '/seller/seller?view=stats&status=all&q=hat&page=2', seller, auctions: [], total: 25 });
    assert.match(html, /Negative feedback doesn’t necessarily mean a trade was incomplete/);
    assert.match(html, /<em>Incomplete reports may be disputed and dismissed after administrator review\.<\/em>/);
    assert.match(html, /How this works/);
    assert.match(html, /aria-label="Trade History"/);
    assert.doesNotMatch(html, /Direct-settlement history|Trade confirmations|Feedback score|How to read these totals/);
    assert.match(html, /href="\/seller\/seller\?status=all&amp;q=hat&amp;page=2"/);
    assert.doesNotMatch(html, /Auction history|Seller auctions|Search items|public-profile-auction-list|Listing activity|Page 2 of 2/);
});

test('switching public profile tabs preserves search, status and sorting, with All auctions as the default', () => {
    const auctions = render({ path: '/seller/seller?status=cancelled&sort=price-desc&q=boots&page=2', seller, auctions: [], total: 0 });
    assert.match(auctions, /href="\/seller\/seller\?status=cancelled&amp;sort=price-desc&amp;q=boots&amp;page=2&amp;view=stats"/);
    const profile = render({ path: '/seller/seller?view=stats&status=cancelled&sort=newest&q=coat&page=3', seller, auctions: [], total: 0 });
    assert.match(profile, /href="\/seller\/seller\?status=cancelled&amp;sort=newest&amp;q=coat&amp;page=3"/);
    const defaultAuctions = render({ path: '/seller/seller', seller, auctions: [], total: 0 });
    assert.match(defaultAuctions, /href="\/seller\/seller\?view=stats"/);
    assert.doesNotMatch(defaultAuctions, /href="\/seller\/seller\?view=stats&amp;status=/);
    assert.match(defaultAuctions, /<option value="all" selected="">All auctions<\/option>/);
    assert.match(defaultAuctions, /<option value="ending" selected="">Ending soon<\/option>/);
});

test('seller links on auction cards and details navigate to the public profile', () => {
    const detail = render({ path: '/auction/lot', user:{id:'viewer'}, seller, auctions: [auction], total: 1 });
    assert.match(detail, /href="\/seller\/seller"[^>]*>Seller<\/a>/);
    const profile = render({ path: '/seller/seller', user:{id:'viewer'}, seller, auctions: [auction], total: 1 });
    for (const html of [detail, profile]) {
        assert.match(html, /Winner:|Winning bidder:/);
        assert.match(html, /Bidder 1/);
    }
    assert.doesNotMatch(profile.match(/<article class="public-profile-auction-row[\s\S]*?<\/article>/)[0], />Seller<\/a>/);
});

test('public profile sell and buy cards show compact auction details and actions', () => {
    const image = 'https://images.kingdomofloathing.com/itemimages/tooth.gif';
    const sell = { ...auction, status: 'active', hasWinner: false, winnerId: null, currentBid: 0,
        image, endTime: Date.now() + 3600000, auctionNumber: 41 };
    const buy = { ...sell, id: 'buy-lot', auctionKind: 'buy', pricePerItem: 400, quantity: 10,
        purchasedQuantity: 4, reducedQuantity: 1, reservedQuantity: 2 };
    const html = render({ path: '/seller/seller?status=all', user: { id: 'viewer' }, seller,
        auctions: [sell, buy], total: 2 });

    assert.match(html, /profile-auction-kind-sell/);
    assert.match(html, /profile-auction-kind-buy/);
    assert.match(html, /#41 · Min 100 Meat/);
    assert.match(html, /No bids yet/);
    assert.match(html, /href="\/auction\/lot"/);
    assert.match(html, /class="profile-public-row-name"[^>]*href="\/auction\/lot"[^>]*>Test lot<\/a>/);
    assert.match(html, /class="profile-public-row-image"[^>]*href="\/auction\/lot"[^>]*><img/);
    assert.match(html, /<strong>400 Meat\/item<\/strong><span class="profile-public-row-label">4 \/ 9 filled/);
    assert.match(html, /4 \/ 9 filled/);
    assert.match(html, /5 remaining/);
    assert.doesNotMatch(html, /profile-public-row-view/);
    assert.match(html, /class="public-profile-auction-list"/);
    assert.equal((html.match(new RegExp(`<img[^>]*src="${image}"`, 'g')) || []).length, 2);
});

test('public profile countdown urgency follows the one-hour and one-day thresholds', () => {
    for (const [remaining, expectedClass] of [[30 * 60 * 1000, 'is-urgent'], [2 * 60 * 60 * 1000, 'is-soon'], [25 * 60 * 60 * 1000, '']]) {
        const html = render({ path: '/seller/seller', seller, total: 1, auctions: [{ ...auction,
            status: 'active', hasWinner: false, endTime: Date.now() + remaining }] });
        assert.match(html, new RegExp(`<time class="${expectedClass}"[^>]*>·`));
    }
});

test('public profile cards retain active, completed, canceled and unsuccessful outcome labels', () => {
    const outcomes = [
        ['active', 'Active'],
        ['completed', 'Trade completed'],
        ['cancelled', 'Cancelled'],
        ['expired', 'Expired'],
        ['ended_no_bids', 'Ended without bids'],
    ];
    for (const [status, label] of outcomes) {
        const html = render({ path: '/seller/seller?status=all', seller, total: 1,
            auctions: [{ ...auction, status, endTime: status === 'active' ? Date.now() + 3600000 : 1,
                hasWinner: status === 'completed', winnerId: null }] });
        assert.match(html, new RegExp(`profile-public-row-status[^>]*><strong>${label}<`));
    }
});

test('profile has distinct loading, unavailable, absent and empty-filter states', () => {
    assert.match(render({ isLoading: true }), /Loading seller/);
    assert.match(render({ error: 'database failure' }), /This seller could not be loaded/);
    // The shared layout retains the global error banner; the seller page itself
    // must still show an unavailable state rather than a missing profile.
    const unavailable = render({ error: 'database failure' }).match(/<main[\s\S]*?<\/main>/)[0];
    assert.doesNotMatch(unavailable, /Seller not found|database failure/);
    assert.match(render({ seller: null }), /Seller not found/);
    assert.match(render({ seller, auctions: [], total: 0 }), /No auctions match these filters/);
});

test('public outcomes retain winning prices without an exposed winner ID or private controls', () => {
    const direct = { ...auction, escrowMode: false, status: 'awaiting_trade' };
    const html = render({ path: '/auction/lot', auctions: [direct] });
    assert.match(html, /Winning bidder:.*Winner/);
    assert.match(html, /300 Meat/);
    assert.doesNotMatch(html, /Confirm Complete|Your trading partner/);
    assert.equal(getAuctionResult(direct).hasWinner, true);
    assert.equal(getAuctionResult(direct).winnerId, null);
});

test('a masked bidder ID cannot enable seller cancellation on a funded auction', () => {
    const html = render({ path: '/auction/lot', user: { id: 'seller' }, auctions: [{ ...auction, status: 'active', hasWinner: false, endTime: Date.now()+3600000 }] });
    assert.doesNotMatch(html, /Cancel listing/);
});

test('seller names are escaped and profile URLs encode their stable ID', () => {
    const html = render({ user:{id:'viewer'}, seller: { ...seller, username: '<script>bad</script>' }, auctions: [], total: 0 });
    assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});

test('seller reads retain filters and pagination through the scoped auction reader', async () => {
    const request = auctionReadRequest('/seller/seller', '?q=hat&status=ended&sort=newest&page=2');
    assert.deepEqual(request, { view: 'seller', id: 'seller', search: 'hat', status: 'ended', sort: 'newest', page: 2 });
    const calls = [];
    const service = createAuctionService({ async rpc(name, params) {
        calls.push([name, params]);
        return { data: { privacy_version: 1, rows: [], bids: [], total: 0, seller }, error: null };
    } });
    assert.deepEqual((await service.load(request)).seller, seller);
    assert.equal(calls[0][1].p_view, 'seller');
    assert.equal(calls[0][1].p_id, 'seller');
    assert.equal(calls[0][1].p_page, 2);
});

test('old unprotected RPC responses are rejected until the privacy migration is applied', async () => {
    const service = createAuctionService({ async rpc() { return { data: { rows: [], bids: [], total: 0 }, error: null }; } });
    await assert.rejects(service.load(), /privacy update/);
});

test('seller search controls stay mounted while results load or fail', () => {
    for (const state of [{isLoading:true},{error:'network failure'}]) {
        const html=render({ path:'/seller/seller?q=vil',seller,auctions:[],total:0,...state });
        assert.match(html, /type="search"[^>]*value="vil"/);
        assert.match(html, /Seller profile views/);
        assert.doesNotMatch(html, /Loading seller|No auctions match|0 auctions found|Seller not found/);
    }
    assert.match(render({seller,auctions:[],total:0,isLoading:true}),/Loading auctions/);
    assert.match(render({seller,auctions:[],total:0,error:'network failure'}),/These auctions could not be loaded/);
});

test('profiles show role-specific direct feedback and publicly closed winners link to their profile',()=>{
    const feedback={...seller,stats:{...seller.stats,seller_positive:8,seller_negative:2,buyer_positive:4,buyer_negative:1}};
    const html=render({seller:feedback,auctions:[],total:0,path:'/seller/seller?view=stats'});
    assert.match(html,/Trade History/);
    assert.match(html,/Trade Feedback/);
    assert.doesNotMatch(html,/Feedback score|>Score<|<table/);
    for (const [role, positive, negative] of [['Overall', 12, 3], ['As Seller', 8, 2], ['As Buyer', 4, 1]]) {
        const group = groupWithHeading(html, role, 'div');
        assert.match(group, new RegExp(`aria-label="${positive} positive feedback"`));
        assert.match(group, new RegExp(`aria-label="${negative} negative feedback"`));
        assert.equal((group.match(/<svg/g) || []).length, 2, `${role} retains both thumb icons`);
    }

    const winner=render({path:'/auction/lot',user:{id:'viewer'},auctions:[{...auction,publicWinner:true,winnerId:'buyer',winner:'Public Buyer'}]});
    assert.match(winner,/href="\/seller\/buyer"[^>]*>Public Buyer/);
    assert.match(winner,/href="\/seller\/seller"[^>]*>Seller/);
    assert.doesNotMatch(winner,/Your trading partner|Confirm Complete/);
});

test('signed-out and banned viewers cannot see names even from a stale named snapshot',()=>{
    const named={...auction,owner:'Private Seller Name',winner:'Private Winner Name',publicWinner:true,winnerId:'buyer'};
    for(const user of [null,{id:'viewer',isBanned:true}]){
        const detail=render({path:'/auction/lot',user,auctions:[named]});
        assert.doesNotMatch(detail,/Private Seller Name|Private Winner Name/);
        const profile=render({user,seller:{...seller,username:'Private Seller Name'},auctions:[named],total:1});
        assert.doesNotMatch(profile,/Private Seller Name|Private Winner Name/);
        assert.match(profile,/Player profile/);
    }
    const masked=render({path:'/auction/lot',user:{id:'viewer'},auctions:[{...named,usernamesVisible:false}]});
    assert.doesNotMatch(masked,/Private Seller Name|Private Winner Name/);
});


test('compact history groups each role on one line and keeps independent feedback as thumb icons', () => {
    const stats = { ...seller.stats, seller_confirmed: 24, seller_incomplete: 2, buyer_confirmed: 12, buyer_incomplete: 3, seller_positive: 8, buyer_positive: 4, seller_negative: 1, buyer_negative: 2, legacy_value: '99000000000' };
    const html = render({ seller: { ...seller, stats }, auctions: [], total: 0 });
    assert.match(html, /<p[^>]*whitespace-nowrap[^>]*><span class="font-medium text-green-700">Sales: 24<\/span>[\s\S]*?<span class="text-xs text-red-700">Incomplete: 2<\/span><\/p>/);
    assert.match(html, /<p[^>]*whitespace-nowrap[^>]*><span class="font-medium text-green-700">Winning bids: 12<\/span>[\s\S]*?<span class="text-xs text-red-700">Incomplete: 3<\/span><\/p>/);
    assert.match(html, /99b[\s\S]*?Sold/);
    assert.match(html, /aria-label="12 thumbs up"[^>]*>12<svg/);
    assert.match(html, /aria-label="3 thumbs down"[^>]*><svg[\s\S]*?<\/svg>3<\/span>/);
    assert.doesNotMatch(html, /Listing activity|How to read these totals/);
});


test('zero trade counts stay gray and paired rows share centered equal columns', () => {
    const stats = { ...seller.stats, seller_confirmed: 0, buyer_confirmed: 0, seller_incomplete: 0, buyer_incomplete: 0, escrow_sales: 0 };
    const html = render({ seller: { ...seller, stats }, auctions: [], total: 0 });
    for (const label of ['Sales: 0', 'Winning bids: 0']) {
        assert.match(html, new RegExp(`<span class="font-medium text-gray-500">${label}</span>`));
    }
    assert.match(html, /class="text-sm font-medium text-gray-500">Sales: 0/);
    assert.match(html, /class="text-xs text-gray-500">Incomplete: 0/);
    assert.equal((html.match(/grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/g) || []).length, 2);
});


test('direct and escrow Meat totals show separate sold and bought values with divider above escrow', () => {
    const stats = { ...seller.stats, legacy_value: '55000000', direct_bought_value: '20000000', escrow_value: '1200000000', escrow_bought_value: '34000000' };
    const html = render({ seller: { ...seller, stats }, auctions: [], total: 0 });
    assert.equal((html.match(/>Meat Totals<\/h4>/g) || []).length, 2);
    assert.match(html, /55m[\s\S]*?Sold[\s\S]*?Bought[\s\S]*?20m/);
    assert.match(html, /1\.2b[\s\S]*?Sold[\s\S]*?Bought[\s\S]*?34m/);
    assert.match(html, /aria-label="Escrow trades" class="space-y-2 border-t border-gray-200 pt-5"/);
    assert.doesNotMatch(html, /Violations|meat in direct trades/);
});


test('Seller Profile uses compact statistic cards and separate feedback without auction content', () => {
    const stats = { ...seller.stats, seller_confirmed: 24, buyer_confirmed: 12, seller_incomplete: 2, buyer_incomplete: 0, legacy_value: '55000000', direct_bought_value: '20000000', escrow_value: '1200000000', escrow_bought_value: '34000000' };
    const html = render({ path: '/seller/seller?view=stats', seller: { ...seller, stats }, auctions: [auction], total: 1 });
    const direct = groupWithHeading(html, 'Direct Trades');
    const escrow = groupWithHeading(html, 'Escrow Trades');
    expectStat(direct, 'Sales', '24');
    expectStat(direct, 'Winning bids', '12');
    expectStat(direct, 'Meat sold', '55m Meat');
    expectStat(direct, 'Meat bought', '20m Meat');
    expectStat(escrow, 'Meat sold', '1.2b Meat');
    expectStat(escrow, 'Meat bought', '34m Meat');
    expectStat(escrow, 'Items sold', '4');
    expectStat(groupWithHeading(html, 'Buy Orders Fulfilled'), 'Orders fulfilled', '2');
    expectStat(groupWithHeading(html, 'Buy Orders Fulfilled'), 'Items sold', '1,326');
    assert.doesNotMatch(direct, /Completion rate|Trade Feedback|thumbs|positive feedback/);
    assert.match(html, /public-profile-dashboard-cards/);
    assert.match(html, /Trade Feedback/);
    assert.match(html, /How this works/);
    assert.doesNotMatch(html, /public-profile-auction-list|Search items|Test lot|Feedback score|Direct-settlement history/);

    const sidebar = render({ seller: { ...seller, stats }, auctions: [], total: 0 });
    assert.match(sidebar, /Sales: 24/);
    assert.match(sidebar, /Winning bids: 12/);
    assert.match(sidebar, /Incomplete: 2/);
    assert.match(sidebar, /55m[\s\S]*?Sold[\s\S]*?Bought[\s\S]*?20m/);
    assert.doesNotMatch(sidebar, /public-profile-dashboard-cards|public-profile-feedback-grid/);
});

test('detailed direct statistics keep completed totals separate from incomplete reports and feedback', () => {
    const stats = { ...seller.stats, seller_confirmed: 24, buyer_confirmed: 12, seller_incomplete: 2, buyer_incomplete: 1, legacy_value: '55000000', direct_bought_value: '20000000', seller_incomplete_value: '10000000000', buyer_incomplete_value: '10000' };
    const html = render({ path: '/seller/seller?view=stats', seller: { ...seller, stats }, auctions: [], total: 0 });
    const direct = groupWithHeading(html, 'Direct Trades');
    expectStat(direct, 'Sales', '24');
    expectStat(direct, 'Winning bids', '12');
    expectStat(direct, 'Meat sold', '55m Meat');
    expectStat(direct, 'Meat bought', '20m Meat');
    assert.doesNotMatch(direct, /10b Meat|10k Meat|Completion rate|positive feedback/);
    const compact = render({ seller: { ...seller, stats }, auctions: [], total: 0 });
    assert.match(compact, /Incomplete: 2/);
    assert.match(compact, /Incomplete: 1/);
    assert.doesNotMatch(compact, /10b Meat|10k Meat/);
    const huge = render({ path: '/seller/seller?view=stats', seller: { ...seller, stats: { ...stats, seller_confirmed: '9007199254740993', legacy_value: '9007199254740993' } }, auctions: [], total: 0 });
    const hugeDirect = groupWithHeading(huge, 'Direct Trades');
    expectStat(hugeDirect, 'Sales', '9,007,199,254,740,993');
    expectStat(hugeDirect, 'Meat sold', '9,007,199.3b Meat');
});

test('escrow displays completed sales, winning bids and their own Meat totals in both views', () => {
    const stats = { ...seller.stats, escrow_sales: 2, escrow_buys: 3, escrow_value: '1200000000', escrow_bought_value: '34000000' };
    const html = render({ path: '/seller/seller?view=stats', seller: { ...seller, stats }, auctions: [], total: 0 });
    const escrow = groupWithHeading(html, 'Escrow Trades');
    expectStat(escrow, 'Sales', '2');
    expectStat(escrow, 'Winning bids', '3');
    expectStat(escrow, 'Meat sold', '1.2b Meat');
    expectStat(escrow, 'Meat bought', '34m Meat');
    assert.doesNotMatch(escrow, /Incomplete|Meat Totals|Completion rate/);
    const zero = render({ path: '/seller/seller?view=stats', seller: { ...seller, stats: { ...stats, escrow_buys: 0, escrow_bought_value: '0' } }, auctions: [], total: 0 });
    expectStat(groupWithHeading(zero, 'Escrow Trades'), 'Winning bids', '0');
    expectStat(groupWithHeading(zero, 'Escrow Trades'), 'Meat bought', '0 Meat');

    const compact = render({ seller: { ...seller, stats }, auctions: [], total: 0 });
    const sidebarEscrow = groupWithHeading(compact, 'Escrow Trades');
    assert.match(sidebarEscrow, /Sales: 2/);
    assert.match(sidebarEscrow, /Winning bids: 3/);
    assert.match(sidebarEscrow, /Meat Totals/);
    assert.match(sidebarEscrow, /1\.2b[\s\S]*?Sold[\s\S]*?Bought[\s\S]*?34m/);
    assert.doesNotMatch(sidebarEscrow, /Incomplete:/);
});


test('Buy item images appear on browse, home and auction view, not the Seller Profile tab',()=>{
 const buy={...auction,auctionKind:'buy',pricePerItem:100,purchasedQuantity:2,remainingQuantity:0,availableQuantity:0,reservedQuantity:0,reducedQuantity:0,fulfilledByMe:true,mySaleMeat:200,image:'https://images.kingdomofloathing.com/itemimages/tooth.gif',completedAt:'2026-10-23T12:00:00Z'};
 for(const path of ['/', '/auctions?status=all', '/seller/seller']){
  const html=render({path,user:{id:'seller'},seller,auctions:[buy],total:1});
  assert.match(html,/<img[^>]*src="https:\/\/images.kingdomofloathing.com\/itemimages\/tooth.gif"[^>]*loading="lazy"/);
  assert.match(html,/Test lot/);
 }
 const profile=render({path:'/seller/seller?view=stats',user:{id:'seller'},seller,auctions:[buy],total:1});
 assert.match(profile,/aria-label="Trade History"/);
 assert.doesNotMatch(profile,/itemimages\/tooth.gif|Test lot|public-profile-auction-list|Seller auctions/);
});


test('Seller Profile separates funded Buy orders created from orders fulfilled without changing sidebar', () => {
    const data = {...seller, stats: {...seller.stats, buy_orders_created: '3', buy_orders_bought_units: '77', buy_orders_spent: '123000'}};
    const html = render({path:'/seller/seller?view=stats', seller:data, auctions:[], total:0});
    assert.match(html, /Buy Orders Created/);
    assert.match(html, /Orders created/);
    assert.match(html, /Items bought/);
    assert.match(html, /123k Meat/);
    assert.match(html, /Buy Orders Fulfilled/);
    assert.match(html, /Orders fulfilled/);
    assert.match(html, /561.2k Meat/);
    const sidebar = render({path:'/seller/seller', seller:data, auctions:[], total:0});
    assert.doesNotMatch(sidebar, /Buy Orders Created|Buy Orders Fulfilled/);
});
