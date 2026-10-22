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
    h.find(node => node.type === 'button' && node.props['aria-label'] === 'Price ▴▾').props.onClick(); h.render();
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
            const h = harness(AuctionBidForm, { auction: { ...base, currentBid: 20000000, instantPurchasePrice: 20200001 }, inline });
            h.find(node => node.type === 'input').props.onChange({ target: { value: '20000001' } }); h.render();
            await h.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); h.render();
            assert.match(h.find(node => node.props?.role === 'alert').props.children, /20,200,001 Meat/);
            h.find(node => node.type === 'input').props.onChange({ target: { value: '20200001' } }); h.render();
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

// Exercise the actual input placeholders and submit handlers, not just the
// arithmetic helper or the informational chart.
test('full and inline bid forms display rounded hybrid minimums and accept exactly that amount', async () => {
    const previousWindow = globalThis.window;
    globalThis.window = { confirm: () => true };
    user = { id: 'buyer' };
    const cases = [[999,1009], [999999,1009999], [1000000,1030000], [1000001,1040001],
        [1750000,1810000], [7500000,7730000], [9999999,10299999], [10000000,10200000],
        [10000001,10300001], [15000000,15300000], [99999999,101999999],
        [100000000,101000000], [100000001,101500001], [350000000,353500000],
        [9999999999,10099999999], [10000000000,10050000000], [10000000001,10050500001],
        [15000000000,15075000000], [8000000000000000,8040000000000000]];
    try {
        for (const inline of [false, true]) for (const [currentBid, expected] of cases) {
            const bids = [];
            trading = { placeBid: async (...args) => bids.push(args) };
            const auction = { ...base, currentBid, instantPurchasePrice: null, escrowMode: false };
            const h = harness(AuctionBidForm, { auction, inline });
            const text = expected.toLocaleString('en-US');
            const input = () => h.find(node => node.type === 'input');
            assert.equal(input().props.placeholder, inline ? `Min: ${text} · k/m/b` : text);
            input().props.onChange({ target: { value: String(expected - 1) } }); h.render();
            await h.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); h.render();
            assert.equal(bids.length, 0);
            assert.equal(h.find(node => node.props?.role === 'alert').props.children, `Enter a bid of at least ${text} Meat.`);
            input().props.onChange({ target: { value: String(expected) } }); h.render();
            await h.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
            assert.deepEqual(bids, [[base.id, expected]], `${inline ? 'inline' : 'full'} at ${currentBid}`);
        }
    } finally { globalThis.window = previousWindow; trading = {}; }
});

test('open Direct and Escrow card controls refresh their rounded minimum when live bids cross brackets', () => {
    user = { id: 'buyer' };
    for (const escrowMode of [false, true]) {
        const props = currentBid => ({ auction: { ...base, escrowMode, currentBid, instantPurchasePrice: null }, inline: true });
        const h = harness(AuctionBidForm, props(9999999));
        for (const [currentBid, minimum] of [[9999999,'10,299,999'],[10000000,'10,200,000'],[10000001,'10,300,001'],[15000000000,'15,075,000,000']]) {
            h.render(props(currentBid));
            if (escrowMode) assert.ok(h.find(node => node.type === 'label').props.title.includes(`Attach at least ${minimum} Meat`));
            else assert.equal(h.find(node => node.type === 'input').props.placeholder, `Min: ${minimum} · k/m/b`);
        }
    }
});

test('ownership button cycles mine, others and all, preserves other filters, resets pagination, and hides for guests', () => {
    const previousUser = user;
    const previousOwner = listings[1].sellerId;
    try {
        user = { id: 'seller' }; listings[1].sellerId = 'another-seller';
        params = new URLSearchParams('q=Item&status=active&sort=price-desc&page=3');
        const h = harness(AllAuctions);
        const button = () => h.find(node => node.type === 'button' && ['My Auctions','Others','View All'].includes(node.props.children));
        assert.equal(button().props['aria-pressed'], false);
        const fixedSize=()=>{assert.match(button().props.className,/h-9 w-32 shrink-0/);};fixedSize();
        button().props.onClick(); h.render();
        fixedSize();assert.equal(params.get('mine'), '1'); assert.equal(params.has('page'), false);
        assert.equal(params.get('q'), 'Item'); assert.equal(params.get('status'), 'active'); assert.equal(params.get('sort'), 'price-desc');
        assert.equal(button().props['aria-pressed'], true);
        assert.deepEqual(nodes(h.tree).filter(node => node.type === CompactAuctionCard).map(node => node.props.auction.id), ['first']);
        button().props.onClick(); h.render();
        fixedSize();assert.equal(params.get('mine'), 'others');
        assert.equal(button().props.children,'View All');
        assert.deepEqual(nodes(h.tree).filter(node => node.type === CompactAuctionCard).map(node => node.props.auction.id),['second']);
        button().props.onClick(); h.render();
        assert.equal(params.has('mine'), false);
        fixedSize();assert.equal(button().props.children,'My Auctions');
        assert.equal(nodes(h.tree).filter(node => node.type === CompactAuctionCard).length, 2);
        user = null; h.render();
        assert.equal(nodes(h.tree).some(node => node.type === 'button' && node.props.children === 'My Auctions'), false);
    } finally { user = previousUser; listings[1].sellerId = previousOwner; params = new URLSearchParams(); }
});


test('browse toolbar keeps one sort active, toggles directions, combines methods and resets pagination', () => {
    params = new URLSearchParams('q=fixture&status=all&page=3&mine=1');
    const h = harness(AllAuctions);
    const click = label => { h.find(node => node.type === 'button' && (node.props['aria-label'] || node.props.children) === label).props.onClick(); h.render(); };
    click('Most Bids ▴▾');
    assert.equal(params.get('sort'), 'bids-desc');
    assert.equal(params.has('page'), false);
    click('Most Bids ▾'); assert.equal(params.get('sort'), 'bids-asc');
    click('Price ▴▾'); assert.equal(params.get('sort'), 'price-desc');
    click('Price ▾'); assert.equal(params.get('sort'), 'price-asc');
    assert.equal(nodes(h.tree).filter(n => n.type === 'button' && n.props['aria-pressed'] === true && !['My Auctions','Others','View All','Escrow','Direct'].includes(n.props.children)).length, 1);
    const methods = () => nodes(h.tree).filter(n => n.type === 'button' && ['Escrow', 'Direct'].includes(n.props.children));
    methods()[1].props.onClick(); h.render(); assert.equal(params.get('trade'), 'escrow');
    methods()[0].props.onClick(); h.render(); assert.equal(params.get('trade'), 'none');
    methods()[1].props.onClick(); h.render(); assert.equal(params.get('trade'), 'direct');
    methods()[0].props.onClick(); h.render(); assert.equal(params.has('trade'), false);
    assert.equal(params.get('q'), 'fixture'); assert.equal(params.get('status'), 'all'); assert.equal(params.get('mine'), '1');
    click('Reset filters'); assert.equal(params.toString(), '');
});
