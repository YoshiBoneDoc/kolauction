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
const auction = { id: 'lot', sellerId: 'seller', owner: 'Seller', item: 'Test lot', quantity: 2,
    minBidMeat: 100, currentBid: 300, escrowMode: true, feeMeat: 22, feeBps: 750,
    status: 'completed', hasWinner: true, winnerId: null, highestBidderId: null,
    winner: 'Bidder 1', finalPrice: 300, endTime: 1, bids: [] };
const seller = { id: 'seller', username: 'Seller', stats: { seller_positive:0,seller_negative:0,buyer_positive:0,buyer_negative:0,escrow_sales: 2, escrow_value: '9007199254740993', escrow_units: '4', active: 0, pending: 1, unsold: 3, cancelled: 0, legacy_sales: 1, legacy_value: '300' } };

test('public seller route renders history, separate sale evidence and compact large totals without login', () => {
    const html = render({ seller, auctions: [auction], total: 25 });
    assert.match(html, /Escrow sales/);
    assert.match(html, /9,007,199.3b Meat/);
    assert.match(html, /Direct-settlement history/);
    assert.match(html, /No ratings yet/);
    assert.ok(html.indexOf('Direct-settlement history') < html.indexOf('Escrow sales'));
    assert.doesNotMatch(html, /Thumbs down counts immediately/);
    assert.match(html, /href="\/seller\/seller\?view=stats(?:&amp;|&)status=all"/);
    assert.match(html, /Test lot/);
    assert.match(html, /Page 1 of 2/);
    assert.match(html, /Seller auction pages/);
    assert.doesNotMatch(html, /Change password|Get verification code|Confirm my trade/);
});

test('escrow-only sellers have no direct-settlement track record', () => {
    const html = render({ seller: { ...seller, stats: { ...seller.stats, escrow_sales: 200, legacy_sales: 0, legacy_value: '0' } }, auctions: [], total: 0 });
    assert.match(html, /No completed direct sales yet/);
    assert.match(html, /200 completed sales/);
    assert.match(html, /No ratings yet/);
    assert.doesNotMatch(html, /Escrow sales do not establish a direct-settlement track record/);
    assert.doesNotMatch(html, /100%|positive ratings: 200/i);
});

test('detailed seller view explains metrics while preserving listing filters', () => {
    const html = render({ path: '/seller/seller?view=stats&status=all&q=hat&page=2', seller, auctions: [], total: 25 });
    assert.match(html, /Thumbs down counts immediately/);
    assert.match(html, /Escrow sales do not establish a direct-settlement track record/);
    assert.match(html, /How to read these totals/);
    assert.match(html, /A completion rate is not available yet/);
    assert.match(html, /href="\/seller\/seller\?status=all&amp;q=hat&amp;page=2"/);
    assert.match(html, /Auction history/);
    assert.match(html, /Page 2 of 2/);
});

test('seller links on auction cards and details navigate to the public profile', () => {
    for (const path of ['/auction/lot', '/auctions?status=completed', '/seller/seller']) {
        const html = render({ path, user:{id:'viewer'}, seller, auctions: [auction], total: 1 });
        assert.match(html, /href="\/seller\/seller"[^>]*>Seller<\/a>/);
        assert.match(html, /Winner:|Winning bidder:/);
        assert.match(html, /Bidder 1/);
    }
});

test('profile has distinct loading, unavailable, absent and empty-filter states', () => {
    assert.match(render({ isLoading: true }), /Loading seller/);
    assert.match(render({ error: 'database failure' }), /This seller could not be loaded/);
    assert.doesNotMatch(render({ error: 'database failure' }), /Seller not found|database failure/);
    assert.match(render({ seller: null }), /Seller not found/);
    assert.match(render({ seller, auctions: [], total: 0 }), /No auctions match these filters/);
});

test('public outcomes retain winning prices without an exposed winner ID or private controls', () => {
    const direct = { ...auction, escrowMode: false, status: 'awaiting_trade' };
    const html = render({ path: '/auction/lot', auctions: [direct] });
    assert.match(html, /Winning bidder:.*Winner/);
    assert.match(html, /300 Meat/);
    assert.doesNotMatch(html, /Confirm my trade is complete|Your trading partner/);
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
    assert.equal(calls[1][1].p_view, 'seller');
    assert.equal(calls[1][1].p_id, 'seller');
    assert.equal(calls[1][1].p_page, 2);
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
    assert.match(html,/Seller rating · direct settlement/);
    assert.match(html,/Buyer rating · direct settlement/);
    assert.match(html,/Reputation: \+9/);
    assert.match(html,/As Seller<\/th>[\s\S]*?>8<\/td>[\s\S]*?>2<\/td>[\s\S]*?>\+6<\/td>/);
    assert.match(html,/As Buyer<\/th>[\s\S]*?>4<\/td>[\s\S]*?>1<\/td>[\s\S]*?>\+3<\/td>/);
    assert.match(html,/Overall<\/th>[\s\S]*?>12<\/td>[\s\S]*?>3<\/td>[\s\S]*?>\+9<\/td>/);
    const winner=render({path:'/auction/lot',user:{id:'viewer'},auctions:[{...auction,publicWinner:true,winnerId:'buyer',winner:'Public Buyer'}]});
    assert.match(winner,/href="\/seller\/buyer\?view=stats"[^>]*>Public Buyer/);
    assert.doesNotMatch(winner,/Your trading partner|Confirm my trade is complete/);
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
