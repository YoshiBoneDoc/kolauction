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
const seller = { id: 'seller', username: 'Seller', stats: { escrow_buys:0,direct_bought_value:'20000000',escrow_bought_value:'0',seller_confirmed:1,buyer_confirmed:0,seller_incomplete:0,buyer_incomplete:0,seller_positive:0,seller_negative:0,buyer_positive:0,buyer_negative:0,escrow_sales: 2, escrow_value: '9007199254740993', escrow_units: '4', active: 0, pending: 1, unsold: 3, cancelled: 0, legacy_sales: 1, legacy_value: '300' } };

test('public seller route renders history, separate sale evidence and compact large totals without login', () => {
    const html = render({ seller, auctions: [auction], total: 25 });
    assert.match(html, /Escrow Trades/);
    assert.match(html, /9,007,199.3b Sold/);
    assert.match(html, /Trade History/);
    assert.match(html, /Direct Trades/);
    assert.match(html, /aria-label="0 thumbs up"/);
    assert.ok(html.indexOf('Direct Trades') < html.indexOf('Escrow Trades'));
    assert.doesNotMatch(html, /Listing activity|Feedback score/);
    assert.match(html, /300 Sold/);
    assert.match(html, /<summary class="cursor-pointer">How this works<\/summary>/);
    assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|=|>)/);
    assert.doesNotMatch(html, /Reported Incomplete means/);
    assert.match(html, /href="\/seller\/seller\?view=stats(?:&amp;|&)status=all"/);
    assert.match(html, /Test lot/);
    assert.match(html, /Page 1 of 2/);
    assert.match(html, /Seller auction pages/);
    assert.doesNotMatch(html, /Change password|Get verification code|Confirm my trade/);
});

test('escrow-only sellers have no direct-settlement track record', () => {
    const html = render({ seller: { ...seller, stats: { ...seller.stats, escrow_sales: 200, legacy_sales: 0, legacy_value: '0', seller_confirmed: 0 } }, auctions: [], total: 0 });
    assert.match(html, /<span class="font-medium text-gray-500">Sales: 0<\/span>/);
    assert.match(html, /0 Sold/);
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
    assert.match(html, /Listing activity/);
    assert.doesNotMatch(html, /Direct-settlement history|Trade confirmations|Feedback score|How to read these totals/);
    assert.match(html, /href="\/seller\/seller\?status=all&amp;q=hat&amp;page=2"/);
    assert.match(html, /Auction history/);
    assert.match(html, /Page 2 of 2/);
});

