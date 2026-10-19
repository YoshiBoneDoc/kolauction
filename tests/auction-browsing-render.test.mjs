import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as router from 'react-router-dom';
import { fileURLToPath } from 'node:url';

const { outputFiles } = buildSync({
    stdin: {
        contents: `
            import React from 'react';
            import { renderToStaticMarkup } from 'react-dom/server';
            import { StaticRouter } from 'react-router-dom';
            import App from './src/App.jsx';
            import { AuctionsContext } from './src/context/AuctionsContext.jsx';
            import { UserContext } from './src/context/UserContext.jsx';
            export function render(path, auctions, user = null) {
                return renderToStaticMarkup(
                    <StaticRouter location={path}>
                        <UserContext.Provider value={{currentUser: user}}>
                            <AuctionsContext.Provider value={{auctions, isLoading: false, error: ''}}><App /></AuctionsContext.Provider>
                        </UserContext.Provider>
                    </StaticRouter>
                );
            }
        `,
        resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx',
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic', loader: { '.gif': 'dataurl' },
});
const compiled = { exports: {} };
const requireModule = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)((name) => name === 'react-router-dom' ? router : requireModule(name), compiled, compiled.exports);
const { render } = compiled.exports;
const base = { sellerId: 'seller', owner: 'Seller', quantity: 1, minBidMeat: 100, currentBid: 0, bids: [], createdAt: Date.now(), endTime: Date.now() + 3600000, status: 'active' };
const auctions = [
    { ...base, id: 'active', item: 'Active accessory' },
    { ...base, id: 'complete', item: 'Completed accessory', status: 'completed', finalPrice: 200, winnerId: 'buyer', winner: 'Buyer' },
    { ...base, id: 'pending', item: 'Pending accessory', status: 'awaiting_trade' },
    { ...base, id: 'expired', item: 'Expired accessory', endTime: Date.now() - 1000, bids: Array(10).fill({bidder: 'Buyer', amount: 200, timestamp: Date.now() - 10000}) },
];

test('browse route applies URL search and completed filter together to real auction cards', () => {
    const html = render('/auctions?q=ACCESSORY&status=completed&sort=price-desc', auctions);
    assert.match(html, /Completed accessory/);
    assert.match(html, /1 auction found/);
    for (const name of ['Active accessory', 'Pending accessory', 'Expired accessory']) assert.doesNotMatch(html, new RegExp(name));
    assert.doesNotMatch(html, /Place Bid/);
    assert.match(html, /Final price/);
    assert.match(html, /View outcome and history/);
});

test('homepage highlights only open listings even when expired auctions have more bids', () => {
    const html = render('/', auctions);
    assert.match(html, /Active accessory/);
    for (const name of ['Completed accessory', 'Pending accessory', 'Expired accessory']) assert.doesNotMatch(html, new RegExp(name));
    assert.match(render('/', auctions.slice(1)), /No active auctions right now/);
});

test('direct detail routes expose bid fields only to eligible signed-in bidders', () => {
    assert.match(render('/auction/active', auctions), /Log in to bid/);
    const eligible = render('/auction/active', auctions, {id: 'buyer'});
    assert.match(eligible, /Your bid \(Meat\)/);
    assert.match(eligible, /inputMode="numeric"/);
    assert.doesNotMatch(render('/auction/active', auctions, {id: 'seller'}), /Your bid \(Meat\)/);
    assert.doesNotMatch(render('/auction/expired', auctions, {id: 'buyer'}), /Your bid \(Meat\)/);
});

