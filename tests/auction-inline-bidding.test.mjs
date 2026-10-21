import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import * as router from 'react-router-dom';

const { outputFiles } = buildSync({ stdin: { contents: `
    export { default as AllAuctions } from './src/pages/AllAuctions.jsx';
    export { default as CompactAuctionCard } from './src/components/CompactAuctionCard.jsx';
    export { default as AuctionBidForm } from './src/components/AuctionBidForm.jsx';
    export { default as CopyMessage } from './src/components/CopyMessage.jsx';
    export { default as InstantPurchaseAction } from './src/components/InstantPurchaseAction.jsx';
    export { AuctionsContext } from './src/context/AuctionsContext.jsx';
    export { UserContext } from './src/context/UserContext.jsx';
`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx' }, bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', define: { 'import.meta.env': '{}' }, loader: { '.gif': 'dataurl' },
});
let active;
let user = { id: 'buyer' };
let trading = {};
let params = new URLSearchParams();
function slot(initial) {
    const owner = active; const index = owner.cursor++;
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [owner.slots[index], value => { owner.slots[index] = typeof value === 'function' ? value(owner.slots[index]) : value; }];
}
const compiled = { exports: {} };
const require = createRequire(import.meta.url);
const base = { id: 'first', item: 'Item', quantity: 3, currentBid: 200, minBidMeat: 100, instantPurchasePrice: 500,
    status: 'active', endTime: Date.now() + 600000, sellerId: 'seller' };
const listings = [base, { ...base, id: 'second', item: 'Other item' }];
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react' ? {
    ...React, useState: slot, useRef: value => slot({ current: value })[0], useId: () => 'inline-bid-test',
    useMemo: fn => fn(), useEffect: () => {},
    useContext: context => context === compiled.exports.UserContext ? { currentUser: user } : { auctions: listings, isLoading: false, ...trading },
} : name === 'react-router-dom' ? {
    ...router, useLocation: () => ({ pathname: '/auctions', search: params.toString() }),
    useSearchParams: () => [params, next => { params = typeof next === 'function' ? next(params) : new URLSearchParams(next); }],
} : require(name), compiled, compiled.exports);
const { AllAuctions, CompactAuctionCard, AuctionBidForm, InstantPurchaseAction, CopyMessage } = compiled.exports;
function nodes(tree) {
    if (!tree || typeof tree !== 'object') return [];
    return [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)];
}
function harness(Component, props = {}) {
    const h = { slots: [], cursor: 0, props,
        render(next = h.props) { h.props = next; h.cursor = 0; active = h; h.tree = Component(next); return h; },
        find(predicate) { const node = nodes(h.tree).find(predicate); assert.ok(node); return node; },
    };
    return h.render();
}

test('All Auctions keeps exactly one inline form open and lets the user close or switch it', () => {
    params = new URLSearchParams();
    const h = harness(AllAuctions);
    const cards = () => nodes(h.tree).filter(node => node.type === CompactAuctionCard);
    assert.equal(cards().filter(card => card.props.expanded).length, 0);
    cards()[0].props.onToggleBid(); h.render();
    assert.equal(cards()[0].props.expanded, true);
    assert.equal(cards()[1].props.expanded, false);
    cards()[1].props.onToggleBid(); h.render();
    assert.equal(cards()[0].props.expanded, false);
    assert.equal(cards()[1].props.expanded, true);
    cards()[1].props.onToggleBid(); h.render();
    assert.equal(cards().filter(card => card.props.expanded).length, 0);
    cards()[0].props.onToggleBid(); h.render();
    h.find(node => node.props?.id === 'auction-sort').props.onChange({ target: { value: 'price-desc' } }); h.render();
    assert.equal(cards().filter(card => card.props.expanded).length, 0);
});