test('seller links on auction cards and details navigate to the public profile', () => {
    for (const path of ['/auction/lot', '/seller/seller']) {
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
    assert.match(html,/Trade History/);
    assert.match(html,/Thumbs up/);
    assert.doesNotMatch(html,/Feedback score|>Score<|>Overall</);
    assert.match(html,/aria-label="12 thumbs up"/);
    assert.match(html,/aria-label="3 thumbs down"/);
    assert.match(html,/As Seller<\/th>[\s\S]*?>8<\/td>[\s\S]*?>2<\/td>/);
    assert.match(html,/As Buyer<\/th>[\s\S]*?>4<\/td>[\s\S]*?>1<\/td>/);

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
    assert.match(html, /99b Sold/);
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
    assert.match(html, /<span>55m Sold<\/span>[\s\S]*?<span>Bought 20m<\/span>/);
    assert.match(html, /<span>1.2b Sold<\/span>[\s\S]*?<span>Bought 34m<\/span>/);
    assert.match(html, /aria-label="Escrow trades" class="space-y-2 border-t border-gray-200 pt-5"/);
    assert.doesNotMatch(html, /Violations|meat in direct trades/);
});


test('detailed profile shares the compact trade history and adds role feedback and listing activity', () => {
    const stats = { ...seller.stats, seller_confirmed: 24, buyer_confirmed: 12, seller_incomplete: 2, buyer_incomplete: 0, legacy_value: '55000000', direct_bought_value: '20000000', escrow_value: '1200000000', escrow_bought_value: '34000000' };
    for (const path of ['/seller/seller', '/seller/seller?view=stats']) {
        const html = render({ path, seller: { ...seller, stats }, auctions: [], total: 0 });
        for (const text of ['Direct Trades', 'Escrow Trades', 'Sales: 24', 'Winning bids: 12', 'Incomplete: 2']) assert.ok(html.includes(text));
        assert.match(html, /class="text-xs text-gray-500">Incomplete: 0/);
        assert.doesNotMatch(html, /Feedback score|Direct-settlement history|Trade confirmations/);
        if (path.includes('view=stats')) {
            assert.match(html, /55m Meat/);
            assert.match(html, /20m Meat/);
            assert.match(html, /1.2b Meat/);
            assert.match(html, /34m Meat/);
            assert.match(html, /Independent feedback by trading role/);
            assert.match(html, /grid items-start gap-5 md:grid-cols-2/);
            assert.match(html, /aria-label="Listing activity"/);
            assert.match(html, /4 item units sold · Bot-verified trades/);
        } else {
            assert.match(html, /55m Sold/);
            assert.match(html, /Bought 20m/);
            assert.match(html, /1.2b Sold/);
            assert.match(html, /Bought 34m/);
            assert.doesNotMatch(html, /Direct trade counts and values|Independent feedback by trading role|aria-label="Listing activity"/);
        }
    }
});


test('detailed direct history shows agreed values for every completed and incomplete role count', () => {
    const stats = { ...seller.stats, seller_confirmed: 24, buyer_confirmed: 12, seller_incomplete: 2, buyer_incomplete: 1, legacy_value: '55000000', direct_bought_value: '20000000', seller_incomplete_value: '10000000000', buyer_incomplete_value: '10000' };
    const html = render({ path: '/seller/seller?view=stats', seller: { ...seller, stats }, auctions: [], total: 0 });
    const values = html.split('aria-label="Direct trade counts and values"')[1].split('Meat values use the agreed price')[0];
    assert.match(values, /Sales: 24[\s\S]*?title="55,000,000 Meat">55m Meat/);
    assert.match(values, /Incomplete: 2[\s\S]*?title="10,000,000,000 Meat">10b Meat/);
    assert.match(values, /Winning bids: 12[\s\S]*?title="20,000,000 Meat">20m Meat/);
    assert.match(values, /Incomplete: 1[\s\S]*?title="10,000 Meat">10k Meat/);
    const compact = render({ seller: { ...seller, stats }, auctions: [], total: 0 });
    assert.doesNotMatch(compact, /Direct trade counts and values|10b Meat|10k Meat/);
    const huge = render({ path: '/seller/seller?view=stats', seller: { ...seller, stats: { ...stats, seller_incomplete_value: '9007199254740993' } }, auctions: [], total: 0 });
    assert.match(huge, /title="9,007,199,254,740,993 Meat"/);
});


test('escrow shows completed sales and winning bids in both views with values under detailed counts', () => {
    const stats = { ...seller.stats, escrow_sales: 2, escrow_buys: 3, escrow_value: '1200000000', escrow_bought_value: '34000000' };
    for (const path of ['/seller/seller', '/seller/seller?view=stats']) {
        const html = render({ path, seller: { ...seller, stats }, auctions: [], total: 0 });
        const escrow = html.split('aria-label="Escrow trades"')[1].split('</section>')[0];
        assert.match(escrow, /Sales: 2/);
        assert.match(escrow, /Winning bids: 3/);
        assert.doesNotMatch(escrow, /completed sales|Incomplete:/);
        if (path.includes('view=stats')) {
            assert.match(escrow, /Sales: 2<\/p><span[^>]*title="1,200,000,000 Meat">1.2b Meat/);
            assert.match(escrow, /Winning bids: 3<\/p><span[^>]*title="34,000,000 Meat">34m Meat/);
            assert.doesNotMatch(escrow, /Meat Totals/);
            assert.match(html, /title="Cancelled before receiving a valid bid"[^>]*>Canceled \(before bids\)/);
        } else {
            assert.match(escrow, /Meat Totals/);
            assert.match(escrow, /1.2b Sold/);
            assert.match(escrow, /Bought 34m/);
        }
    }
});
