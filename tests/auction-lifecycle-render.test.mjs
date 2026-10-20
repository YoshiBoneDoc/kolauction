import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as router from 'react-router-dom';
import { fileURLToPath } from 'node:url';

// Render the real components with fixture contexts; no browser or Supabase calls.
const { outputFiles } = buildSync({
    stdin: {
        contents: `
            import React from 'react';
            import { renderToStaticMarkup } from 'react-dom/server';
            import { StaticRouter } from 'react-router-dom';
            import AuctionOutcome from './src/components/AuctionOutcome.jsx';
            import Profile from './src/pages/Profile.jsx';
            import { AuctionsContext } from './src/context/AuctionsContext.jsx';
            import { UserContext } from './src/context/UserContext.jsx';
            export function render({ auction, userId, page = 'outcome', auctions = [auction] }) {
                return renderToStaticMarkup(
                    <StaticRouter location="/">
                        <UserContext.Provider value={{ currentUser: userId ? { id: userId, khubUsername: userId } : null }}>
                            <AuctionsContext.Provider value={{ auctions, isLoading: false }}>
                                {page === 'profile' ? <Profile /> : <AuctionOutcome auction={auction} now={10000} />}
                            </AuctionsContext.Provider>
                        </UserContext.Provider>
                    </StaticRouter>
                );
            }
        `,
        resolveDir: fileURLToPath(new URL('../', import.meta.url)),
        loader: 'jsx',
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic',
});
const compiled = { exports: {} };
const requireModule = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)((name) => name === 'react-router-dom' ? router : requireModule(name), compiled, compiled.exports);
const { render } = compiled.exports;
const auction = {
    id: 'listing-1', sellerId: 'seller', owner: 'Seller', item: 'Test item', quantity: 2,
    minBidMeat: 10, currentBid: 100, highestBidderId: 'buyer', highestBidder: 'Buyer',
    status: 'awaiting_trade', endTime: 9000, winnerId: 'buyer', winner: 'Buyer', finalPrice: 100,
    bids: [{ bidderId: 'buyer', amount: 100 }],
};

test('seller and winner can confirm; outsiders and anonymous users cannot', () => {
    for (const userId of ['seller', 'buyer']) {
        const html = render({ auction, userId });
        assert.match(html, /Confirm my trade is complete/);
        assert.match(html, /listing-1/);
        assert.match(html, /Final price:/);
    }
    for (const userId of ['outsider', null]) {
        const html = render({ auction, userId });
        assert.doesNotMatch(html, /Confirm my trade is complete/);
    }
});

test('saved confirmation waits for the counterpart without another confirm button', () => {
    const html = render({ auction: { ...auction, sellerConfirmedAt: '2026-10-19' }, userId: 'seller' });
    assert.match(html, /Waiting for the other party/);
    assert.doesNotMatch(html, /Confirm my trade is complete/);
});

test('cancellation appears only for the seller of an active auction without bids', () => {
    const open = { ...auction, status: 'active', endTime: 20000, highestBidderId: null, currentBid: 0, bids: [] };
    assert.match(render({ auction: open, userId: 'seller' }), /Cancel listing/);
    assert.doesNotMatch(render({ auction: open, userId: 'buyer' }), /Cancel listing/);
    assert.doesNotMatch(render({ auction: { ...open, highestBidderId: 'buyer' }, userId: 'seller' }), /Cancel listing/);
});

test('ended auctions without bids and completed trades show distinct outcomes', () => {
    const unsold = render({ auction: { ...auction, status: 'ended_no_bids' }, userId: 'seller' });
    assert.match(unsold, /ended without bids/);
    assert.doesNotMatch(unsold, /Winning bidder:/);
    const completed = render({ auction: { ...auction, status: 'completed' }, userId: 'buyer' });
    assert.match(completed, /Both parties confirmed/);
    assert.doesNotMatch(completed, /Confirm my trade is complete/);
});

test('profile earnings exclude winning bids that are still awaiting trade', () => {
    const html = render({ page: 'profile', userId: 'seller', auctions: [
        auction,
        { ...auction, id: 'complete', status: 'completed', finalPrice: 250 },
        { ...auction, id: 'cancel', status: 'cancelled', finalPrice: null },
    ] });
    assert.match(html, /250 Meat received/);
    assert.doesNotMatch(html, /350 Meat received/);
    assert.match(html, /Awaiting settlement/);
});