test('inline cards preserve shared bid/buyout forms for both trade modes, and close without a dialog', () => {
    user = { id: 'buyer' };
    for (const escrowMode of [false, true]) {
        const auction = { ...base, escrowMode };
        let expanded = false;
        const toggle = () => { expanded = !expanded; };
        const props = () => ({ auction, now: Date.now(), expanded, onToggleBid: toggle });
        const h = harness(CompactAuctionCard, props());
        assert.equal(nodes(h.tree).some(node => node.type === AuctionBidForm), false);
        h.find(node => node.props?.['aria-expanded'] === false).props.onClick(); h.render(props());
        assert.equal(h.find(node => node.type === AuctionBidForm).props.auction, auction);
        assert.equal(h.find(node => node.type === AuctionBidForm).props.inline, true);
        assert.equal(nodes(h.tree).some(node => node.type === 'dialog'), false);
        h.find(node => node.type === AuctionBidForm).props.onClose();
        h.render(props());
        assert.equal(nodes(h.tree).some(node => node.type === AuctionBidForm), false);
    }
});

test('live updates reach an open form and expiry or ineligible accounts remove its actions', () => {
    user = { id: 'buyer' };
    const h = harness(CompactAuctionCard, { auction: base, now: Date.now(), expanded: true });
    h.render({ ...h.props, auction: { ...base, currentBid: 300 } });
    assert.equal(h.find(node => node.type === AuctionBidForm).props.auction.currentBid, 300);
    h.render({ ...h.props, now: base.endTime + 1 });
    assert.equal(nodes(h.tree).some(node => node.type === AuctionBidForm || node.type === InstantPurchaseAction), false);
    for (const viewer of [{ id: 'seller' }, { id: 'buyer', isBanned: true }]) {
        user = viewer;
        h.render({ auction: base, now: Date.now(), expanded: true });
        assert.equal(nodes(h.tree).some(node => node.type === AuctionBidForm || node.type === InstantPurchaseAction), false);
    }
    user = { id: 'buyer' };
});


test('quick bid input tracks the live minimum and keeps bid, buyout, and close actions separate', async () => {
    const originalWindow = globalThis.window;
    const bids = []; const purchases = []; const prompts = [];
    globalThis.window = { confirm: text => { prompts.push(text); return true; } };
    trading = { placeBid: async (...args) => bids.push(args), purchaseAuction: async id => purchases.push(id) };
    user = { id: 'buyer' };
    let closed = false;
    try {
        const h = harness(AuctionBidForm, { auction: base, inline: true, onClose: () => { closed = true; } });
        const input = () => h.find(node => node.type === 'input');
        const event = { preventDefault() {} };
        assert.equal(input().props.placeholder, 'Min: 210 · k/m/b');
        h.render({ ...h.props, auction: { ...base, currentBid: 300 } });
        assert.equal(input().props.placeholder, 'Min: 310 · k/m/b');
        input().props.onChange({ target: { value: '300' } }); h.render();
        await h.find(node => node.type === 'form').props.onSubmit(event); h.render();
        assert.equal(bids.length, 0);
        assert.match(h.find(node => node.props?.role === 'alert').props.children, /310 Meat/);
        input().props.onChange({ target: { value: '310' } }); h.render();
        await h.find(node => node.type === 'form').props.onSubmit(event); h.render();
        assert.deepEqual(bids, [[base.id, 310]]);
        await h.find(node => node.type === 'button' && node.props.children === 'Buy Now').props.onClick(event); h.render();
        assert.deepEqual(purchases, [base.id]);
        assert.match(prompts.at(-1), /500 Meat/);
        assert.equal(bids.length, 1);
        h.find(node => node.props?.['aria-label'] === 'Close Bid Form').props.onClick();
        assert.equal(closed, true);
    } finally {
        globalThis.window = originalWindow;
        trading = {};
    }
});


