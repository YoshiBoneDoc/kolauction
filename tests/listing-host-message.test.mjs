import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { createAuctionService, mapAuction } from '../src/lib/auctions.js';

const { outputFiles } = buildSync({ stdin: { contents: `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import HostMessage from './src/components/HostMessage.jsx';
import AuctionDetails from './src/pages/AuctionDetails.jsx';
import { Routes, Route } from 'react-router-dom';
import { AuctionsContext } from './src/context/AuctionsContext.jsx';
import { UserContext } from './src/context/UserContext.jsx';
export const message = value => renderToStaticMarkup(<HostMessage message={value} />);
export const detail = value => renderToStaticMarkup(<StaticRouter location="/auction/test"><UserContext.Provider value={{currentUser: null}}><AuctionsContext.Provider value={{auctions: [value]}}><Routes><Route path="/auction/:id" element={<AuctionDetails />} /></Routes></AuctionsContext.Provider></UserContext.Provider></StaticRouter>);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', define: { 'import.meta.env': '{}' }, loader: { '.css': 'empty', '.svg': 'dataurl', '.gif': 'dataurl' } });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);

test('blank messages disappear and host markup is rendered as plain text', () => {
    for (const empty of [undefined, null, '', '   \n']) assert.equal(compiled.exports.message(empty), '');
    const html = compiled.exports.message('<script>alert(1)</script>\nTrade note');
    assert.match(html, /Host Message/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});

test('a message uses atomic publication for every ordinary listing kind, without changing blank-message RPCs', async () => {
    const calls = [];
    const service = createAuctionService({ rpc: async (name, args) => { calls.push({ name, args }); return { data: 'id' }; } });
    const base = { item: 'asbestos ore', itemId: 364, quantity: 1, minBidMeat: 100, auctionTime: '24', escrowMode: false };
    for (const variant of [{}, { auctionKind: 'buy', deliveryMode: 'immediate' }, { bundleItems: [{id: 364, quantity: 1}] }, { giveawayTitle: 'Giveaway' }, { mrARate: 75000000 }, { autoRelist: true, relistCount: 3, relistReduction: 5 }]) {
        const listing = { ...base, ...variant, hostMessage: 'Trade note' };
        assert.equal(await service.create(listing), 'id');
        assert.deepEqual(calls.at(-1), { name: 'create_listing_with_message', args: { p_listing: listing } });
    }
    await service.create({ ...base, hostMessage: '  ' });
    assert.equal(calls.at(-1).name, 'create_auction');
});

test('detail keeps payment text above resources, groups buyout with bid, and conditionally displays host message', () => {
    const auction = { id: 'test', item: 'Mr. Container', itemId: 1, quantity: 1, minBidMeat: 5000000000, currentBid: 0, bids: [], status: 'active', endTime: Date.now() + 86400000, sellerId: 'seller', owner: 'Host', mrARate: 75000000, instantPurchasePrice: 6000000000, escrowMode: false };
    const html = compiled.exports.detail({ ...auction, hostMessage: 'Number one collection' });
    assert.ok(html.indexOf('Accepts Mr.') < html.indexOf('>wiki<'));
    assert.match(html, /listing-price-panel/);
    assert.match(html, /listing-buyout/);
    assert.match(html, /Number one collection/);
    assert.doesNotMatch(compiled.exports.detail(auction), /Host Message/);
    assert.equal(mapAuction({ host_message: 'Trade note' }, []).hostMessage, 'Trade note');
});
