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
            export function render({ auction, userId, page = 'outcome', auctions = [auction], error = '', isLoading = false }) {
                return renderToStaticMarkup(
                    <StaticRouter location="/">
                        <UserContext.Provider value={{ currentUser: userId ? { id: userId, khubUsername: userId } : null }}>
                            <AuctionsContext.Provider value={{ auctions, isLoading, error }}>
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

test('held and administratively cancelled auctions show review outcomes without bidding or completion controls', () => {
    for (const status of ['on_hold', 'voided']) {
        const html = render({ auction: { ...auction, status, banReviewRequired: status === 'on_hold' }, userId: 'seller' });
        assert.match(html, /no winner/i);
        assert.doesNotMatch(html, /Confirm Complete|Cancel this listing|Arrange an/);
    }
    const flagged = render({ auction: { ...auction, banReviewRequired: true }, userId: 'seller' });
    assert.match(flagged, /Do not send further assets without administrator guidance/);
    assert.doesNotMatch(flagged, /Arrange an/);
    assert.match(flagged, /Confirm Complete/); // An unrestricted party can acknowledge assets already received.
    const escrow = render({ auction: { ...auction, status: 'active', escrowMode: true, biddingRestricted: true, endTime: 20000 }, userId: 'buyer' });
    assert.match(escrow, /New bids are closed/);
    assert.match(escrow, /settle the auction at its deadline/);
    assert.doesNotMatch(escrow, /Confirm Complete/);
});

test('seller and winner can confirm; outsiders and anonymous users cannot', () => {
    for (const userId of ['seller', 'buyer']) {
        const html = render({ auction, userId });
        assert.match(html, /Confirm Complete/);
        assert.match(html, /Trade instructions/);
        assert.match(html, /aria-haspopup="dialog"/);
        assert.match(html, /<strong>you have received the items or Meat owed to you\.<\/strong>/);
        assert.match(html, /<p>Only confirm once the trade is complete\. The other party will be notified of your confirmation\.<\/p>/);
        assert.doesNotMatch(html, /<dialog[^>]*\sopen(?:\s|=|>)/);
        assert.match(html, userId === 'seller' ? /send <strong>2 × Test item<\/strong> in exchange for <strong>100 Meat/ : /send <strong>100 Meat<\/strong> in exchange for <strong>2 × Test item/);
        assert.doesNotMatch(html, /Full reference|Final price:|Winning bidder:/);
    }
    for (const userId of ['outsider', null]) {
        const html = render({ auction, userId });
        assert.doesNotMatch(html, /Confirm Complete/);
    }
});

test('saved confirmation waits for the counterpart without another confirm button', () => {
    const html = render({ auction: { ...auction, sellerConfirmedAt: '2026-10-19' }, userId: 'seller' });
    assert.match(html, /Awaiting the other party’s response/);
    assert.doesNotMatch(html, /Confirm below only after you have received your side/);
    assert.doesNotMatch(html, /Confirm Complete/);
});

test('cancellation appears only for the seller of an active auction without bids', () => {
    const open = { ...auction, status: 'active', endTime: 20000, highestBidderId: null, currentBid: 0, bids: [] };
    assert.match(render({ auction: open, userId: 'seller' }), /Cancel this listing/);
    assert.doesNotMatch(render({ auction: open, userId: 'buyer' }), /Cancel this listing/);
    assert.doesNotMatch(render({ auction: { ...open, highestBidderId: 'buyer' }, userId: 'seller' }), /Cancel this listing/);
});

test('ended auctions without bids and completed trades show distinct outcomes', () => {
    const unsold = render({ auction: { ...auction, status: 'ended_no_bids' }, userId: 'seller' });
    assert.match(unsold, /ended without bids/);
    assert.doesNotMatch(unsold, /Winning bidder:/);
    const completed = render({ auction: { ...auction, status: 'completed' }, userId: 'buyer' });
    assert.match(completed, /Both parties confirmed/);
    assert.doesNotMatch(completed, /Confirm Complete/);
});

test('escrow settlement distinguishes sold lots from item returns for every viewer', () => {
    for (const userId of ['seller', 'buyer', 'outsider', null]) {
        const sold = render({ auction: { ...auction, escrowMode: true, status: 'settling' }, userId });
        assert.match(sold, /items to the winner and payment to the seller/);
        assert.match(sold, /all required deliveries/);
        for (const status of ['settling', 'active']) {
            const returning = render({ auction: { ...auction, escrowMode: true, status, currentBid: 0,
                highestBidderId: null, winnerId: null, finalPrice: null }, userId });
            assert.match(returning, /returning the deposited items to the seller/);
            assert.doesNotMatch(returning, /payment to the seller|both deliveries|Winner:/);
        }
        const unsold = render({ auction: { ...auction, escrowMode: true, status: 'ended_no_bids' }, userId });
        assert.match(unsold, /returned the items to the seller/);
        const cancelled = render({ auction: { ...auction, escrowMode: true, status: 'cancelled' }, userId });
        assert.match(cancelled, /Any accepted item deposit has been returned/);
    }
});

test('administrator contact is hidden once both parties complete the trade', () => {
    for (const userId of ['seller', 'buyer']) {
        const pending = { ...auction, finalizedAt: '2026-10-20', sellerConfirmedAt: '2026-10-20' };
        assert.match(render({ auction: pending, userId }), /Contact an Administrator/);
        for (const completion of [{ buyerConfirmedAt: '2026-10-20' }, { buyerResolvedAt: '2026-10-20', ownTradeReportWithdrawn: true }]) {
            const html = render({ auction: { ...pending, ...completion, status: 'completed' }, userId });
            assert.doesNotMatch(html, /Need to clarify something|Contact an Administrator|No positive rating was added/);
        }
    }
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


test('optional feedback appears only after the viewer responds, independently of response polarity', () => {
    for (const userId of ['seller', 'buyer']) {
        const role = userId === 'seller' ? 'buyer' : 'seller';
        assert.doesNotMatch(render({ auction, userId }), /Rate This|Thumbs up for/);
        for (const response of [{ [`${userId}ConfirmedAt`]: '2026-10-20' }, { ownTradeReport: 'B-1001' }, { [`${userId}ResolvedAt`]: '2026-10-20', ownTradeReportWithdrawn: true }]) {
            const html = render({ auction: { ...auction, ...response }, userId });
            assert.match(html, /How was your experience trading with this player\?/);
            assert.match(html, new RegExp(`aria-label="Thumbs up for this ${role}" aria-pressed="false"`));
            assert.match(html, new RegExp(`aria-label="Thumbs down for this ${role}" aria-pressed="false"`));
            assert.ok(html.indexOf('You confirmed this trade') < html.indexOf('How was your experience') || html.indexOf('You reported this trade') < html.indexOf('How was your experience'));
        }
        const completed = render({ auction: { ...auction, status: 'completed', sellerConfirmedAt: '2026-10-20', buyerConfirmedAt: '2026-10-20', ownFeedback: -1 }, userId });
        assert.doesNotMatch(completed, /Rate This|Thumbs up for|Thumbs down for/);
        assert.doesNotMatch(completed, /Rating saved/);
        assert.doesNotMatch(completed, /Contact an Administrator/);
    }
    for (const userId of ['outsider', null]) {
        assert.doesNotMatch(render({ auction: { ...auction, sellerConfirmedAt: '2026-10-20', buyerConfirmedAt: '2026-10-20', ownTradeReport: 'B-1001', ownFeedback: 1 }, userId }), /Rate This|Thumbs up for/);
    }
    assert.doesNotMatch(render({ auction: { ...auction, escrowMode: true, sellerConfirmedAt: '2026-10-20', feeMeat: 0 }, userId: 'seller' }), /Rate This/);
});


test('admin-excluded reports are neutral for participants and spectators without creating completion', () => {
    const excluded = { ...auction, finalizedAt: '2026-10-20', sellerReportedIncomplete: false, buyerReportedIncomplete: false, sellerReportExcluded: true, tradeReported: false, buyerConfirmedAt: '2026-10-20' };
    for (const userId of ['seller', 'buyer', 'outsider', null]) {
        const html = render({ auction: { ...excluded, ownTradeReport: userId === 'seller' ? 'B-1001' : null, ownTradeReportExcluded: userId === 'seller' }, userId });
        assert.match(html, /border-slate-200 bg-slate-50 text-slate-500">Report dismissed/);
        assert.match(html, /An administrator dismissed the seller’s incomplete report/);
        assert.match(html, /No incomplete mark is counted against the buyer for this report/);
        assert.doesNotMatch(html, /Reported Incomplete|Both parties confirmed|At least one party/);
        if (userId === 'seller') {
            assert.match(html, /Your incomplete report was dismissed by an administrator/);
            assert.match(html, /Mark Trade Complete/);
            assert.doesNotMatch(html, />Confirm Complete<|>Report Incomplete</);
        }
        if (userId === 'buyer') {
            assert.match(html, /The other party’s incomplete report was dismissed by an administrator/);
            assert.doesNotMatch(html, /Awaiting the other party’s response/);
        }
    }
});


test('My Account distinguishes unavailable history from a successfully loaded empty history', () => {
    const unavailable = render({ page: 'profile', userId: 'seller', auctions: [], error: 'Read failed' });
    assert.match(unavailable, /Auction history unavailable/);
    assert.match(unavailable, /Try again/);
    assert.doesNotMatch(unavailable, /0 Meat received|0 Meat spent|Nothing here yet/);
    const stale = render({ page: 'profile', userId: 'seller', auctions: [{ ...auction, status: 'completed' }], error: 'Refresh failed' });
    assert.match(stale, /Auction history unavailable/);
    assert.doesNotMatch(stale, /Meat received|Meat spent|Nothing here yet/);
    const empty = render({ page: 'profile', userId: 'seller', auctions: [] });
    assert.match(empty, /0 Meat received/);
    assert.match(empty, /Nothing here yet/);
    assert.doesNotMatch(empty, /Auction history unavailable/);
    const loading = render({ page: 'profile', userId: 'seller', auctions: [], isLoading: true });
    assert.match(loading, /Loading your auction history/);
    assert.doesNotMatch(loading, /Meat received|Nothing here yet/);
});

test('My Account auction links and winner-profile links are independent anchors', () => {
    const html = render({ page: 'profile', userId: 'seller', auctions: [{ ...auction, publicWinner: true }] });
    assert.match(html, /href="\/auction\/listing-1"/);
    assert.match(html, /href="\/seller\/buyer"/);
    let depth = 0;
    for (const [tag] of html.matchAll(/<\/?a\b[^>]*>/g)) {
        if (tag.startsWith('</')) depth--;
        else depth++;
        assert.ok(depth >= 0 && depth <= 1, `Nested or unbalanced anchor: ${tag}`);
    }
    assert.equal(depth, 0);
});

test('escrow outcomes explain automatic deposit expiry without claiming a seller cancellation or completed return', () => {
    const base = { ...auction, escrowMode: true, itemEscrowedAt: null, currentBid: 0, highestBidderId: null, winnerId: null, finalPrice: null };
    const expired = render({ auction: { ...base, status: 'expired', closureReason: 'deposit_expired' }, userId: 'seller' });
    assert.match(expired, /expired automatically/);
    assert.doesNotMatch(expired, /listing was cancelled|deposit has been returned|Confirm Complete/);
    const legacy = render({ auction: { ...base, status: 'cancelled' }, userId: 'seller' });
    assert.match(legacy, /Closed before deposit/);
    assert.match(legacy, /may have been canceled or reached its deposit deadline/);
    assert.doesNotMatch(legacy, /deposit has been returned/);
});