test('typed buyouts remain valid below the normal increment in both full and inline forms', async () => {
    const previousWindow = globalThis.window;
    const purchases = [], bids = [];
    globalThis.window = { confirm: () => true };
    trading = { placeBid: async (...args) => bids.push(args), purchaseAuction: async id => purchases.push(id) };
    user = { id: 'buyer' };
    try {
        for (const inline of [false, true]) {
            const h = harness(AuctionBidForm, { auction: { ...base, currentBid: 20000000, instantPurchasePrice: 20500000 }, inline });
            h.find(node => node.type === 'input').props.onChange({ target: { value: '20000001' } }); h.render();
            await h.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); h.render();
            assert.match(h.find(node => node.props?.role === 'alert').props.children, /20,500,000 Meat/);
            h.find(node => node.type === 'input').props.onChange({ target: { value: '20.5m' } }); h.render();
            await h.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
        }
        assert.deepEqual(bids, []);
        assert.deepEqual(purchases, [base.id, base.id]);
    } finally { globalThis.window = previousWindow; trading = {}; }
});

test('highest bidders get a disabled inline status field and can close it in either trade mode', () => {
    user = { id: 'buyer' };
    for (const escrowMode of [false, true]) {
        const auction = { ...base, escrowMode, highestBidderId: 'buyer' };
        let closed = false;
        const card = harness(CompactAuctionCard, { auction, now: Date.now(), expanded: true });
        const formProps = card.find(node => node.type === AuctionBidForm).props;
        assert.equal(formProps.inline, true);
        const form = harness(AuctionBidForm, { ...formProps, onClose: () => { closed = true; } });
        const input = form.find(node => node.type === 'input');
        assert.equal(input.props.disabled, true);
        assert.equal(input.props.value, 'You are the highest bidder');
        assert.equal(nodes(form.tree).filter(node => node.type === 'button').length, 1);
        form.find(node => node.props?.['aria-label'] === 'Close Bid Form').props.onClick();
        assert.equal(closed, true);
        assert.equal(nodes(form.tree).some(node => node.type === 'form'), false);
    }
});


test('escrow cards expose an exact copyable BID command and a compact Close action', () => {
    user = { id: 'buyer' };
    for (const auctionNumber of [1011, null]) {
        let closed = false;
        const auction = { ...base, escrowMode: true, auctionNumber };
        const h = harness(AuctionBidForm, { auction, inline: true, onClose: () => { closed = true; } });
        const command = h.find(node => node.type === CopyMessage);
        assert.equal(command.props.text, `BID ${auctionNumber || base.id}`);
        assert.equal(command.props.inline, true);
        assert.equal(command.props.recipient, 'kHub (#3888760)');
        assert.equal(h.find(node => node.type === 'label').props.children, 'KMail with attached bid meat.');
        assert.equal(h.find(node => node.type === 'label').props.htmlFor, command.props.inputId);
        assert.match(h.find(node => node.type === 'label').props.title, /at least 210 Meat/);
        assert.equal(nodes(h.tree).some(node => node.type === 'form'), false);
        h.find(node => node.props?.['aria-label'] === 'Close Bid Form').props.onClick();
        assert.equal(closed, true);
    }
});


test('logged-out bid clicks reveal a non-modal register/login warning and an independent Close button', () => {
    user = null;
    try {
        for (const escrowMode of [false, true]) {
            const auction = { ...base, escrowMode };
            let expanded = false;
            const props = () => ({ auction, now: Date.now(), expanded, onToggleBid: () => { expanded = !expanded; } });
            const h = harness(CompactAuctionCard, props());
            assert.equal(nodes(h.tree).some(node => node.props?.role === 'alert'), false);
            h.find(node => node.type === 'button' && node.props.children === 'Place Bid').props.onClick(); h.render(props());
            assert.ok(h.find(node => node.props?.role === 'alert'));
            assert.ok(h.find(node => node.props?.to === '/register'));
            assert.ok(h.find(node => node.props?.to === '/login'));
            assert.equal(nodes(h.tree).some(node => node.type === AuctionBidForm || node.type === InstantPurchaseAction || node.type === 'dialog'), false);
            h.find(node => node.type === 'button' && node.props.children === 'Close').props.onClick(); h.render(props());
            assert.equal(nodes(h.tree).some(node => node.props?.role === 'alert'), false);
            assert.ok(h.find(node => node.type === 'button' && node.props.children === 'Place Bid'));
        }
    } finally {
        user = { id: 'buyer' };
    }
});
