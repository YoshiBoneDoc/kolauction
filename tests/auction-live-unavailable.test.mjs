import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const output = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import AuctionLiveUnavailable from './src/components/AuctionLiveUnavailable.jsx';
    export function render(auction) { return renderToStaticMarkup(<MemoryRouter><AuctionLiveUnavailable auction={auction} /></MemoryRouter>); }
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, format: 'cjs', write: false,
    jsx: 'automatic', external: ['react', 'react-dom/server', 'react-router-dom'] }).outputFiles[0].text;
const module = { exports: {} };
new Function('require', 'module', 'exports', output)(require, module, module.exports);

test('catalogue-only UI displays the item and hides all stale financial and timing fields', () => {
    const html = module.exports.render({ id: 'auction', item: 'Catalogue fixture', currentBid: 987654321,
        instantPurchasePrice: 87654321, endTime: 12345678, winner: 'PRIVATE WINNER', availableQuantity: 55 });
    assert.match(html, /Catalogue fixture/);
    assert.match(html, /temporarily unavailable/);
    assert.doesNotMatch(html, /987654321|87654321|12345678|PRIVATE WINNER|Place Bid|Buyout|<button|<form/);
});

const guarded = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter, Routes, Route } from 'react-router-dom';
    import { UserContext } from './src/context/UserContext.jsx';
    import { AuctionsContext } from './src/context/AuctionsContext.jsx';
    import AuctionCard from './src/components/AuctionCard.jsx';
    import CompactAuctionCard from './src/components/CompactAuctionCard.jsx';
    import HomeAuctionCard from './src/components/HomeAuctionCard.jsx';
    import PublicProfileAuctionCard from './src/components/PublicProfileAuctionCard.jsx';
    import BuyAuctionCard from './src/components/BuyAuctionCard.jsx';
    import GiveawayCard from './src/components/GiveawayCard.jsx';
    import AuctionDetails from './src/pages/AuctionDetails.jsx';
    export function renderAll(auction) {
        return [AuctionCard,CompactAuctionCard,HomeAuctionCard,PublicProfileAuctionCard,BuyAuctionCard,GiveawayCard,AuctionDetails].map(Component =>
            renderToStaticMarkup(<MemoryRouter initialEntries={['/auction/fixture']}>
                <UserContext.Provider value={{currentUser:{id:'viewer'}}}>
                <AuctionsContext.Provider value={{auctions:[auction],isLoading:false,error:''}}>
                <Routes><Route path='/auction/:id' element={<Component auction={auction} now={Date.now()} />} /></Routes>
                </AuctionsContext.Provider></UserContext.Provider>
            </MemoryRouter>));
    }
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, format: 'cjs', write: false,
    jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'import.meta.env': '{}' },
    external: ['react', 'react-dom/server', 'react-router-dom'] }).outputFiles[0].text;
const guardedModule = { exports: {} };
new Function('require', 'module', 'exports', guarded)(require, guardedModule, guardedModule.exports);
test('all auction card layouts and detail pages guard unavailable live state before displaying actions or prices', () => {
    const outputs = guardedModule.exports.renderAll({ id: 'fixture', item: 'Catalogue fixture', liveUnavailable: true,
        currentBid: 987654321, minBidMeat: 987654320, instantPurchasePrice: 87654321, bids: [], image: null,
        endTime: Date.now() + 60000, status: 'active', sellerId: 'seller', auctionKind: 'sell' });
    assert.equal(outputs.length, 7);
    for (const html of outputs) {
        assert.match(html, /temporarily unavailable/);
        assert.doesNotMatch(html, /987654321|87654321|Place Bid|<button|<form|Ends in/);
    }
});
