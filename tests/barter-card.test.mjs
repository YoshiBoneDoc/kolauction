import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
const { outputFiles } = buildSync({
    stdin: { contents: `export {default as Card} from './src/components/CompactAuctionCard.jsx'; export {default as Pagination} from './src/components/AuctionPagination.jsx';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', define: { 'import.meta.env': '{}' },
});
const require = createRequire(import.meta.url), mod = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react' ? { ...React, useContext: () => ({ currentUser: null }), useId: () => 'card-form' }
    : name === 'react-router-dom' ? { ...require(name), useLocation: () => ({ pathname: '/barter', search: '' }) } : require(name), mod, mod.exports);
const { Card, Pagination } = mod.exports;
const now = Date.now();
const auction = { id: 'barter-id', auctionKind: 'barter', item: 'Test item', quantity: 2, status: 'active', endTime: now + 86400000, sellerId: 'seller', escrowMode: false, minBidMeat: 0, currentBid: 0 };
const html = tree => renderToStaticMarkup(React.createElement(StaticRouter, { location: '/barter' }, tree));
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)]; }
test('barter and Sell cards share dimensions, grid, typography and bid placement', () => {
    const barter = Card({ auction, now });
    const sell = Card({ auction: { ...auction, auctionKind: 'sell', minBidMeat: 100 }, now });
    assert.equal(barter.props.className, sell.props.className);
    const output = html(barter);
    assert.match(output, /h-\[134px\]/);
    assert.match(output, /barter-switch-symbol/);
    assert.match(output, /No minimum/);
    assert.match(output, /Place Bid/);
    assert.match(output, /href="\/barter\/barter-id"/);
    assert.doesNotMatch(output, /href="\/auction\//);
});
test('barter Place Bid expands navigation and Close actions, without ordinary bidding', () => {
    let toggles = 0;
    const tree = Card({ auction, now, onToggleBid: () => toggles++ });
    nodes(tree).find(n => n.type === 'button' && n.props.children === 'Place Bid').props.onClick();
    assert.equal(toggles, 1);
    const expanded = Card({ auction, now, expanded: true, onToggleBid: () => toggles++ });
    const output = html(expanded);
    assert.match(output, /Go to Auction/);
    assert.match(output, />Close<\/button>/);
    assert.doesNotMatch(output, /<form|log in/);
    nodes(expanded).find(n => n.type === 'button' && n.props.children === 'Close').props.onClick();
    assert.equal(toggles, 2);
});
test('shared pager keeps All Auctions sizing and bounded previous/next actions', () => {
    let next;
    const tree = Pagination({ page: 1, hasNext: false, onPage: value => { next = value; } });
    const buttons = nodes(tree).filter(n => n.type === 'button');
    assert.ok(buttons.every(n => n.props.disabled));
    assert.ok(buttons.every(n => n.props.className.includes('min-h-11')));
    const second = Pagination({ page: 2, totalPages: 3, hasNext: true, onPage: value => { next = value; } });
    nodes(second).find(n => n.type === 'button' && n.props.children === 'Previous').props.onClick();
    assert.equal(next, 1);
    assert.match(html(second), /Page 2 of 3/);
});
test('Meat plus Mr. A Sell cards use the same navigation actions for Direct and Escrow', () => {
    for (const escrowMode of [false, true]) {
        let closed = false;
        const mixed = { ...auction, auctionKind: 'sell', mrARate: 76000000, minBidMeat: 100, escrowMode };
        const tree = Card({ auction: mixed, now, expanded: true, onToggleBid: () => { closed = true; } });
        const output = html(tree);
        assert.match(output, /Go to Auction/);
        assert.match(output, /href="\/auction\/barter-id"/);
        assert.doesNotMatch(output, /<form|log in/);
        nodes(tree).find(n => n.type === 'button' && n.props.children === 'Close').props.onClick();
        assert.equal(closed, true);
    }
});