test('instant purchase controls appear for eligible buyers including the highest bidder, but never the seller or expired listings', () => {
    const listing = { ...auctions[0], instantPurchasePrice: 1000, highestBidderId: 'buyer' };
    const buyer = render('/auction/active', [listing], {id: 'buyer'});
    assert.match(buyer, /Purchase for 1,000 Meat/);
    assert.match(buyer, /You are the highest bidder/);
    const seller = render('/auction/active', [listing], {id: 'seller'});
    assert.doesNotMatch(seller, /<button[^>]*>Purchase for/);
    assert.match(seller, /Your optional instant purchase offer/);
    assert.match(render('/auction/active', [listing]), /Log in to purchase/);
    assert.doesNotMatch(render('/auction/active', [{ ...listing, endTime: 1 }], {id: 'buyer'}), /Purchase for 1,000 Meat/);
    assert.doesNotMatch(render('/auction/active', auctions, {id: 'buyer'}), /Instant Purchase Price/);
});

test('listing form labels instant purchase optional and homepage shows its amount', () => {
    assert.match(render('/auction-item', auctions, {id: 'seller'}), /Instant Purchase Price \(Meat, optional\)/);
    assert.match(render('/', [{ ...auctions[0], instantPurchasePrice: 1000 }]), /Instant purchase: 1,000 Meat/);
});

test('empty item search renders a bounded dropdown rather than the entire catalog', () => {
    const html = render('/auction-item', auctions, {id: 'seller'});
    const picker = html.match(/<select id="item"[\s\S]*?<\/select>/)?.[0];
    assert.ok(picker);
    assert.equal((picker.match(/<option\b/g) || []).length, 101);
    assert.match(html, /Showing the first 100 of/);
    assert.match(html, /Keep typing to narrow the list/);
});

test('instant purchase outcome retains pending settlement and hides further purchase controls', () => {
    const listing = { ...auctions[0], status: 'awaiting_trade', instantPurchasePrice: 1000, instantPurchasedAt: '2026-10-19T12:00:00Z', finalPrice: 1000, winnerId: 'buyer', winner: 'Buyer' };
    const html = render('/auction/active', [listing], {id: 'buyer'});
    assert.match(html, /Instant purchase accepted for 1,000 Meat/);
    assert.match(html, /Awaiting trade/);
    assert.doesNotMatch(html, /Trade completed/);
    assert.doesNotMatch(html, /Purchase for 1,000 Meat/);
});

test('new escrow auctions provide funded KMail commands rather than unfunded website purchase/bid controls', () => {
    const listing = { ...auctions[0], auctionNumber: '1001', escrowMode: true, itemId: 1, instantPurchasePrice: 1000 };
    const html = render('/auction/active', [listing], {id:'buyer'});
    assert.match(html, /BID 1001/);
    assert.match(html, /BUY 1001/);
    assert.doesNotMatch(html, /(?:BID|BUY) active/);
    assert.match(html, /Auction #1001/);
    assert.match(html, /kHub \(#3888760\)/);
    assert.doesNotMatch(html, /<button[^>]*>Purchase for/);
    assert.doesNotMatch(html, /Your bid \(Meat\)/);
});

test('pending item deposits display seller deposit instructions without internal item IDs', () => {
    const listing = { ...auctions[0], auctionNumber:'1001', escrowMode:true, status:'pending_escrow', itemId:1, auctionTime:24, startOnDeposit:true };
    const html = render('/auction/active', [listing], {id:'seller'});
    assert.match(html,/LIST 1001/);
    assert.doesNotMatch(html,/item #\d+/);
    assert.match(html,/24-hour timer starts/);
    assert.doesNotMatch(html,/Your bid \(Meat\)/);
});

test('escrow settlement has no manual confirmation control and profile separates pending deposits', () => {
    const listing = { ...auctions[0], escrowMode:true, status:'settling', itemId:1, winnerId:'buyer', winner:'Buyer', finalPrice:1000 };
    const html=render('/auction/active',[listing],{id:'buyer'});
    assert.match(html,/Sending escrow deliveries/);
    assert.doesNotMatch(html,/Confirm my trade is complete/);
    const profile=render('/profile',[{...listing,status:'pending_escrow'}],{id:'seller'});
    assert.match(profile,/Awaiting item deposit/);
    assert.match(profile,/Get verification code/);
});
