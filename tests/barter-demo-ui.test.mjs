import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as React from 'react';
import { createBarterDemo, demoItems, demoPrices } from '../src/lib/barterDemo.js';

const require = createRequire(import.meta.url);
const { outputFiles } = buildSync({ stdin: { contents: `export {default as Form} from './src/components/BarterOfferForm.jsx'; export {default as Review} from './src/components/BarterOfferReview.jsx';`, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    external: ['../lib/supabase', '../lib/itemCatalog', '../lib/marketPriceService', '../lib/barter', '../hooks/useAdministrator', './MarketPrice'],
});
let slots, cursor, effects, writes, reads;
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(name => {
    if (name === 'react') return { ...React,
        useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
        useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
        useEffect(fn) { effects.push(fn); },
    };
    if (name === '../lib/supabase') return { supabase: null };
    if (name === '../hooks/useAdministrator') return () => false;
    if (name === './MarketPrice') return () => { throw Error('Demo must not mount live market prices'); };
    if (name === '../lib/itemCatalog') return { createItemCatalogService: () => ({ async load() { reads++; return []; } }), isAuctionableItem: row => row.tradeable, itemImageUrl: image => image };
    if (name === '../lib/marketPriceService') return { marketPrices: { async load() { reads++; return new Map(); } } };
    if (name === '../lib/barter') return {
        async writeBarter(...args) { writes.push(args); },
        offerDescription: offer => `${offer.meat} Meat`,
        offerValue(meat, items, prices) { return items.reduce((value, row) => value + (prices.get(row.id)?.price_meat || 0) * row.quantity, meat); },
    };
    return require(name);
}, compiled, compiled.exports);
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)]; }
function setup(component, props) {
    slots = []; writes = []; reads = 0;
    return () => { cursor = 0; effects = []; const tree = nodes(component(props)); effects.forEach(fn => fn()); return tree; };
}

test('practice form edits and submits using local data without catalog, market, confirmation or write RPCs', async () => {
    const submitted = [];
    const props = { auction: { id: 'demo-only', minimumValue: null }, initialOffer: createBarterDemo('bidder').offers[1], onSubmitted: success => submitted.push(success),
        practice: { items: demoItems, prices: demoPrices(), onSubmit: offer => submitted.push(offer) } };
    const render = setup(compiled.exports.Form, props);
    const savedConfirm = globalThis.confirm;
    globalThis.confirm = () => { throw Error('Practice submission must not request a live-trade confirmation'); };
    try {
        let tree = render();
        tree.find(n => n.type === 'input' && n.props.placeholder === 'e.g. 1m').props.onChange({ target: { value: '10m' } });
        tree = render();
        assert.ok(tree.some(n => n.props.children === 'Submit practice offer'));
        assert.ok(!tree.some(n => n.type?.name === 'MarketPrice'));
        await tree.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
        assert.equal(submitted[0].meat, 10_000_000);
        assert.equal(submitted[0].items.length, 5);
        assert.equal(submitted[0].value, 67_000_000);
        assert.equal(submitted[1], true);
        assert.equal(reads, 0);
        assert.deepEqual(writes, []);
    } finally { globalThis.confirm = savedConfirm; }
});

test('practice host review accepts locally and preserves marked-item/raise feedback without live writes', async () => {
    const decisions = [];
    const offer = createBarterDemo('host').offers[1];
    const props = { offer, host: true, active: true, onUpdated() {}, onDecision: value => decisions.push(value) };
    const render = setup(compiled.exports.Review, props);
    let tree = render();
    await tree.find(n => n.type === 'button' && n.props.children === 'Accept').props.onClick();
    assert.equal(decisions[0].decision, 'accepted');
    tree = render();
    tree.find(n => n.type === 'button' && n.props.children === 'Request Changes').props.onClick();
    tree = render();
    tree.find(n => n.type === 'button' && n.props['aria-label'] === 'Do not accept 11-leaf clover').props.onClick();
    tree.find(n => n.type === 'button' && n.props.className.includes('barter-raise-option')).props.onClick();
    tree = render();
    await tree.find(n => n.type === 'button' && n.props.children === 'Send requested changes').props.onClick();
    assert.deepEqual(decisions[1].rejectedItems, [10881]);
    assert.equal(decisions[1].raiseRequested, true);
    assert.equal(reads, 0);
    assert.deepEqual(writes, []);
});

test('normal offer form still confirms and invokes its real RPC adapter when no practice configuration is supplied', async () => {
    const render = setup(compiled.exports.Form, { auction: { id: 'real-auction', minimumValue: null }, onSubmitted() {} });
    const savedConfirm = globalThis.confirm;
    let confirmed = 0;
    globalThis.confirm = () => { confirmed++; return true; };
    try {
        let tree = render();
        tree.find(n => n.type === 'input' && n.props.placeholder === 'e.g. 1m').props.onChange({ target: { value: '1m' } });
        tree = render();
        await tree.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
        assert.equal(confirmed, 1);
        assert.equal(writes.length, 1);
        assert.equal(writes[0][0], 'submit_barter_offer');
        assert.equal(writes[0][1].p_auction, 'real-auction');
        assert.ok(reads > 0);
    } finally { globalThis.confirm = savedConfirm; }
});

test('normal host acceptance still requires confirmation and keeps the server review adapter', async () => {
    const render = setup(compiled.exports.Review, { offer: createBarterDemo('host').offers[1], host: true, active: true, onUpdated() {} });
    const savedConfirm = globalThis.confirm;
    try {
        globalThis.confirm = () => false;
        await render().find(n => n.type === 'button' && n.props.children === 'Accept').props.onClick();
        assert.deepEqual(writes, []);
        globalThis.confirm = () => true;
        await render().find(n => n.type === 'button' && n.props.children === 'Accept').props.onClick();
        assert.equal(writes.length, 1);
        assert.equal(writes[0][0], 'review_barter_offer_changes');
        assert.equal(writes[0][1].p_decision, 'accepted');
    } finally { globalThis.confirm = savedConfirm; }
});
